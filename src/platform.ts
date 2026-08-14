import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { IntesisCloudClient } from './cloud';
import { IntesisDevice } from './device';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class IntesisWebPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly devices = new Map<string, IntesisDevice>();
  private readonly client: IntesisCloudClient;
  private readonly ready: boolean;
  private readonly swingMode: 'H' | 'V';
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInProgress = false;

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    const username = config['username'] as string | undefined;
    const password = config['password'] as string | undefined;
    this.swingMode = (config['swingMode'] as 'H' | 'V' | undefined) || 'H';
    if (!username || !password) {
      this.log.error('Missing username/password in plugin config. Plugin will not start.');
      this.client = new IntesisCloudClient(this.log, '', '');
      this.ready = false;
      return;
    }

    this.client = new IntesisCloudClient(
      this.log,
      username,
      password,
      (config['apiBaseURL'] as string | undefined) || undefined,
    );
    this.ready = true;

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching');
      void this.setup();
    });
  }

  private async setup(): Promise<void> {
    if (!this.ready) {
      return;
    }
    try {
      const devices = await this.client.getDevices();
      this.log.info(`Found ${devices.length} device(s) from Intesis cloud.`);
      for (const d of devices) {
        this.ensureAccessory(d.device_id, d.name);
      }
      // Remove accessories that no longer exist in the cloud.
      const knownIds = new Set(devices.map(d => d.device_id));
      for (const [id, accessory] of this.accessories) {
        if (!knownIds.has(id)) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.delete(id);
          this.devices.delete(id);
        }
      }

      await this.poll();
      this.startPolling();
    } catch (e) {
      this.log.error('Setup failed: %s', (e as Error).message);
    }
  }

  private ensureAccessory(deviceId: string, name: string): IntesisDevice {
    const existing = this.devices.get(deviceId);
    if (existing) {
      return existing;
    }

    let accessory = this.accessories.get(deviceId);
    if (!accessory) {
      const uuid = this.api.hap.uuid.generate(deviceId);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.context.deviceId = deviceId;
      accessory.context.name = name;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(deviceId, accessory);
    }

    const device = new IntesisDevice(this.log, this.api, this.client, deviceId, name, this.swingMode);
    this.devices.set(deviceId, device);

    // Attach the services to the cached accessory (or replace them).
    accessory.getService(this.api.hap.Service.AccessoryInformation) || accessory.addService(this.api.hap.Service.AccessoryInformation);
    const old = accessory.getService(this.api.hap.Service.HeaterCooler);
    if (old) {
      accessory.removeService(old);
    }
    accessory.addService(device.heaterCoolerService);

    this.log.info(`Added "${name}" - Device ID: ${deviceId}.`);
    return device;
  }

  private startPolling(): void {
    const seconds = (this.config['configCacheSeconds'] as number | undefined) || 30;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, seconds * 1000);
    this.log.info(`Background polling started (every ${seconds} seconds).`);
  }

  private async poll(): Promise<void> {
    if (this.pollInProgress) {
      return;
    }
    this.pollInProgress = true;
    try {
      for (const [deviceId, device] of this.devices) {
        const services = await this.client.getDeviceState(deviceId);
        device.updateFromCloud(services);
        await device.sync();
      }
    } catch (e) {
      this.log.error('Poll error: %s', (e as Error).message);
    } finally {
      this.pollInProgress = false;
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.context.deviceId as string, accessory);
  }

  /** Stop background polling (called by Homebridge on shutdown and in tests). */
  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
