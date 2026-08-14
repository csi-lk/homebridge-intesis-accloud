import { describe, expect, test, mock } from 'bun:test';
import { IntesisDevice, DesiredValue } from '../src/device';
import { makeFakeApi, makeFakeLogger } from './helpers';

const powerMap = { toIntesis: (v: number) => (v === 1 ? 1 : 0), toHomeKit: (v: number) => (v === 1 ? 1 : 0) };

interface RecordingClient {
  setValue: ReturnType<typeof mock>;
  sent: Array<{ serviceId: number; value: number }>;
}

function makeRecordingClient(ok = true): RecordingClient {
  const sent: Array<{ serviceId: number; value: number }> = [];
  const setValue = mock(async (_d: string, _u: string, serviceId: number, value: number) => {
    sent.push({ serviceId, value });
    return ok ? { ok: true as const, reason: 'ok' as const } : { ok: false as const, reason: 'invalid-response' as const };
  });
  return { setValue, sent };
}

function makeDevice(opts: { client?: RecordingClient; swingPref?: 'H' | 'V'; now?: () => number } = {}) {
  const client = opts.client ?? makeRecordingClient();
  const device = new IntesisDevice(
    makeFakeLogger(),
    makeFakeApi(),
    client as never,
    'DEV1',
    'Living Room',
    opts.swingPref,
    opts.now,
  );
  return { device, client };
}

describe('DesiredValue', () => {
  test('tracks desired and confirms when cloud matches', () => {
    const v = new DesiredValue(1, powerMap);
    v.setDesired(1);
    expect(v.needsSync).toBe(true);
    v.onCloudValue(1);
    expect(v.needsSync).toBe(false);
    expect(v.lastConfirmed).toBe(1);
    expect(v.retryCount).toBe(0);
  });

  test('stays pending while cloud disagrees', () => {
    const v = new DesiredValue(1, powerMap);
    v.setDesired(1);
    v.onCloudValue(0);
    expect(v.needsSync).toBe(true);
    expect(v.lastConfirmed).toBe(0);
  });

  test('markSent increments retry count and stamps time', () => {
    const v = new DesiredValue(1, powerMap);
    v.markSent();
    v.markSent();
    expect(v.retryCount).toBe(2);
    expect(v.lastSentAt).not.toBeNull();
  });

  test('readyToSend is true before first send and after interval', () => {
    const v = new DesiredValue(1, powerMap);
    expect(v.readyToSend(1000)).toBe(true);
    v.markSent();
    expect(v.readyToSend(1000)).toBe(false); // sent at real now; use large offset below
    // Simulate elapsed time via readyToSend's now parameter relative to lastSentAt:
    const sentAt = v.lastSentAt!;
    expect(v.readyToSend(sentAt + 1000)).toBe(false);
    expect(v.readyToSend(sentAt + 6000)).toBe(true);
  });

  test('toIntesis maps through the map', () => {
    const v = new DesiredValue(1, powerMap);
    v.setDesired(1);
    expect(v.toIntesis()).toBe(1);
  });

  test('setDesired resets retry state and forces immediate send', () => {
    const v = new DesiredValue(1, powerMap);
    v.markSent();
    v.markSent();
    v.setDesired(0);
    expect(v.retryCount).toBe(0);
    expect(v.lastSentAt).toBeNull();
    expect(v.readyToSend(Date.now())).toBe(true);
  });
});

describe('IntesisDevice', () => {
  test('exposes heater cooler and accessory information services', () => {
    const { device } = makeDevice();
    expect(device.services).toHaveLength(2);
    expect(device.heaterCoolerService).toBeDefined();
    expect(device.accessoryInformation).toBeDefined();
  });

  test('updateFromCloud updates characteristics and confirms desired power', () => {
    const { device } = makeDevice();
    const api = makeFakeApi();
    const Active = api.hap.Characteristic.Active;

    device.heaterCoolerService.getCharacteristic(Active).setValue(1);
    device.updateFromCloud({
      user_id: 'U1',
      power: { service_id: 1, value: 1 },
      userMode: { service_id: 2, value: 0 },
      fanSpeed: { service_id: 4, value: 1 },
      setpointTemp: { service_id: 9, value: 23 },
      currentTemp: { value: 22 },
      swingMode: { service_id: 6, value: 0 },
    });

    expect(device.heaterCoolerService.getCharacteristic(Active).value).toBe(1);
    expect(device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.RotationSpeed).value).toBe(1);
    expect(device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.CoolingThresholdTemperature).value).toBe(23);
    expect(device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.HeatingThresholdTemperature).value).toBe(23);
    expect(device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.CurrentTemperature).value).toBe(22);
  });

  test('updateFromCloud keeps desired value visible while pending', () => {
    const { device } = makeDevice();
    const api = makeFakeApi();
    const Active = api.hap.Characteristic.Active;

    device.heaterCoolerService.getCharacteristic(Active).setValue(1);
    device.updateFromCloud({ user_id: 'U1', power: { service_id: 1, value: 0 } });
    expect(device.heaterCoolerService.getCharacteristic(Active).value).toBe(1);
  });

  test('updateFromCloud warns and leaves state untouched when services null', () => {
    const { device } = makeDevice();
    device.updateFromCloud(null);
    expect(device.heaterCoolerService.getCharacteristic(makeFakeApi().hap.Characteristic.Active).getValue()).toBe(0);
  });

  test('sync sends pending desired values to the cloud', async () => {
    const { device, client } = makeDevice();
    device.updateFromCloud({ user_id: 'U1', power: { service_id: 1, value: 0 } });
    const api = makeFakeApi();
    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.Active).setValue(1);

    await device.sync();
    expect(client.sent).toEqual([{ serviceId: 1, value: 1 }]);
  });

  test('sync warns and skips when no user id is known', async () => {
    const { device, client } = makeDevice();
    const api = makeFakeApi();
    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.Active).setValue(1);
    await device.sync();
    expect(client.sent).toHaveLength(0);
  });

  test('sync retries failed sends on a later poll after the retry interval', async () => {
    let now = 1000000;
    const { device, client } = makeDevice({ now: () => now });
    device.updateFromCloud({ user_id: 'U1', power: { service_id: 1, value: 0 } });
    const api = makeFakeApi();

    // Make the client fail so the value stays pending.
    const failing = makeRecordingClient(false);
    (device as unknown as { client: unknown }).client = failing;

    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.Active).setValue(1);
    await device.sync();
    expect(failing.sent).toHaveLength(1);

    // Immediately after: not ready to send again (within retry interval).
    now += 1000;
    await device.sync();
    expect(failing.sent).toHaveLength(1);

    // After the retry interval: sends again.
    now += 6000;
    await device.sync();
    expect(failing.sent).toHaveLength(2);
  });

  test('sync updates all characteristic types optimistically on success', async () => {
    const { device, client } = makeDevice();
    device.updateFromCloud({ user_id: 'U1', power: { service_id: 1, value: 0 } });
    const api = makeFakeApi();

    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.Active).setValue(1);
    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.TargetHeaterCoolerState).setValue(2);
    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.RotationSpeed).setValue(3);
    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.CoolingThresholdTemperature).setValue(24);
    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.SwingMode).setValue(1);

    await device.sync();
    expect(client.sent).toContainEqual({ serviceId: 1, value: 1 });   // power on
    expect(client.sent).toContainEqual({ serviceId: 2, value: 4 });   // cool
    expect(client.sent).toContainEqual({ serviceId: 4, value: 3 });   // fan 3
    expect(client.sent).toContainEqual({ serviceId: 9, value: 240 }); // 24C *10
    expect(client.sent).toContainEqual({ serviceId: 6, value: 10 });  // swing
  });

  test('onGet handlers return desired value while pending, else confirmed', () => {
    const { device } = makeDevice();
    const api = makeFakeApi();
    const { Characteristic } = api.hap;

    // Before any cloud data: defaults
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.Active).getValue()).toBe(0);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).getValue()).toBe(0);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).getValue()).toBe(0);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).getValue()).toBe(25);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).getValue()).toBe(25);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.CurrentTemperature).getValue()).toBe(0);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.SwingMode).getValue()).toBe(0);

    // Push full cloud state and confirm onGet reflects it
    device.updateFromCloud({
      user_id: 'U1',
      power: { service_id: 1, value: 1 },
      userMode: { service_id: 2, value: 4 },
      fanSpeed: { service_id: 4, value: 3 },
      setpointTemp: { service_id: 9, value: 24 },
      currentTemp: { value: 21.5 },
      swingMode: { service_id: 6, value: 10 },
    });

    expect(device.heaterCoolerService.getCharacteristic(Characteristic.Active).getValue()).toBe(1);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).getValue()).toBe(2);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).getValue()).toBe(3);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).getValue()).toBe(24);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).getValue()).toBe(24);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.CurrentTemperature).getValue()).toBe(21.5);
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.SwingMode).getValue()).toBe(1);

    // Set a desired power while cloud reports off: onGet prefers desired.
    device.heaterCoolerService.getCharacteristic(Characteristic.Active).setValue(1);
    device.updateFromCloud({ user_id: 'U1', power: { service_id: 1, value: 0 } });
    expect(device.heaterCoolerService.getCharacteristic(Characteristic.Active).getValue()).toBe(1);
  });

  test('onSet handlers record desired values for every characteristic', async () => {
    const { device, client } = makeDevice();
    device.updateFromCloud({
      user_id: 'U1',
      power: { service_id: 1, value: 0 },
      userMode: { service_id: 2, value: 0 },
      fanSpeed: { service_id: 4, value: 0 },
      setpointTemp: { service_id: 9, value: 23 },
      swingMode: { service_id: 6, value: 0 },
    });
    const api = makeFakeApi();
    const { Characteristic } = api.hap;

    device.heaterCoolerService.getCharacteristic(Characteristic.Active).setValue(1);
    device.heaterCoolerService.getCharacteristic(Characteristic.TargetHeaterCoolerState).setValue(2);
    device.heaterCoolerService.getCharacteristic(Characteristic.RotationSpeed).setValue(3);
    device.heaterCoolerService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setValue(24);
    device.heaterCoolerService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setValue(24);
    device.heaterCoolerService.getCharacteristic(Characteristic.SwingMode).setValue(1);

    await device.sync();
    expect(client.sent).toContainEqual({ serviceId: 1, value: 1 });
    expect(client.sent).toContainEqual({ serviceId: 2, value: 4 });
    expect(client.sent).toContainEqual({ serviceId: 4, value: 3 });
    expect(client.sent).toContainEqual({ serviceId: 9, value: 240 });
    expect(client.sent).toContainEqual({ serviceId: 6, value: 10 });
  });

  test('swing preference V targets vertical vane service 5', async () => {
    const { device, client } = makeDevice({ swingPref: 'V' });
    device.updateFromCloud({
      user_id: 'U1',
      swingMode: { service_id: 5, value: 0 },
    });
    const api = makeFakeApi();
    device.heaterCoolerService.getCharacteristic(api.hap.Characteristic.SwingMode).setValue(1);
    await device.sync();
    expect(client.sent).toContainEqual({ serviceId: 5, value: 10 });
  });
});
