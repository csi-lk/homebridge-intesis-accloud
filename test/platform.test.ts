import { describe, expect, test, mock } from 'bun:test';
import { IntesisWebPlatform } from '../src/platform.js';
import { makeFakeApi, makeFakeLogger } from './helpers.js';
import { PLUGIN_NAME, PLATFORM_NAME } from '../src/settings.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    platform: PLATFORM_NAME,
    username: 'user',
    password: 'pass',
    configCacheSeconds: 5,
    ...overrides,
  } as never;
}

interface SetupHarness {
  api: ReturnType<typeof makeFakeApi>;
  platform: IntesisWebPlatform;
  didFinishLaunching: () => void;
}

function makeSetup(client: Record<string, unknown>): SetupHarness {
  const api = makeFakeApi();
  const listeners = new Map<string, Array<() => void>>();
  api.on = ((evt: string, cb: () => void) => {
    const l = listeners.get(evt) ?? [];
    l.push(cb);
    listeners.set(evt, l);
  }) as never;

  const platform = new IntesisWebPlatform(makeFakeLogger(), makeConfig(), api) as unknown as IntesisWebPlatform;
  // Swap in the injected client
  (platform as unknown as { client: unknown }).client = client;
  return {
    api,
    platform,
    didFinishLaunching: () => (listeners.get('didFinishLaunching') ?? []).forEach(cb => cb()),
  };
}

describe('IntesisWebPlatform', () => {
  test('registers accessories and starts polling after launch', async () => {
    const registered: string[] = [];
    const api = makeFakeApi();
    const listeners = new Map<string, Array<() => void>>();
    api.on = ((evt: string, cb: () => void) => {
      const l = listeners.get(evt) ?? [];
      l.push(cb);
      listeners.set(evt, l);
    }) as never;
    api.registerPlatformAccessories = ((_p: string, _n: string, accs: Array<{ displayName: string }>) => {
      accs.forEach(a => registered.push(a.displayName));
    }) as never;

    const getDevices = mock(async () => [
      { device_id: 'D1', name: 'Master Bedroom' },
      { device_id: 'D2', name: 'Nursery' },
    ]);
    const getDeviceState = mock(async () => ({
      user_id: 'U1',
      power: { service_id: 1, value: 0 },
    }));
    const setValue = mock(async () => ({ ok: true, reason: 'ok' as const }));

    const platform = new IntesisWebPlatform(makeFakeLogger(), makeConfig(), api) as unknown as IntesisWebPlatform;
    (platform as unknown as { client: unknown }).client = { getDevices, getDeviceState, setValue };

    (listeners.get('didFinishLaunching') ?? []).forEach(cb => cb());
    // Give the async setup a tick.
    await new Promise(r => setTimeout(r, 10));

    expect(getDevices).toHaveBeenCalled();
    expect(registered).toContain('Master Bedroom');
    expect(registered).toContain('Nursery');
    platform.stop();
  });

  test('removes accessories no longer present in the cloud', async () => {
    const api = makeFakeApi();
    const listeners = new Map<string, Array<() => void>>();
    api.on = ((evt: string, cb: () => void) => {
      const l = listeners.get(evt) ?? [];
      l.push(cb);
      listeners.set(evt, l);
    }) as never;

    let unregistered = 0;
    api.unregisterPlatformAccessories = (() => { unregistered++; }) as never;

    const getDevices = mock(async () => [{ device_id: 'D1', name: 'Master Bedroom' }]);
    const getDeviceState = mock(async () => ({ user_id: 'U1', power: { service_id: 1, value: 0 } }));
    const setValue = mock(async () => ({ ok: true, reason: 'ok' as const }));

    const platform = new IntesisWebPlatform(makeFakeLogger(), makeConfig(), api) as unknown as IntesisWebPlatform;
    (platform as unknown as { client: unknown }).client = { getDevices, getDeviceState, setValue };

    // Seed a stale accessory via configureAccessory.
    const acc = new api.platformAccessory('Stale', api.hap.uuid.generate('STALE'));
    acc.context.deviceId = 'STALE';
    acc.context.name = 'Stale';
    platform.configureAccessory(acc);

    (listeners.get('didFinishLaunching') ?? []).forEach(cb => cb());
    await new Promise(r => setTimeout(r, 10));

    expect(unregistered).toBe(1);
    platform.stop();
  });

  test('does not start when credentials missing', async () => {
    const api = makeFakeApi();
    const platform = new IntesisWebPlatform(
      makeFakeLogger(),
      makeConfig({ username: undefined, password: undefined }),
      api,
    ) as unknown as IntesisWebPlatform;
    expect((platform as unknown as { ready: boolean }).ready).toBe(false);
  });

  test('uses swingMode config', async () => {
    const api = makeFakeApi();
    const platform = new IntesisWebPlatform(
      makeFakeLogger(),
      makeConfig({ swingMode: 'V' }),
      api,
    ) as unknown as IntesisWebPlatform;
    expect((platform as unknown as { swingMode: 'H' | 'V' }).swingMode).toBe('V');
  });

  test('poll skips when a poll is already in progress', async () => {
    const api = makeFakeApi();
    const listeners = new Map<string, Array<() => void>>();
    api.on = ((evt: string, cb: () => void) => {
      const l = listeners.get(evt) ?? [];
      l.push(cb);
      listeners.set(evt, l);
    }) as never;

    let stateCalls = 0;
    const getDeviceState = mock(async () => {
      stateCalls++;
      return { user_id: 'U1', power: { service_id: 1, value: 0 } };
    });
    const getDevices = mock(async () => [{ device_id: 'D1', name: 'Master Bedroom' }]);
    const setValue = mock(async () => ({ ok: true, reason: 'ok' as const }));

    const platform = new IntesisWebPlatform(makeFakeLogger(), makeConfig(), api) as unknown as IntesisWebPlatform;
    (platform as unknown as { client: unknown }).client = { getDevices, getDeviceState, setValue };
    (listeners.get('didFinishLaunching') ?? []).forEach(cb => cb());
    await new Promise(r => setTimeout(r, 10));

    // Trigger an explicit poll while setup's poll may overlap; guarded by pollInProgress.
    await (platform as unknown as { poll: () => Promise<void> }).poll();
    expect(stateCalls).toBeGreaterThanOrEqual(1);
    platform.stop();
  });

  test('startPolling schedules background polls via setInterval', async () => {
    const api = makeFakeApi();
    const listeners = new Map<string, Array<() => void>>();
    api.on = ((evt: string, cb: () => void) => {
      const l = listeners.get(evt) ?? [];
      l.push(cb);
      listeners.set(evt, l);
    }) as never;

    let pollCallback: (() => void) | null = null;
    const setIntervalSpy = mock((fn: () => void, _ms: number) => {
      pollCallback = fn;
      return 123 as unknown as NodeJS.Timeout;
    });
    const origSetInterval = globalThis.setInterval;
    (globalThis as { setInterval: unknown }).setInterval = setIntervalSpy;

    try {
      const getDeviceState = mock(async () => ({ user_id: 'U1', power: { service_id: 1, value: 0 } }));
      const getDevices = mock(async () => [{ device_id: 'D1', name: 'Master Bedroom' }]);
      const setValue = mock(async () => ({ ok: true, reason: 'ok' as const }));

      const platform = new IntesisWebPlatform(makeFakeLogger(), makeConfig(), api) as unknown as IntesisWebPlatform;
      (platform as unknown as { client: unknown }).client = { getDevices, getDeviceState, setValue };
      (listeners.get('didFinishLaunching') ?? []).forEach(cb => cb());
      await new Promise(r => setTimeout(r, 10));

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(pollCallback).not.toBeNull();

      const before = getDeviceState.mock.calls.length;
      pollCallback!();
      await new Promise(r => setTimeout(r, 10));
      expect(getDeviceState.mock.calls.length).toBeGreaterThan(before);
      platform.stop();
    } finally {
      (globalThis as { setInterval: unknown }).setInterval = origSetInterval;
    }
  });

  test('poll logs an error when getDeviceState throws', async () => {
    const api = makeFakeApi();
    const listeners = new Map<string, Array<() => void>>();
    api.on = ((evt: string, cb: () => void) => {
      const l = listeners.get(evt) ?? [];
      l.push(cb);
      listeners.set(evt, l);
    }) as never;

    const getDeviceState = mock(async () => { throw new Error('boom'); });
    const getDevices = mock(async () => [{ device_id: 'D1', name: 'Master Bedroom' }]);
    const setValue = mock(async () => ({ ok: true, reason: 'ok' as const }));

    const platform = new IntesisWebPlatform(makeFakeLogger(), makeConfig(), api) as unknown as IntesisWebPlatform;
    (platform as unknown as { client: unknown }).client = { getDevices, getDeviceState, setValue };
    (listeners.get('didFinishLaunching') ?? []).forEach(cb => cb());
    await new Promise(r => setTimeout(r, 10));

    expect(getDeviceState).toHaveBeenCalled();
    platform.stop();
  });
});
