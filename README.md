# Waterfuse

Waterfuse is, as its name implies, a control mechanism to turn off a pump or solenoid to stop water being wasted.

It can identify slow leaks and also overruns, e.g. caused by a tap left on or a burst pipe.
It was designed to run on a RaspberryPi and has been running for years on a model 1 B+ v1.2.

## Prerequisites

- [WiringPi library](https://github.com/WiringPi/WiringPi)
- [NodeJS](https://nodejs.org) - for the notifier
- [Telegram](https://telegram.org) - for the notifier
- Water flow sensor - Hall Effect
- Relay/relay driver (see below)

## GPIO Pins

| Physical Pin | WiringPi Pin | Broadcom Pin | Usage |
| ----- | ----- | ----- | ----- |
| 1 | - | 3.3V | Power for the sensor |
| 2 | - | 5V | Power for the relay |
| 6 | - | GND | Ground |
| 11 | 0 | 17 | Flow sensor data line |
| 12 | 1 | 18 | Relay control line |
| 13 | 2 | 27 | Reset button |
| 15 | 3 | 22 | Pressure sensor input (no longer used) |

The code uses WiringPi pin numbering.

## Support files

The `notifier` directory contains a nodeJS application that uses the Telegram API to send a message when the fuse is triggered.  This is optional.

The `rpi` directory contains system support files for the code running on the Pi (or indeed any systemd-based board).  The files are:
- waterfuse.conf - a sample configuration file used to convert from ticks in the flow meter to litres, and other configurable items
- waterfuse.default - file to go in /etc/default/waterfuse to provide config for the notifier
- waterfuse-monitor - a stub file to run the notifier
- waterfuse-monitor.service - the systemd service config file for the notifier
- waterfuse.service - the systemd service config file for the waterfuse itself - note that it expects the binary to be in /usr/local/bin

## Configuration

The `/etc/waterfuse/waterfuse.conf` file is used to control the behaviour of the fuse. Values can be:

| keyword | default value | units | usage |
| ---- | ---- | ---- | ---- |
| reset_period | 600 | seconds | time to wait for activity before stopping session |
| max_time | 15 | minutes | maximum time to allow water flow  per session |
| max_litres | 200 | litres | maximum number of litres to allow per session |
| clicks_per_litre | 450 | - | Number of pulses to count from sensor to equal 1 litre |
| verbosity | 0 | - | Verbosity level in log, 0 = errors, 2 = status indication, 3 = debug |

The fuse works by reading the flow sensor and deciding if an event has occurred that would require the flow be stopped.  It has the concept of a session, which is defined as a period of activity that is bounded by a period of non-activity (the reset_period).  It then works out how many litres and how much time has occurred within that session and will trigger a stop should the limits be reached.

The reset_period can be used to identify slow leaks - setting it higher is more likely to trigger the flow rate and time limits, setting it lower avoids false triggering but is less sensitive to slow leaks.  You may need to work out your water usage patterns to identify the best values for you.



