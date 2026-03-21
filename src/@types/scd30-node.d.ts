declare module 'scd30-node' {
  export interface Measurement {
    co2Concentration: number;
    temperature: number;
    humidity: number;
  }

  export class SCD30 {
    static connect(busNumber?: number): Promise<SCD30>;
    disconnect(): Promise<void>;
    startContinuousMeasurement(pressure?: number): Promise<void>;
    stopContinuousMeasurement(): Promise<void>;
    isDataReady(): Promise<boolean>;
    readMeasurement(): Promise<Measurement>;
    setMeasurementInterval(interval: number): Promise<void>;
    getMeasurementInterval(): Promise<number>;
    setTemperatureOffset(offset: number): Promise<void>;
    getTemperatureOffset(): Promise<number>;
    setAltitudeCompensation(altitude: number): Promise<void>;
    getAltitudeCompensation(): Promise<number>;
    setAutomaticSelfCalibration(enable?: boolean): Promise<void>;
    isAutomaticSelfCalibrationActive(): Promise<boolean>;
    setForcedRecalibrationValue(co2ppm: number): Promise<void>;
    getForcedRecalibrationValue(): Promise<number>;
    getFirmwareVersion(): Promise<string>;
    softReset(): Promise<void>;
  }
}
