# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Waterfuse is a Raspberry Pi water flow protection daemon. It monitors a flow meter via GPIO interrupt and cuts power to a water pump relay if flow exceeds configurable volume or time limits. A companion Node.js notifier posts state changes to Telegram.

## Build & Install

```bash
# Build
make

# Install (stops service, replaces binary, restarts service)
make install
```

Depends on the `wiringPi` library (`-lwiringPi`). Must be built and run on a Raspberry Pi (or compatible wiringPi-supported board).

## Running

```bash
# Run in foreground (don't daemonize)
./waterfuse -d

# Increase verbosity (repeat for higher levels; 3 is very chatty)
./waterfuse -d -v -v -v

# Override config at runtime
./waterfuse -l <max_litres> -c <clicks_per_litre> -t <max_minutes> -r <reset_seconds>
```

When daemonized, logs go to `/var/log/waterfuse.log`. PID file: `/run/waterfuse/waterfuse.pid`. State file: `/run/waterfuse/waterfuse.state`.

## Configuration

Config file: `/etc/waterfuse/waterfuse.conf` — key/value pairs, one per line:

| Key | Default | Description |
|-----|---------|-------------|
| `clicks_per_litre` | 450 | Pulses from flow meter per litre |
| `max_litres` | 200 | Volume limit before shutoff |
| `max_time` | 15 (minutes) | Time limit before shutoff |
| `reset_period` | 600 | Seconds of no-flow before counters reset |
| `verbosity` | 0 | Log verbosity (0=minimal, 3=debug) |

Config is re-read on `SIGHUP` (which also rolls the log).

## Deployment support files (`rpi/`)

The `rpi/` directory contains systemd unit files and config templates for deploying on the Pi:

| File | Deploy to | Purpose |
|------|-----------|---------|
| `waterfuse.conf` | `/etc/waterfuse/waterfuse.conf` | Sample daemon config |
| `waterfuse.default` | `/etc/default/waterfuse` | Notifier env vars (`telegramToken`, `totpSecret`, `waterfuseHome`) |
| `waterfuse-monitor` | `/usr/local/bin/waterfuse-monitor` | Wrapper that sources `/etc/default/waterfuse` and launches the notifier |
| `waterfuse.service` | `/etc/systemd/system/` | systemd unit for the daemon; expects binary at `/usr/local/bin/waterfuse` |
| `waterfuse-monitor.service` | `/etc/systemd/system/` | systemd unit for the notifier; starts after `waterfuse.service` |

To **disable** the daemon without removing the service, create `/etc/waterfuse/waterfuse.off` (the service has `ConditionPathExists=!/etc/waterfuse/waterfuse.off`).

## Architecture

### `waterfuse.c` — the main daemon

Single-file C program. Key design points:

- **GPIO pins** (wiringPi numbering): `FLOW_METER=0`, `POWER_RELAY=1`, `RESET_BUTTON=2`
- **ISR** (`handleClick`): increments volatile `clicks` counter on each rising edge from the flow meter
- **Main loop** (1 second tick): checks `clicks` delta against limits; drives the relay HIGH (pump on) or LOW (pump off)
- **State machine**: `counting` tracks whether flow is active; `triggered` means the relay has been shut off and awaits a reset
- **Reset sources**: physical button (polled, pin 2), `SIGUSR1` signal, or `reset=2` via `SIGUSR2`-adjacent logic
- **Shutdown triggers**: exceed `max_litres` (reason: "volume") or exceed `time_limit` seconds of continuous flow (reason: "time")
- **Signal handling**: `SIGHUP`=reopen log+reread config, `SIGUSR1`=reset pump on, `SIGUSR2`=print stats, `SIGCONT`=force pump off

State file format (two tab-separated words): `started\t<reason>` or `stopped\t<reason>`.

### `notifier/` — Telegram notification service

Node.js script (`index.js`) that watches `/run/waterfuse/` with `fs.watch` and broadcasts to all authorized Telegram chats when the state file changes. Commands are received via long polling.

**Environment variables:**
- `telegramToken` — bot token from BotFather (required)
- `totpSecret` — base32-encoded TOTP secret shared with authorized users (required)
- `authFile` — path to persist authorized chat IDs (default: `/etc/waterfuse/authorized_chats.json`)

In production these are sourced from `/etc/default/waterfuse` (see `rpi/waterfuse.default`) by the `waterfuse-monitor` wrapper script, which is deployed to `/usr/local/bin/waterfuse-monitor` and managed by `waterfuse-monitor.service`.

```bash
# Generate a TOTP secret
node -e "const {Secret}=require('otpauth'); const s=new Secret(); console.log(s.base32)"

cd notifier
npm install
telegramToken=123:ABC totpSecret=BASE32SECRET node index.js
# On startup, prints an otpauth:// URI — scan it with any authenticator app
```

**Bot commands:**
- `/auth <code>` — validates a TOTP code; on success adds the sender to the authorized set (available to anyone)
- `/deauth` — removes the sender from the authorized set
- `/reset` — sends `SIGUSR1` to the daemon to clear the stop condition and restart the pump (authorized only)
- `/usage` — sends `SIGUSR2` to the daemon, tails the log for `total_litres`, and reports accumulated pump run time (authorized only)

Unauthorized senders are silently ignored for all commands except `/auth`. Authorized chat IDs are persisted to `authFile` and loaded on startup. Run-time accumulation (`pumpStartTime`, `accumulatedRunMs`) seeds from the current state file on startup but resets if the notifier process is restarted.
