export interface IntesisWebConfig {
  username: string;
  password: string;
  swingMode?: 'H' | 'V';
  apiBaseURL?: string;
  configCacheSeconds?: number;
  defaultTemperature?: number;
}

export const DEFAULT_BASE_URL = 'https://accloud.intesis.com/';
export const DEFAULT_POLL_SECONDS = 30;
export const PLUGIN_NAME = 'homebridge-intesis-accloud';
export const PLATFORM_NAME = 'IntesisWeb';
