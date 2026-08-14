import { API } from 'homebridge';
import { IntesisWebPlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, IntesisWebPlatform);
};
