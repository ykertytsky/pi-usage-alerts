# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-04

### Added

- Pi extension that polls OpenAI Codex and Anthropic OAuth subscription usage.
- Threshold alerts for 5-hour and 7-day session windows (warning, critical, exhausted).
- In-Pi notifications and optional OS notifications (terminal OSC, Kitty, Windows Toast).
- Rate-limit detection on HTTP 402, 403, and 429 provider responses.
- `/usage-alerts` command with `status`, `check`, `refresh`, and `config` subcommands.
- Config file at `~/.pi/agent/usage-alerts.json` with safe defaults and mode `0600`.

[0.1.0]: https://github.com/ykertytsky/pi-usage-alerts/releases/tag/v0.1.0
