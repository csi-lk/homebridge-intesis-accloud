import type { API } from 'homebridge';

/**
 * A minimal in-memory stand-in for the HAP Service/Characteristic API used by
 * the plugin. Keeps tests hermetic and dependency-free while exercising the
 * same method surface (get/add characteristic, onGet/onSet, updateValue).
 */

const CHARACTERISTICS = {
  Active: 1,
  TargetHeaterCoolerState: 2,
  CurrentHeaterCoolerState: 3,
  RotationSpeed: 4,
  CoolingThresholdTemperature: 5,
  HeatingThresholdTemperature: 6,
  CurrentTemperature: 7,
  SwingMode: 8,
  TemperatureDisplayUnits: 9,
  Manufacturer: 10,
  Model: 11,
  SerialNumber: 12,
  Name: 13,
} as const;

const SERVICES = {
  HeaterCooler: 'HeaterCooler',
  AccessoryInformation: 'AccessoryInformation',
} as const;

type CharId = number;
type CharValue = unknown;

interface FakeChar {
  id: CharId;
  props: Record<string, unknown>;
  value: CharValue;
  onGetCb?: () => CharValue;
  onSetCb?: (v: CharValue) => void;
  onGet(fn: () => CharValue): FakeChar;
  onSet(fn: (v: CharValue) => void): FakeChar;
  setProps(props: Record<string, unknown>): FakeChar;
  updateValue(v: CharValue): FakeChar;
  setValue(v: CharValue): void;
  getValue(): CharValue;
}

function makeCharacteristic(id: CharId): FakeChar {
  const c: FakeChar = {
    id,
    props: {},
    value: undefined,
    onGet(fn) { this.onGetCb = fn; return this; },
    onSet(fn) { this.onSetCb = fn; return this; },
    setProps(props) { this.props = { ...this.props, ...props }; return this; },
    updateValue(v) { this.value = v; return this; },
    setValue(v) { this.value = v; this.onSetCb?.(v); },
    getValue() { return this.onGetCb ? this.onGetCb() : this.value; },
  };
  return c;
}

interface FakeService {
  name: string;
  chars: Map<number, FakeChar>;
  getCharacteristic(id: CharId): FakeChar;
  addCharacteristic(id: CharId): FakeChar;
  updateCharacteristic(id: CharId, v: CharValue): FakeService;
  setCharacteristic(id: CharId, v: CharValue): FakeService;
}

/** Resolve a Characteristic "class" (function or object with __id) to its numeric id. */
function resolveId(id: CharId): number {
  if (id !== null && typeof id === 'object' && (id as { __id?: number }).__id != null) {
    return (id as { __id: number }).__id;
  }
  if (typeof id === 'function') {
    const fn = id as unknown as { __id?: number };
    if (fn.__id != null) {
      return fn.__id;
    }
  }
  return id as number;
}

function makeService(name: string, defaultChars: CharId[]): FakeService {
  const s: FakeService = {
    name,
    chars: new Map(),
    getCharacteristic(id) {
      const cid = resolveId(id);
      let c = this.chars.get(cid);
      if (!c) {
        c = makeCharacteristic(cid);
        this.chars.set(cid, c);
      }
      return c;
    },
    addCharacteristic(id) {
      const cid = resolveId(id);
      if (this.chars.has(cid)) {
        throw new Error(`Characteristic ${cid} already exists in ${name}`);
      }
      const c = makeCharacteristic(cid);
      this.chars.set(cid, c);
      return c;
    },
    updateCharacteristic(id, v) {
      this.getCharacteristic(id).value = v;
      return this;
    },
    setCharacteristic(id, v) {
      this.getCharacteristic(id).value = v;
      return this;
    },
  };
  defaultChars.forEach(id => s.chars.set(resolveId(id), makeCharacteristic(resolveId(id))));
  return s;
}

function makeServiceClass(name: string, defaultChars: CharId[]) {
  const Cls = class {
    constructor() {
      return makeService(name, defaultChars);
    }
  } as unknown as typeof FakeService;
  return Cls;
}

function makeCharacteristicClass(id: CharId) {
  // Return a fresh function each time so each Characteristic "class" carries
  // its own __id and enum constants without sharing state.
  const cls = (function (cid: number) {
    return function characteristic() {
      return makeCharacteristic(cid);
    };
  })(id);
  return Object.assign(cls, {
    ACTIVE: 1,
    INACTIVE: 0,
    AUTO: 0,
    HEAT: 1,
    COOL: 2,
    SWING_ENABLED: 1,
    SWING_DISABLED: 0,
    __id: id,
  });
}

const Service = {
  HeaterCooler: makeServiceClass(SERVICES.HeaterCooler, [
    CHARACTERISTICS.Active,
    CHARACTERISTICS.CurrentHeaterCoolerState,
    CHARACTERISTICS.CurrentTemperature,
    CHARACTERISTICS.TargetHeaterCoolerState,
  ]),
  AccessoryInformation: makeServiceClass(SERVICES.AccessoryInformation, [
    CHARACTERISTICS.Manufacturer,
    CHARACTERISTICS.Model,
    CHARACTERISTICS.SerialNumber,
    CHARACTERISTICS.Name,
  ]),
};

const Characteristic = {
  Active: makeCharacteristicClass(CHARACTERISTICS.Active),
  TargetHeaterCoolerState: makeCharacteristicClass(CHARACTERISTICS.TargetHeaterCoolerState),
  CurrentHeaterCoolerState: makeCharacteristicClass(CHARACTERISTICS.CurrentHeaterCoolerState),
  RotationSpeed: makeCharacteristicClass(CHARACTERISTICS.RotationSpeed),
  CoolingThresholdTemperature: makeCharacteristicClass(CHARACTERISTICS.CoolingThresholdTemperature),
  HeatingThresholdTemperature: makeCharacteristicClass(CHARACTERISTICS.HeatingThresholdTemperature),
  CurrentTemperature: makeCharacteristicClass(CHARACTERISTICS.CurrentTemperature),
  SwingMode: makeCharacteristicClass(CHARACTERISTICS.SwingMode),
  TemperatureDisplayUnits: makeCharacteristicClass(CHARACTERISTICS.TemperatureDisplayUnits),
  Manufacturer: makeCharacteristicClass(CHARACTERISTICS.Manufacturer),
  Model: makeCharacteristicClass(CHARACTERISTICS.Model),
  SerialNumber: makeCharacteristicClass(CHARACTERISTICS.SerialNumber),
  Name: makeCharacteristicClass(CHARACTERISTICS.Name),
};

function makePlatformAccessory(displayName: string, uuid: string) {
  const services: FakeService[] = [];
  return {
    displayName,
    UUID: uuid,
    context: {} as Record<string, unknown>,
    addService(svc: FakeService) { services.push(svc); return svc; },
    getService(svc: { name: string }) { return services.find(s => s.name === svc.name) ?? undefined; },
    removeService(svc: FakeService) {
      const i = services.indexOf(svc);
      if (i >= 0) services.splice(i, 1);
    },
    services,
  };
}

const fakeHap = {
  Service,
  Characteristic,
  uuid: { generate: (s: string) => `uuid-${s}` },
  PlatformAccessory: makePlatformAccessory,
} as unknown as API['hap'];

/**
 * Build a fake Homebridge `API` backed by our in-memory HAP stand-in.
 */
export function makeFakeApi(): API {
  const events = new Map<string, Array<() => void>>();

  return {
    hap: fakeHap,
    platformAccessory: makePlatformAccessory as unknown as API['platformAccessory'],
    registerPlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
    registerPlatform: () => {},
    on: ((event: string, cb: () => void) => {
      const list = events.get(event) ?? [];
      list.push(cb);
      events.set(event, list);
    }) as API['on'],
  } as unknown as API;
}

export function makeFakeLogger(): { debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void } {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
