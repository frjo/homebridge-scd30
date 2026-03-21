# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-03-21

### Added
- Initial release
- CO₂, temperature and humidity sensor support via the Sensirion SCD30 over I²C
- Configurable temperature offset written to the SCD30 hardware register
- Configurable CO₂ threshold for the CO₂ Detected characteristic
- Configurable poll interval (also sets the SCD30 hardware measurement interval)
- Configurable automatic self-calibration (ASC)
- Configurable I²C bus number
- Persistent CO₂ peak level stored in the Homebridge storage directory
- Automatic reconnection after sensor communication failures
- StatusActive and StatusFault characteristics on all services
