import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { SCD30Accessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class SCD30Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    const uuid = this.api.hap.uuid.generate('scd30-sensor');
    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      this.log.info('Restoring SCD30 from cache:', existingAccessory.displayName);
      new SCD30Accessory(this, existingAccessory);
    } else {
      this.log.info('Adding SCD30 accessory');
      const accessory = new this.api.platformAccessory(this.config.name as string, uuid);
      new SCD30Accessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // Unregister any stale accessories in the cache that are no longer present
    for (const [cachedUuid, accessory] of this.accessories) {
      if (cachedUuid !== uuid) {
        this.log.info('Removing stale accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
