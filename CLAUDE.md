# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Waterfuse is a Raspberry Pi water flow protection daemon. It monitors a flow meter via GPIO interrupt and cuts power to a water pump relay if flow exceeds configurable volume or time limits. A companion Node.js notifier posts state changes to Slack.

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

Node.js script (`index.js`) that watches `/run/waterfuse/` with `fs.watch` and posts to a Telegram chat when the state file changes. Also supports bot commands via long polling.

Required environment variables: `telegramToken` (bot token from BotFather), `telegramChatId` (numeric chat ID of the target chat).

```bash
cd notifier
npm install
telegramToken=123:ABC telegramChatId=-100... node index.js
```

**Bot commands** (only accepted from the configured `telegramChatId`):
- `/reset` — sends `SIGUSR1` to the daemon; clears the stop condition and restarts the pump
- `/usage` — sends `SIGUSR2` to the daemon, tails the log to read `total_litres`, and reports accumulated pump run time

Run-time tracking (`pumpStartTime`, `accumulatedRunMs`) is held in process memory; it seeds from the current state file at startup to survive restarts, but accumulated cross-session totals reset if the notifier is restarted.
