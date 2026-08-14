import type { API, Characteristic, Logger, Service } from 'homebridge';
import type { IntesisCloudClient, DeviceServices } from './cloud.js';

/**
 * Mapping between HomeKit characteristic values and Intesis service values.
 */
export interface ValueMap {
  toIntesis(homekitValue: number): number;
  toHomeKit(intesisValue: number): number;
}

const powerMap: ValueMap = {
  toIntesis(v) { return v === 1 ? 1 : 0; },
  toHomeKit(v) { return v === 1 ? 1 : 0; },
};

const userModeMap: ValueMap = {
  // Intesis: 0 auto, 1 heat, 2 dry, 3 fan, 4 cool
  // HomeKit TargetHeaterCoolerState: 0 AUTO, 1 HEAT, 2 COOL
  toIntesis(v) {
    if (v === 1) return 1; // HEAT
    if (v === 2) return 4; // COOL
    return 0; // AUTO
  },
  toHomeKit(v) {
    if (v === 1) return 1; // heat
    if (v === 4) return 2; // cool
    return 0; // auto
  },
};

const fanMap: ValueMap = {
  toIntesis(v) { return v; },
  toHomeKit(v) { return v; },
};

const setpointMap: ValueMap = {
  // HomeKit uses °C (e.g. 24.0); the cloud setVal API expects the value
  // in tenths of a degree (e.g. 240). The vista page reports the setpoint
  // back in °C, so toHomeKit is the identity mapping.
  toIntesis(v) { return Math.round(v * 10); },
  toHomeKit(v) { return v; },
};

const swingMap: ValueMap = {
  toIntesis(v) { return v === 1 ? 10 : 0; }, // SWING_ENABLED=1
  toHomeKit(v) { return v === 10 ? 1 : 0; },
};

/**
 * A single controllable service on a device, with a desired value that we
 * keep trying to apply until the cloud confirms it.
 */
export class DesiredValue {
  public desired: number | null = null;
  public lastConfirmed: number | null = null;
  public lastSentAt: number | null = null;
  public retryCount = 0;
  private readonly map: ValueMap;

  constructor(
    public serviceId: number,
    map: ValueMap,
  ) {
    this.map = map;
  }

  public onCloudValue(intesisValue: number): void {
    this.lastConfirmed = this.map.toHomeKit(intesisValue);
    // If cloud agrees with our desired value, we're done.
    if (this.desired !== null && this.lastConfirmed === this.desired) {
      this.desired = null;
      this.retryCount = 0;
      this.lastSentAt = null;
    }
  }

  public get needsSync(): boolean {
    return this.desired !== null;
  }

  /**
   * A value is ready to send if it has never been sent, or enough time has
   * passed since the last attempt (so a failed/ignored set keeps being
   * retried without hammering the cloud every poll).
   */
  public readyToSend(now: number, minRetryIntervalMs = 5000): boolean {
    return this.lastSentAt === null || now - this.lastSentAt >= minRetryIntervalMs;
  }

  public markSent(now = Date.now()): void {
    this.retryCount++;
    this.lastSentAt = now;
  }

  public setDesired(homekitValue: number): void {
    this.desired = homekitValue;
    this.lastSentAt = null; // send as soon as possible
    this.retryCount = 0;
  }

  public toIntesis(): number {
    return this.map.toIntesis(this.desired!);
  }
}

/**
 * Wraps an Intesis device: holds current state, desired values and the
 * HomeKit HeaterCooler accessory.
 */
export class IntesisDevice {
  public readonly heaterCoolerService: Service;
  public readonly accessoryInformation: Service;
  public readonly services: Service[];

  private readonly power: DesiredValue;
  private readonly userMode: DesiredValue;
  private readonly fanSpeed: DesiredValue;
  private readonly setpoint: DesiredValue;
  private readonly swingMode: DesiredValue;
  private currentTemp: number | null = null;
  private lastState: DeviceServices | null = null;

  constructor(
    private readonly log: Logger,
    private readonly api: API,
    private readonly client: IntesisCloudClient,
    public readonly deviceId: string,
    public readonly name: string,
    private readonly swingPref: 'H' | 'V' = 'H',
    private readonly now: () => number = () => Date.now(),
  ) {
    const Characteristic = this.api.hap.Characteristic;
    const Service = this.api.hap.Service;

    this.heaterCoolerService = new Service.HeaterCooler(this.name);
    this.accessoryInformation = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Intesis')
      .setCharacteristic(Characteristic.Model, 'IntesisHome')
      .setCharacteristic(Characteristic.SerialNumber, this.deviceId);

    this.services = [this.heaterCoolerService, this.accessoryInformation];

    this.power = new DesiredValue(1, powerMap);
    this.userMode = new DesiredValue(2, userModeMap);
    this.fanSpeed = new DesiredValue(4, fanMap);
    this.setpoint = new DesiredValue(9, setpointMap);
    this.swingMode = new DesiredValue(this.swingPref === 'V' ? 5 : 6, swingMap);

    this.setupServices();
  }

  private setupServices(): void {
    const { Characteristic } = this.api.hap;

    this.heaterCoolerService
      .getCharacteristic(Characteristic.Active)
      .onGet(() => {
        return this.power.desired ?? this.power.lastConfirmed ?? 0;
      })
      .onSet((value) => {
        this.power.setDesired(value as number);
        this.log.debug(`${this.name}: desired power=${value}`);
        void this.sync();
      });

    this.heaterCoolerService
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onGet(() => {
        return this.userMode.desired ?? this.userMode.lastConfirmed ?? 0;
      })
      .onSet((value) => {
        this.userMode.setDesired(value as number);
        this.log.debug(`${this.name}: desired mode=${value}`);
        void this.sync();
      });

    this.heaterCoolerService
      .addCharacteristic(Characteristic.RotationSpeed)
      .setProps({ maxValue: 4, minValue: 0, minStep: 1 })
      .onGet(() => {
        return this.fanSpeed.desired ?? this.fanSpeed.lastConfirmed ?? 0;
      })
      .onSet((value) => {
        this.fanSpeed.setDesired(value as number);
        this.log.debug(`${this.name}: desired fan=${value}`);
        void this.sync();
      });

    this.heaterCoolerService
      .addCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ maxValue: 35, minValue: 10, minStep: 1 })
      .onGet(() => {
        return this.setpoint.desired ?? this.setpoint.lastConfirmed ?? 25;
      })
      .onSet((value) => {
        this.setpoint.setDesired(value as number);
        this.log.debug(`${this.name}: desired cool setpoint=${value}`);
        void this.sync();
      });

    this.heaterCoolerService
      .addCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ maxValue: 35, minValue: 10, minStep: 1 })
      .onGet(() => {
        return this.setpoint.desired ?? this.setpoint.lastConfirmed ?? 25;
      })
      .onSet((value) => {
        this.setpoint.setDesired(value as number);
        this.log.debug(`${this.name}: desired heat setpoint=${value}`);
        void this.sync();
      });

    this.heaterCoolerService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => {
        return this.currentTemp ?? 0;
      });

    this.heaterCoolerService
      .addCharacteristic(Characteristic.SwingMode)
      .onGet(() => {
        return this.swingMode.desired ?? this.swingMode.lastConfirmed ?? 0;
      })
      .onSet((value) => {
        this.swingMode.setDesired(value as number);
        this.log.debug(`${this.name}: desired swing=${value}`);
        void this.sync();
      });
  }

  /**
   * Called on every poll with fresh cloud state. Updates HomeKit
   * characteristics and reconciles desired values that haven't confirmed.
   */
  public updateFromCloud(services: DeviceServices | null): void {
    const { Characteristic } = this.api.hap;
    if (!services) {
      this.log.warn(`${this.name}: no state from cloud on this poll.`);
      return;
    }

    this.lastState = services;

    if (services.power?.value != null) {
      this.power.onCloudValue(services.power.value);
      this.heaterCoolerService.updateCharacteristic(Characteristic.Active,
        this.power.desired ?? this.power.lastConfirmed ?? 0);
    }
    if (services.userMode?.value != null) {
      this.userMode.onCloudValue(services.userMode.value);
      this.heaterCoolerService.updateCharacteristic(
        Characteristic.TargetHeaterCoolerState,
        this.userMode.desired ?? this.userMode.lastConfirmed ?? 0);
    }
    if (services.fanSpeed?.value != null) {
      this.fanSpeed.onCloudValue(services.fanSpeed.value);
      this.heaterCoolerService.updateCharacteristic(Characteristic.RotationSpeed,
        this.fanSpeed.desired ?? this.fanSpeed.lastConfirmed ?? 0);
    }
    if (services.setpointTemp?.value != null) {
      this.setpoint.onCloudValue(services.setpointTemp.value);
      const v = this.setpoint.desired ?? this.setpoint.lastConfirmed ?? 0;
      this.heaterCoolerService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, v);
      this.heaterCoolerService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, v);
    }
    if (services.currentTemp?.value != null) {
      this.currentTemp = services.currentTemp.value;
      this.heaterCoolerService.updateCharacteristic(Characteristic.CurrentTemperature, this.currentTemp);
    }
    if (services.swingMode?.value != null) {
      this.swingMode.serviceId = services.swingMode.service_id;
      this.swingMode.onCloudValue(services.swingMode.value);
      this.heaterCoolerService.updateCharacteristic(Characteristic.SwingMode,
        this.swingMode.desired ?? this.swingMode.lastConfirmed ?? 0);
    }
  }

  /**
   * Push all unconfirmed desired values to the cloud. Called on HomeKit set
   * and periodically from the platform poller.
   *
   * Concurrent calls are coalesced: while a sync is in flight, further calls
   * mark a pending re-run rather than sending duplicate commands. `readyToSend`
   * also rate-limits per-value retries.
   */
  public async sync(): Promise<void> {
    if (this.syncInFlight) {
      // A sync is already running; ask it to run again and wait for it so the
      // caller's awaited set is actually durable before returning.
      this.syncAgain = true;
      await this.syncInFlightPromise;
      return;
    }
    let promise: Promise<void> | null = null;
    const run = async (): Promise<void> => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain);
      } finally {
        this.syncInFlight = false;
        this.syncInFlightPromise = null;
      }
    };
    this.syncInFlight = true;
    this.syncInFlightPromise = run();
    promise = this.syncInFlightPromise;
    await promise;
  }

  private syncInFlight = false;
  private syncInFlightPromise: Promise<void> | null = null;
  private syncAgain = false;

  private async syncOnce(): Promise<void> {
    const { Characteristic } = this.api.hap;
    const userId = this.lastState?.user_id;
    if (!userId) {
      this.log.warn(`${this.name}: no user id yet, can't sync.`);
      return;
    }

    const pending = [this.power, this.userMode, this.fanSpeed, this.setpoint, this.swingMode]
      .filter(d => d.needsSync);

    for (const desired of pending) {
      if (!desired.readyToSend(this.now())) {
        // Retry interval not yet elapsed; wait for a later poll.
        continue;
      }
      const result = await this.client.setValue(this.deviceId, userId, desired.serviceId, desired.toIntesis());
      desired.markSent(this.now());
      if (result.ok) {
        this.log.info(`${this.name}: set uid=${desired.serviceId} value=${desired.toIntesis()} confirmed (attempt ${desired.retryCount}).`);
        // Update HomeKit optimistically.
        if (desired === this.power) {
          this.heaterCoolerService.updateCharacteristic(Characteristic.Active, desired.desired!);
        } else if (desired === this.userMode) {
          this.heaterCoolerService.updateCharacteristic(Characteristic.TargetHeaterCoolerState, desired.desired!);
        } else if (desired === this.fanSpeed) {
          this.heaterCoolerService.updateCharacteristic(Characteristic.RotationSpeed, desired.desired!);
        } else if (desired === this.setpoint) {
          const v = desired.desired!;
          this.heaterCoolerService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, v);
          this.heaterCoolerService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, v);
        } else if (desired === this.swingMode) {
          this.heaterCoolerService.updateCharacteristic(Characteristic.SwingMode, desired.desired!);
        }
      } else {
        this.log.warn(`${this.name}: set uid=${desired.serviceId} failed (${result.reason}); will retry on next poll.`);
      }
    }
  }
}
