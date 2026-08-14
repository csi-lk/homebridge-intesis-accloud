import type { Logger } from 'homebridge';
import { CookieJar } from './cookiejar.js';

export interface DeviceService {
  service_id: number;
  value: number | null;
}

export interface DeviceServices {
  user_id?: string;
  power?: DeviceService;
  userMode?: DeviceService;
  fanSpeed?: DeviceService;
  currentTemp?: {
    units?: string | null;
    raw_value?: string | null;
    value: number;
    defaulted?: number | null;
  };
  setpointTemp?: DeviceService & { raw_value?: string };
  swingMode?: DeviceService;
}

export interface Device {
  device_id: string;
  name: string;
  user_id?: string | null;
  services: DeviceServices | null;
}

export type SetResultReason =
  | 'ok'
  | 'session-expired'
  | 'http-error'
  | 'invalid-response'
  | 'login-failed';

export interface SetResult {
  ok: boolean;
  reason: SetResultReason;
}

/**
 * Minimal response shape we rely on from fetch(). Declared so the tests can
 * inject a lightweight fake without pulling in undici types.
 */
export interface HttpResult {
  status: number;
  body: string;
  contentType: string | null;
  setCookie: string | null;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Client for the Intesis cloud web interface (accloud.intesis.com).
 *
 * Responsibilities:
 *  - login and session maintenance via cookie jar
 *  - enumerate devices (panel/headers) and parse state (panel/vista)
 *  - send setVal commands with proper response validation.
 *
 * Critical behaviour: an expired session makes the web app return the login
 * page with HTTP 200 instead of the expected "OK" body. Every setVal/read is
 * validated for that, forcing a re-login and retry so commands are never
 * silently dropped.
 */
export class IntesisCloudClient {
  private readonly cookieJar: CookieJar = new CookieJar();
  private loggedIn = false;
  private loginInProgress: Promise<boolean> | null = null;
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly log: Logger,
    private readonly username: string,
    private readonly password: string,
    baseUrl?: string,
    fetchFn?: FetchFn,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.baseUrl = baseUrl || 'https://accloud.intesis.com/';
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  private readonly baseUrl: string;

  private url(path: string): string {
    return new URL(path.replace(/^\//, ''), this.baseUrl).toString();
  }

  /**
   * Perform an HTTP request with our cookie jar applied. Returns a normalised
   * result so tests can drive every branch without a real network.
   */
  private async request(path: string, init?: RequestInit): Promise<HttpResult> {
    const headers = new Headers(init?.headers);
    const cookieHeader = this.cookieJar.getCookieHeader();
    if (cookieHeader) {
      headers.set('cookie', cookieHeader);
    }

    const response = await this.fetchFn(this.url(path), {
      ...init,
      headers,
      redirect: 'manual',
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      this.cookieJar.setFromResponse([setCookie]);
    }

    const body = await response.text();
    const contentType = response.headers.get('content-type');

    return { status: response.status, body, contentType, setCookie };
  }

  private isLoginPage(res: HttpResult): boolean {
    return (res.contentType?.includes('text/html') ?? false)
      && /<title>/i.test(res.body)
      && (/\bsign\s*in\b|\bsignin\b/i.test(res.body));
  }

  /**
   * Ensure we have a valid session. Returns true when logged in.
   */
  public async ensureLogin(): Promise<boolean> {
    if (this.loggedIn) {
      return true;
    }
    if (this.loginInProgress) {
      return this.loginInProgress;
    }
    this.loginInProgress = this.doLogin();
    try {
      return await this.loginInProgress;
    } finally {
      this.loginInProgress = null;
    }
  }

  private async doLogin(): Promise<boolean> {
    this.log.debug('Logging in...');
    try {
      let res = await this.request('login');
      if (this.isLoginPage(res)) {
        const csrf = res.body.match(/signin\[_csrf_token\]" value="([^"]+)"/);
        if (!csrf) {
          this.log.error('Login page did not contain a CSRF token.');
          this.loggedIn = false;
          return false;
        }
        const form = new URLSearchParams();
        form.set('signin[username]', this.username);
        form.set('signin[password]', this.password);
        form.set('signin[_csrf_token]', csrf[1]);

        res = await this.request('login', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
      }

      // A successful login is a 302/303 redirect to the dashboard, or a page
      // showing the authenticated main menu (when the session is still valid).
      if (res.status === 302 || res.status === 303 || res.body.includes('project-main-menu')) {
        this.loggedIn = true;
        this.log.debug('Login successful.');
        return true;
      }

      this.log.error('Login failed: unexpected response (status=%s).', res.status);
      this.loggedIn = false;
      return false;
    } catch (e) {
      this.log.error('Login error: %s', (e as Error).message);
      this.loggedIn = false;
      return false;
    }
  }

  private async fetchWithLogin(path: string, init?: RequestInit): Promise<HttpResult | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.ensureLogin()) {
        return null;
      }
      const res = await this.request(path, init);
      if (!this.isLoginPage(res)) {
        return res;
      }
      this.log.warn('Session expired; re-logging in and retrying %s (attempt %d).', path, attempt + 2);
      this.loggedIn = false;
    }
    return null;
  }

  /**
   * Fetch the device list (id + friendly name) from panel/headers.
   */
  public async getDevices(): Promise<Array<{ device_id: string; name: string }>> {
    const res = await this.fetchWithLogin('panel/headers');
    if (!res) {
      return [];
    }
    const re = /<div id="deviceHeader_(\d+)"[^]*?<div class="name left">(.*?)<\/div>/g;
    const devices: Array<{ device_id: string; name: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(res.body)) !== null) {
      devices.push({ device_id: m[1], name: m[2].trim() });
    }
    return devices;
  }

  /**
   * Fetch and parse full state for a single device.
   */
  public async getDeviceState(deviceId: string): Promise<DeviceServices | null> {
    const res = await this.fetchWithLogin(`panel/vista?id=${deviceId}`);
    if (!res || this.isLoginPage(res)) {
      return null;
    }
    return this.parseVista(res.body);
  }

  private parseVista(body: string): DeviceServices | null {
    const safeMatch = (pattern: RegExp, field: string): RegExpMatchArray | null => {
      const match = body.match(pattern);
      if (!match) {
        this.log.error(`PARSE ERROR: failed to match pattern for '${field}'`);
        return null;
      }
      return match;
    };

    const userIdMatch = safeMatch(/\&userId=(\d+)/, 'userId');
    if (!userIdMatch) {
      return null;
    }
    const user_id = userIdMatch[1];

    const powerMatch = safeMatch(/var selectedOnOff = (\d);/, 'power');
    const userModeMatch = safeMatch(/var selectedUsermode = (\d);/, 'userMode');
    const fanSpeedMatch = safeMatch(/var selectedfanspeed = (\d);/, 'fanSpeed');
    const setpointMatch = safeMatch(/setTempCelsiusConsignaHeader\(\d+, '(\d+.\d+)'\);/, 'setpointTemp');
    if (!powerMatch || !userModeMatch || !fanSpeedMatch || !setpointMatch) {
      return null;
    }

    const services: DeviceServices = {
      user_id,
      power: { service_id: 1, value: parseInt(powerMatch[1], 10) },
      userMode: { service_id: 2, value: parseInt(userModeMatch[1], 10) },
      fanSpeed: { service_id: 4, value: parseInt(fanSpeedMatch[1], 10) },
      setpointTemp: {
        service_id: 9,
        raw_value: setpointMatch[1],
        value: parseFloat(setpointMatch[1]),
      },
      currentTemp: { value: 0 },
    };

    // Current temperature, if reported.
    const currentTemp = body.match(/<div class="key_value">([0-9.]+)\&deg;([FC])<\/div>/);
    if (currentTemp) {
      const raw = currentTemp[1];
      services.currentTemp = {
        units: currentTemp[2],
        raw_value: raw,
        value: currentTemp[2] === 'F' ? ((parseFloat(raw) - 32) * 5) / 9 : parseFloat(raw),
      };
    }

    // Vanes (may not exist on all models). swingMode maps vane 10 -> swing.
    const hvane = body.match(/var selectedhvane = (\d+);/);
    const vvane = body.match(/var selectedvvane = (\d+);/);
    if (hvane) {
      const value = parseInt(hvane[1], 10);
      services.swingMode = { service_id: 6, value: value === 10 ? 10 : 0 };
    }
    if (vvane && !services.swingMode) {
      const value = parseInt(vvane[1], 10);
      services.swingMode = { service_id: 5, value: value === 10 ? 10 : 0 };
    }

    return services;
  }

  /**
   * Set a single service value. Returns a structured result so the caller can
   * distinguish a confirmed success from a session problem (and retry).
   */
  public async setValue(deviceId: string, userId: string, serviceId: number, value: number): Promise<SetResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.ensureLogin()) {
        return { ok: false, reason: 'login-failed' };
      }

      const params = new URLSearchParams({
        id: deviceId,
        uid: String(serviceId),
        value: String(value),
        userId,
      });
      const url = `device/setVal?${params.toString()}`;

      let res: HttpResult;
      try {
        res = await this.request(url, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
      } catch (e) {
        this.log.error('setValue network error (attempt %d): %s', attempt + 1, (e as Error).message);
        return { ok: false, reason: 'http-error' };
      }

      if (this.isLoginPage(res)) {
        this.log.warn('setValue hit a login page (session expired); re-logging in (attempt %d).', attempt + 2);
        this.loggedIn = false;
        continue;
      }

      if (res.status === 200 && res.body.trim() === 'OK') {
        return { ok: true, reason: 'ok' };
      }

      this.log.error(
        'setValue returned unexpected response (status=%s, body=%s) for uid=%s value=%s.',
        res.status,
        JSON.stringify(res.body.slice(0, 120)),
        serviceId,
        value,
      );
      return { ok: false, reason: 'invalid-response' };
    }
    return { ok: false, reason: 'session-expired' };
  }
}
