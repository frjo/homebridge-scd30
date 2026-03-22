import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { SCD30Platform } from './platform.js';
import { SCD30 } from 'scd30-node';

const MAX_CONSECUTIVE_ERRORS = 3;
const RECONNECT_DELAY_MS = 60000;

export class SCD30Accessory {
  private readonly co2Service: Service;
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private readonly peakStorageFile: string;
  private sensor: SCD30 | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;
  private isShuttingDown = false;
  private peakLoaded = false;

  // Cached values for onGet handlers
  private co2Threshold = 1000;
  private peakResetInterval = 'forever';
  private lastCO2 = 0;
  private lastPeakCO2 = 0;
  private peakTimestamp = 0;
  private lastTemperature = 0;
  private lastHumidity = 0;
  private hasValidReading = false;

  constructor(
    private readonly platform: SCD30Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.peakStorageFile = join(this.platform.api.user.storagePath(), 'homebridge-scd30.json');

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sensirion')
      .setCharacteristic(this.platform.Characteristic.Model, 'SCD30')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'N/A');

    this.co2Service = this.accessory.getService(this.platform.Service.CarbonDioxideSensor)
      || this.accessory.addService(this.platform.Service.CarbonDioxideSensor);
    this.co2Service.setCharacteristic(this.platform.Characteristic.Name, 'CO₂');

    this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor);
    this.temperatureService.setCharacteristic(this.platform.Characteristic.Name, 'Temperature');

    this.humidityService = this.accessory.getService(this.platform.Service.HumiditySensor)
      || this.accessory.addService(this.platform.Service.HumiditySensor);
    this.humidityService.setCharacteristic(this.platform.Characteristic.Name, 'Humidity');

    // StatusActive starts false until sensor connects and provides a reading
    for (const service of [this.co2Service, this.temperatureService, this.humidityService]) {
      service.setCharacteristic(this.platform.Characteristic.StatusActive, false);
      service.setCharacteristic(this.platform.Characteristic.StatusFault,
        this.platform.Characteristic.StatusFault.NO_FAULT);
    }

    // Register onGet handlers to return last cached values
    this.co2Service.getCharacteristic(this.platform.Characteristic.CarbonDioxideLevel)
      .onGet(() => this.getCachedOrError(this.lastCO2));

    this.co2Service.getCharacteristic(this.platform.Characteristic.CarbonDioxideDetected)
      .onGet(() => this.getCachedOrError(
        this.lastCO2 >= this.co2Threshold
          ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
          : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
      ));

    this.co2Service.getCharacteristic(this.platform.Characteristic.CarbonDioxidePeakLevel)
      .onGet(() => this.getCachedOrError(this.lastPeakCO2));

    this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.getCachedOrError(this.lastTemperature));

    this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.getCachedOrError(this.lastHumidity));

    this.platform.api.on('shutdown', () => this.shutdown());

    this.initialize().catch(err => {
      this.platform.log.error('Failed to initialize SCD30:', err);
      this.scheduleReconnect();
    });
  }

  private getCachedOrError(value: CharacteristicValue): CharacteristicValue {
    if (!this.hasValidReading) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return value;
  }

  private isPeakExpired(): boolean {
    if (this.peakResetInterval === 'forever') {
      return false;
    }
    const intervals: Record<string, number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
    };
    return Date.now() - this.peakTimestamp > (intervals[this.peakResetInterval] ?? 0);
  }

  private async loadPeakCO2(): Promise<number> {
    try {
      const data = JSON.parse(await readFile(this.peakStorageFile, 'utf-8'));
      const peak = typeof data.peakCO2 === 'number' && isFinite(data.peakCO2) ? data.peakCO2 : 0;
      this.peakTimestamp = typeof data.peakTimestamp === 'number' ? data.peakTimestamp : 0;
      if (this.isPeakExpired()) {
        this.platform.log.info('Peak CO₂ reset (interval expired)');
        this.peakTimestamp = 0;
        return 0;
      }
      return peak;
    } catch {
      return 0;
    }
  }

  private async savePeakCO2(value: number): Promise<void> {
    this.peakTimestamp = Date.now();
    try {
      await writeFile(this.peakStorageFile, JSON.stringify({ peakCO2: value, peakTimestamp: this.peakTimestamp }));
    } catch (err) {
      this.platform.log.warn('Failed to save peak CO2 to storage:', err);
    }
  }

  private async initialize() {
    const busNumber = (this.platform.config.i2c_bus as number | undefined) ?? 1;
    const temperatureOffset = (this.platform.config.temperature_offset as number | undefined) ?? 0;
    const autoCalibration = (this.platform.config.auto_calibration as boolean | undefined) ?? true;
    this.co2Threshold = (this.platform.config.co2_threshold as number | undefined) ?? 1000;
    this.peakResetInterval = (this.platform.config.peak_reset as string | undefined) ?? 'forever';

    const rawPollInterval = (this.platform.config.poll_interval as number | undefined) ?? 10;
    const pollInterval = Math.min(1800, Math.max(2, rawPollInterval));
    if (pollInterval !== rawPollInterval) {
      this.platform.log.warn(`poll_interval ${rawPollInterval}s is out of range (2–1800), clamped to ${pollInterval}s`);
    }

    if (!this.peakLoaded) {
      this.lastPeakCO2 = await this.loadPeakCO2();
      this.peakLoaded = true;
      this.platform.log.debug(`Loaded peak CO2 from storage: ${this.lastPeakCO2} ppm`);
    }

    this.sensor = await SCD30.connect(busNumber);

    const firmwareVersion = await this.sensor.getFirmwareVersion();
    this.platform.log.info(`Connected to SCD30, firmware: ${firmwareVersion}`);
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, firmwareVersion);

    if (temperatureOffset !== 0) {
      await this.sensor.setTemperatureOffset(temperatureOffset);
      this.platform.log.info(`Temperature offset set to ${temperatureOffset}°C`);
    }

    await this.sensor.setAutomaticSelfCalibration(autoCalibration);
    this.platform.log.info(`Automatic self-calibration ${autoCalibration ? 'enabled' : 'disabled'}`);

    await this.sensor.setMeasurementInterval(pollInterval);
    await this.sensor.startContinuousMeasurement();
    this.platform.log.info('SCD30 continuous measurement started');

    this.consecutiveErrors = 0;
    this.startPolling(pollInterval * 1000);
  }

  private scheduleReconnect() {
    if (this.isShuttingDown) {
      return;
    }
    this.platform.log.info(`Reconnecting to SCD30 in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(() => {
      if (this.isShuttingDown) {
        return;
      }
      this.initialize().catch(err => {
        this.platform.log.error('Reconnection failed:', err);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private async shutdown() {
    this.isShuttingDown = true;
    this.platform.log.info('Shutting down SCD30');
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.sensor) {
      try {
        await this.sensor.stopContinuousMeasurement();
        await this.sensor.disconnect();
      } catch (err) {
        this.platform.log.error('Error during SCD30 shutdown:', err);
      }
      this.sensor = null;
    }
  }

  private setActive() {
    for (const service of [this.co2Service, this.temperatureService, this.humidityService]) {
      service.updateCharacteristic(this.platform.Characteristic.StatusActive, true);
      service.updateCharacteristic(this.platform.Characteristic.StatusFault,
        this.platform.Characteristic.StatusFault.NO_FAULT);
    }
  }

  private setNotResponding() {
    this.hasValidReading = false;
    const error = new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    for (const service of [this.co2Service, this.temperatureService, this.humidityService]) {
      service.updateCharacteristic(this.platform.Characteristic.StatusActive, false);
      service.updateCharacteristic(this.platform.Characteristic.StatusFault,
        this.platform.Characteristic.StatusFault.GENERAL_FAULT);
    }
    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, error);
    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideDetected, error);
    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxidePeakLevel, error);
    this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, error);
    this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, error);
  }

  private startPolling(intervalMs: number) {
    this.pollTimer = setInterval(async () => {
      try {
        if (!this.sensor || !await this.sensor.isDataReady()) {
          return;
        }

        const m = await this.sensor.readMeasurement();
        const co2 = Math.round(m.co2Concentration);

        if (!isFinite(co2) || !isFinite(m.temperature) || !isFinite(m.relativeHumidity)) {
          this.platform.log.warn(`Invalid measurement received (CO2: ${m.co2Concentration}, Temp: ${m.temperature}, Humidity: ${m.relativeHumidity}), skipping`);
          return;
        }

        this.consecutiveErrors = 0;
        this.lastCO2 = co2;
        this.lastTemperature = m.temperature;
        this.lastHumidity = m.relativeHumidity;

        if (this.lastPeakCO2 > 0 && this.isPeakExpired()) {
          this.platform.log.info('Peak CO₂ reset (interval expired)');
          this.lastPeakCO2 = 0;
          this.peakTimestamp = 0;
        }

        if (co2 > this.lastPeakCO2) {
          this.lastPeakCO2 = co2;
          this.savePeakCO2(co2).catch(err => this.platform.log.warn('Failed to save peak CO2:', err));
        }

        if (!this.hasValidReading) {
          this.hasValidReading = true;
          this.setActive();
        }

        this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, co2);
        this.co2Service.updateCharacteristic(
          this.platform.Characteristic.CarbonDioxideDetected,
          co2 >= this.co2Threshold
            ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
            : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
        );
        this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxidePeakLevel, this.lastPeakCO2);
        this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, m.temperature);
        this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, m.relativeHumidity);

        this.platform.log.debug(`CO2: ${co2} ppm (peak: ${this.lastPeakCO2} ppm), Temp: ${m.temperature.toFixed(1)}°C, Humidity: ${m.relativeHumidity.toFixed(1)}%`);
      } catch (err) {
        this.consecutiveErrors++;
        this.platform.log.error(`Error reading from SCD30 (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err);
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.setNotResponding();
          clearInterval(this.pollTimer!);
          this.pollTimer = null;
          if (this.sensor) {
            try {
              await this.sensor.stopContinuousMeasurement();
              await this.sensor.disconnect();
            } catch { /* sensor may already be unreachable */ }
            this.sensor = null;
          }
          this.scheduleReconnect();
        }
      }
    }, intervalMs);
  }
}
