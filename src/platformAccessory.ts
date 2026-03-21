import type { PlatformAccessory, Service } from 'homebridge';
import type { SCD30Platform } from './platform.js';
import { SCD30 } from 'scd30-node';

const MAX_CONSECUTIVE_ERRORS = 3;

export class SCD30Accessory {
  private readonly co2Service: Service;
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private sensor: SCD30 | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;

  constructor(
    private readonly platform: SCD30Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sensirion')
      .setCharacteristic(this.platform.Characteristic.Model, 'SCD30')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'N/A');

    this.co2Service = this.accessory.getService(this.platform.Service.CarbonDioxideSensor)
      || this.accessory.addService(this.platform.Service.CarbonDioxideSensor);

    this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor);

    this.humidityService = this.accessory.getService(this.platform.Service.HumiditySensor)
      || this.accessory.addService(this.platform.Service.HumiditySensor);

    this.initialize().catch(err => this.platform.log.error('Failed to initialize SCD30:', err));
  }

  private async initialize() {
    const busNumber = (this.platform.config.i2c_bus as number | undefined) ?? 1;
    const temperatureOffset = (this.platform.config.temperature_offset as number | undefined) ?? 0;
    const autoCalibration = (this.platform.config.auto_calibration as boolean | undefined) ?? true;
    const co2Threshold = (this.platform.config.co2_threshold as number | undefined) ?? 1000;

    const rawPollInterval = (this.platform.config.poll_interval as number | undefined) ?? 10;
    const pollInterval = Math.min(1800, Math.max(2, rawPollInterval));
    if (pollInterval !== rawPollInterval) {
      this.platform.log.warn(`poll_interval ${rawPollInterval}s is out of range (2–1800), clamped to ${pollInterval}s`);
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

    this.platform.api.on('shutdown', () => this.shutdown());

    this.startPolling(pollInterval * 1000, co2Threshold);
  }

  private async shutdown() {
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

  private setNotResponding() {
    const error = new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, error);
    this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideDetected, error);
    this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, error);
    this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, error);
  }

  private startPolling(intervalMs: number, co2Threshold: number) {
    this.pollTimer = setInterval(async () => {
      try {
        if (!this.sensor || !await this.sensor.isDataReady()) {
          return;
        }

        const m = await this.sensor.readMeasurement();
        const co2 = Math.round(m.co2Concentration);

        this.consecutiveErrors = 0;

        this.co2Service.updateCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, co2);
        this.co2Service.updateCharacteristic(
          this.platform.Characteristic.CarbonDioxideDetected,
          co2 >= co2Threshold
            ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
            : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
        );
        this.temperatureService.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, m.temperature);
        this.humidityService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, m.humidity);

        this.platform.log.debug(`CO2: ${co2} ppm, Temp: ${m.temperature.toFixed(1)}°C, Humidity: ${m.humidity.toFixed(1)}%`);
      } catch (err) {
        this.consecutiveErrors++;
        this.platform.log.error(`Error reading from SCD30 (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err);
        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.setNotResponding();
        }
      }
    }, intervalMs);
  }
}
