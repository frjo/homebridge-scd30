# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-03-22

### Added
- Initial release
- CO₂, temperature and humidity sensor support via the Sensirion SCD30 over I²C
- Configurable temperature offset written to the SCD30 hardware register (corrects for sensor self-heating)
- Configurable altitude compensation written to the SCD30 hardware register
- Configurable CO₂ threshold for the CO₂ Detected characteristic
- Configurable poll interval (also sets the SCD30 hardware measurement interval)
- Configurable automatic self-calibration (ASC)
- Configurable I²C bus number
- Persistent peak CO₂ level stored in the Homebridge storage directory, with configurable reset interval (forever, daily, weekly, monthly)
- Automatic reconnection after sensor communication failures
- StatusActive and StatusFault characteristics on all services
- CarbonDioxidePeakLevel characteristic
- All sensor settings are read back from the hardware after writing and the actual values are logged.
