import { describe, expect, test } from 'bun:test';
import { IntesisCloudClient, type FetchFn } from '../src/cloud.js';
import { makeFakeLogger } from './helpers.js';

interface FakeResponseOptions {
  status?: number;
  contentType?: string | null;
  body?: string;
  setCookie?: string | null;
}

/** Build a minimal Response-like object. */
function makeResponse(opts: FakeResponseOptions): Response {
  const { status = 200, contentType = 'text/html; charset=utf-8', body = '', setCookie = null } = opts;
  return {
    status,
    headers: new Headers({
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(setCookie ? { 'set-cookie': setCookie } : {}),
    }),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const LOGIN_PAGE = `<html><title>Sign in</title><body>
  <input type="hidden" name="signin[_csrf_token]" value="TOKEN123">
  <form>signin</form></body></html>`;

interface Script {
  url: string;
  method: string;
  body: string;
  respond: (opts?: Partial<FakeResponseOptions>) => void;
}

/**
 * A scriptable fetch harness. Each expected call is registered with
 * `expectCall`; unhandled calls throw so the test fails loudly.
 */
function makeFetchHarness() {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const handlers: Array<{ matcher: (url: string, method: string) => boolean; responder: () => Response }> = [];

  const fetchFn: FetchFn = (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, body });
    const index = handlers.findIndex(h => h.matcher(url, method));
    if (index === -1) {
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }
    const [handler] = handlers.splice(index, 1);
    return Promise.resolve(handler.responder());
  };

  const harness = {
    fetchFn,
    calls,
    expectCall(url: string, method: string): Script {
      const script: Script = { url, method, body: '', respond: () => {} };
      handlers.push({
        matcher: (u, m) => u === script.url && m === script.method,
        responder: () => makeResponse({ body: script.body }),
      });
      script.respond = (opts) => {
        handlers[handlers.length - 1].responder = () => makeResponse(opts ?? {});
      };
      return script;
    },
  };

  return harness;
}

function makeClient(fetchFn: FetchFn) {
  return new IntesisCloudClient(makeFakeLogger(), 'user', 'pass', undefined, fetchFn);
}

describe('IntesisCloudClient', () => {
  test('getDevices parses device headers', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: LOGIN_PAGE });
    const post = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST');
    post.respond({ status: 302, setCookie: 'symfony=sess; path=/' });

    const headers = h.expectCall(new URL('panel/headers', 'https://accloud.intesis.com/').toString(), 'GET');
    headers.respond({
      body: `<div id="deviceHeader_206448961640"><div class="name left">Master Bedroom</div></div>
             <div id="deviceHeader_206449240056"><div class="name left">Nursery</div></div>`,
    });

    const client = makeClient(h.fetchFn);
    const devices = await client.getDevices();
    expect(devices).toEqual([
      { device_id: '206448961640', name: 'Master Bedroom' },
      { device_id: '206449240056', name: 'Nursery' },
    ]);
    // Cookie from login POST was stored and sent on the headers request.
    const headersCall = h.calls.find(c => c.url.includes('panel/headers'));
    expect(headersCall?.body).toBe('');
  });

  test('getDevices returns [] when fetchWithLogin fails to log in', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: LOGIN_PAGE });
    const post = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST');
    post.respond({ status: 200, body: 'Login failed' });

    const client = makeClient(h.fetchFn);
    const devices = await client.getDevices();
    expect(devices).toEqual([]);
  });

  test('getDevices returns [] on network error during login', async () => {
    const h = makeFetchHarness();
    h.fetchFn = (() => Promise.reject(new Error('ECONNRESET'))) as FetchFn;
    const client = makeClient(h.fetchFn);
    const devices = await client.getDevices();
    expect(devices).toEqual([]);
  });

  test('login skips POST when already logged in (project-main-menu page)', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: '<div id="project-main-menu">...</div>' });

    const headers = h.expectCall(new URL('panel/headers', 'https://accloud.intesis.com/').toString(), 'GET');
    headers.respond({ body: '' });

    const client = makeClient(h.fetchFn);
    await client.getDevices();
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(0);
  });

  test('login returns false and logs error when CSRF token missing', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: '<html><title>Sign in</title>no token</html>' });

    const client = makeClient(h.fetchFn);
    expect(await client.ensureLogin()).toBe(false);
  });

  test('getDeviceState parses a full vista page', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: LOGIN_PAGE });
    const post = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST');
    post.respond({ status: 302 });

    const vista = h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET');
    vista.respond({
      body: `&userId=121679
             var selectedOnOff = 1;
             var selectedUsermode = 4;
             var selectedfanspeed = 2;
             setTempCelsiusConsignaHeader(206448961640, '23.0');
             <div class="key_value">24.0&deg;C</div>
             var selectedhvane = 0;`,
    });

    const client = makeClient(h.fetchFn);
    const state = await client.getDeviceState('DEV1');
    expect(state).not.toBeNull();
    expect(state!.user_id).toBe('121679');
    expect(state!.power).toEqual({ service_id: 1, value: 1 });
    expect(state!.userMode).toEqual({ service_id: 2, value: 4 });
    expect(state!.fanSpeed).toEqual({ service_id: 4, value: 2 });
    expect(state!.setpointTemp!.value).toBe(23);
    expect(state!.currentTemp!.value).toBe(24);
    expect(state!.currentTemp!.units).toBe('C');
    expect(state!.swingMode).toEqual({ service_id: 6, value: 0 });
  });

  test('getDeviceState converts Fahrenheit current temp to Celsius', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: LOGIN_PAGE });
    const post = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST');
    post.respond({ status: 302 });

    const vista = h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET');
    vista.respond({
      body: `&userId=121679
             var selectedOnOff = 0;
             var selectedUsermode = 1;
             var selectedfanspeed = 0;
             setTempCelsiusConsignaHeader(206448961640, '20.0');
             <div class="key_value">77.0&deg;F</div>`,
    });

    const client = makeClient(h.fetchFn);
    const state = await client.getDeviceState('DEV1');
    expect(state!.currentTemp!.value).toBeCloseTo(25, 5);
    expect(state!.currentTemp!.units).toBe('F');
    expect(state!.swingMode).toBeUndefined();
  });

  test('getDeviceState parses vertical vane swing', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: LOGIN_PAGE });
    const post = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST');
    post.respond({ status: 302 });

    const vista = h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET');
    vista.respond({
      body: `&userId=121679
             var selectedOnOff = 1;
             var selectedUsermode = 0;
             var selectedfanspeed = 0;
             setTempCelsiusConsignaHeader(206448961640, '22.0');
             var selectedvvane = 10;`,
    });

    const client = makeClient(h.fetchFn);
    const state = await client.getDeviceState('DEV1');
    expect(state!.swingMode).toEqual({ service_id: 5, value: 10 });
  });

  test('getDeviceState returns null when userId missing', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: LOGIN_PAGE });
    const post = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST');
    post.respond({ status: 302 });

    const vista = h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET');
    vista.respond({ body: 'no userId here' });

    const client = makeClient(h.fetchFn);
    expect(await client.getDeviceState('DEV1')).toBeNull();
  });

  test('getDeviceState returns null when a required field is missing', async () => {
    const h = makeFetchHarness();
    const login = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET');
    login.respond({ body: LOGIN_PAGE });
    const post = h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST');
    post.respond({ status: 302 });

    const vista = h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET');
    vista.respond({ body: '&userId=121679\nvar selectedOnOff = 1;' });

    const client = makeClient(h.fetchFn);
    expect(await client.getDeviceState('DEV1')).toBeNull();
  });

  test('getDeviceState re-logs in when session expired and then succeeds', async () => {
    const h = makeFetchHarness();
    // First login
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    // Vista returns login page (expired session) -> triggers re-login
    h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });

    // Re-login (GET returns already-logged-in page, no POST)
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: '<div id="project-main-menu">ok</div>' });

    // Retried vista succeeds
    h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({
        body: `&userId=121679
               var selectedOnOff = 1;
               var selectedUsermode = 0;
               var selectedfanspeed = 0;
               setTempCelsiusConsignaHeader(206448961640, '21.0');`,
      });

    const client = makeClient(h.fetchFn);
    const state = await client.getDeviceState('DEV1');
    expect(state!.user_id).toBe('121679');
  });

  test('getDeviceState returns null after repeated session expiry', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    // Always login page on vista
    for (let i = 0; i < 4; i++) {
      h.expectCall(new URL('panel/vista?id=DEV1', 'https://accloud.intesis.com/').toString(), 'GET')
        .respond({ body: LOGIN_PAGE });
    }
    // re-logins keep succeeding via the main-menu page
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: '<div id="project-main-menu">ok</div>' });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: '<div id="project-main-menu">ok</div>' });

    const client = makeClient(h.fetchFn);
    expect(await client.getDeviceState('DEV1')).toBeNull();
  });

  test('setValue succeeds with OK body', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    h.expectCall(new URL('device/setVal?id=DEV1&uid=1&value=1&userId=U1', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 200, contentType: 'text/plain', body: 'OK' });

    const client = makeClient(h.fetchFn);
    expect(await client.setValue('DEV1', 'U1', 1, 1)).toEqual({ ok: true, reason: 'ok' });
  });

  test('setValue detects session expiry, re-logs in, and retries successfully', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    // First setVal hits login page (session expired)
    h.expectCall(new URL('device/setVal?id=DEV1&uid=1&value=1&userId=U1', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ body: LOGIN_PAGE });

    // Re-login
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: '<div id="project-main-menu">ok</div>' });

    // Retry succeeds
    h.expectCall(new URL('device/setVal?id=DEV1&uid=1&value=1&userId=U1', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 200, contentType: 'text/plain', body: 'OK' });

    const client = makeClient(h.fetchFn);
    expect(await client.setValue('DEV1', 'U1', 1, 1)).toEqual({ ok: true, reason: 'ok' });
  });

  test('setValue returns session-expired after 3 failed attempts', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    const setUrl = new URL('device/setVal?id=DEV1&uid=1&value=1&userId=U1', 'https://accloud.intesis.com/').toString();
    // 3 attempts, each hitting login page; between each we re-login
    for (let i = 0; i < 3; i++) {
      h.expectCall(setUrl, 'POST').respond({ body: LOGIN_PAGE });
    }
    // re-logins
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: '<div id="project-main-menu">ok</div>' });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: '<div id="project-main-menu">ok</div>' });

    const client = makeClient(h.fetchFn);
    expect(await client.setValue('DEV1', 'U1', 1, 1)).toEqual({ ok: false, reason: 'session-expired' });
  });

  test('setValue returns http-error on network failure', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    h.fetchFn = ((() => {
      let n = 0;
      return (url: string) => {
        n++;
        if (n <= 1) {
          return Promise.resolve(makeResponse({ body: LOGIN_PAGE }));
        }
        if (n === 2) {
          return Promise.resolve(makeResponse({ body: '<div id="project-main-menu">ok</div>' }));
        }
        return Promise.reject(new Error('socket hang up'));
      };
    })()) as FetchFn;

    const client = makeClient(h.fetchFn);
    expect(await client.setValue('DEV1', 'U1', 1, 1)).toEqual({ ok: false, reason: 'http-error' });
  });

  test('setValue returns invalid-response for non-OK body', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    h.expectCall(new URL('device/setVal?id=DEV1&uid=1&value=1&userId=U1', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 500, body: 'Server Error' });

    const client = makeClient(h.fetchFn);
    expect(await client.setValue('DEV1', 'U1', 1, 1)).toEqual({ ok: false, reason: 'invalid-response' });
  });

  test('setValue returns login-failed when login cannot establish a session', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 200, body: 'Invalid credentials' });

    const client = makeClient(h.fetchFn);
    expect(await client.setValue('DEV1', 'U1', 1, 1)).toEqual({ ok: false, reason: 'login-failed' });
  });

  test('ensureLogin returns cached true when already logged in', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    const client = makeClient(h.fetchFn);
    expect(await client.ensureLogin()).toBe(true);
    // Second call should not hit the network.
    expect(await client.ensureLogin()).toBe(true);
    expect(h.calls.length).toBe(2);
  });

  test('concurrent ensureLogin calls share a single login', async () => {
    const h = makeFetchHarness();
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'GET')
      .respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', 'https://accloud.intesis.com/').toString(), 'POST')
      .respond({ status: 302 });

    const client = makeClient(h.fetchFn);
    const [a, b] = await Promise.all([client.ensureLogin(), client.ensureLogin()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(h.calls.length).toBe(2); // only one login round
  });

  test('uses custom base URL when provided', async () => {
    const h = makeFetchHarness();
    const base = 'https://example.com/foo/';
    h.expectCall(new URL('login', base).toString(), 'GET').respond({ body: LOGIN_PAGE });
    h.expectCall(new URL('login', base).toString(), 'POST').respond({ status: 302 });

    const client = new IntesisCloudClient(makeFakeLogger(), 'u', 'p', base, h.fetchFn);
    expect(await client.ensureLogin()).toBe(true);
  });
});
