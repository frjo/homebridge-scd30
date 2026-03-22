# Homebridge SCD30 sensor plugin

A [Homebridge](https://homebridge.io) plugin for the [Sensirion SCD30](https://sensirion.com/products/catalog/SCD30/) CO₂, temperature and humidity sensor. Exposes the sensor readings to Apple HomeKit via three native services: CO₂ sensor, temperature sensor, and humidity sensor.

## Requirements

- Homebridge v1.8 or v2
- Node.js 20, 22, or 24
- SCD30 sensor connected via I²C (tested on Raspberry Pi)
- I²C enabled on the host (`raspi-config` → Interface Options → I2C)
- The Homebridge process must have read/write access to the I²C bus device (e.g. `/dev/i2c-1`). On Raspberry Pi OS, add the homebridge user to the `i2c` group:

```sh
sudo usermod -aG i2c homebridge
```

## Installation

Install through the Homebridge UI, search for "scd30".


### Configuration options

| Parameter | Type | Default | Description |
|---|---|---|---|
| `platform` | string | — | Must be `SCD30` |
| `name` | string | `SCD30` | Display name for the accessory |
| `temperature_offset` | number | `0` | Temperature offset in °C written to the SCD30 hardware register to compensate for sensor self-heating. Typical values: 0–5. |
| `i2c_bus` | integer | `1` | I²C bus number the sensor is connected to. On Raspberry Pi this is usually `1`. |
| `poll_interval` | integer | `10` | How often the sensor measures and is polled, in seconds. Valid range: 2–1800. |
| `co2_threshold` | integer | `1000` | CO₂ level in ppm at which the CO₂ Detected characteristic switches to abnormal. |
| `auto_calibration` | boolean | `true` | Enable the SCD30 automatic self-calibration (ASC). Disable if the sensor is not regularly exposed to fresh outdoor air (~400 ppm). |
| `peak_reset` | string | `forever` | How often the peak CO₂ level resets. Options: `forever`, `daily` (24 h), `weekly` (7 days), `monthly` (30 days). |

### Temperature offset

The SCD30 is known to read slightly high on temperature due to self-heating from the onboard CO₂ measurement. The `temperature_offset` is written directly to the sensor's hardware compensation register (persists across power cycles), so the corrected value is what HomeKit receives. Start with `0` and increase in small steps (e.g. `2`) until the reading matches a reference thermometer.

## HomeKit accessories

The plugin registers a single accessory with three services:

| Service | Characteristics |
|---|---|
| CO₂ Sensor | CO₂ level (ppm), CO₂ detected (configurable threshold, default: 1000 ppm) |
| Temperature Sensor | Current temperature (°C) |
| Humidity Sensor | Current relative humidity (%) |

Readings are polled on a configurable interval (default: 10 seconds) using the SCD30's built-in data-ready flag.

## Hardware

The SCD30 communicates over I²C at address `0x61`. Connect it to the Raspberry Pi as follows:

| SCD30 pin | Raspberry Pi pin |
|---|---|
| VDD | 3.3 V (pin 1) |
| SDA | SDA (pin 3 / GPIO 2) |
| SCL | SCL (pin 5 / GPIO 3) |
| GND | GND (pin 6 or 9) |

## License

Apache-2.0
