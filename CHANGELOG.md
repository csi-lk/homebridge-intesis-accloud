# Changelog

## [1.0.0] - 2026-08-14

Initial release.

- From-scratch TypeScript rewrite of `homebridge-intesisweb` (based on
  [jhschuster/homebridge-intesisweb](https://github.com/jhschuster/homebridge-intesisweb)).
- Reliable command delivery: validates `setVal` responses, detects expired
  sessions (login-page-with-200) and re-logins/retries instead of silently
  dropping commands.
- Desired-state reconciliation: keeps re-sending a command on each poll until
  the cloud confirms the value changed.
- Coalesced syncs and rate-limited retries.
- Zero runtime dependencies (Node 18+ `fetch`).
- Unit-tested with 100% line coverage (Bun test runner).
