import type { PlatformAccessory, Service } from 'homebridge';
import type { SCD30Platform } from './platform.js';
import { SCD30 } from 'scd30-node';


export class SCD30Accessory {
  private readonly co2Service: Service;
  private readonly temperatureService: Service;
  private readonly humidityService: Service;
  private sensor: SCD30 | null = null;

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
    const pollIntervalMs = ((this.platform.config.poll_interval as number | undefined) ?? 10) * 1000;
    const co2Threshold = (this.platform.config.co2_threshold as number | undefined) ?? 1000;

    this.sensor = await SCD30.connect(busNumber);
    this.platform.log.info('Connected to SCD30');

    if (temperatureOffset !== 0) {
      await this.sensor.setTemperatureOffset(temperatureOffset);
      this.platform.log.info(`Temperature offset set to ${temperatureOffset}°C`);
    }

    await this.sensor.setMeasurementInterval(pollIntervalMs / 1000);
    await this.sensor.startContinuousMeasurement();
    this.platform.log.info('SCD30 continuous measurement started');

    this.startPolling(pollIntervalMs, co2Threshold);
  }

  private startPolling(intervalMs: number, co2Threshold: number) {
    setInterval(async () => {
      try {
        if (!this.sensor || !await this.sensor.isDataReady()) {
          return;
        }

        const m = await this.sensor.readMeasurement();
        const co2 = Math.round(m.co2Concentration);

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
        this.platform.log.error('Error reading from SCD30:', err);
      }
    }, intervalMs);
  }
}
