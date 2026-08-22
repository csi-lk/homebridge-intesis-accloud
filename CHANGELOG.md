# Changelog

## [1.0.12] - 2026-08-19

### Docs

- Update homebridge catalog section (#4)


## [1.0.10] - 2026-08-14

### Features

- Add bug-report guidance and debug-logging hints


## [1.0.9] - 2026-08-14

### Fixes

- Force fresh re-login when shell page persists


## [1.0.8] - 2026-08-14

### Fixes

- Handle transient shell page without device data


## [1.0.7] - 2026-08-14

### Fixes

- Improve parse diagnostics and robust userId matching


## [1.0.6] - 2026-08-14

### Chores

- Clean up duplicate changelog sections


## [1.0.5] - 2026-08-14

### Fixes

- Restore changelog heading and make prepend idempotent

## [1.0.4] - 2026-08-14

### Fixes

- Keep changelog heading at top when prepending section

### Other

- Release: automate changelog generation from conventional commits

## [1.0.3] - 2026-08-14

### Other

- Release: automate changelog generation from conventional commits

## [1.0.2] - 2026-08-14

### Other

- Release: auto-bump patch version on merge to main
- Release: clarify auto-bump logic in workflow

## [1.0.1] - 2026-08-14

- Converted plugin to ESM to match homebridge 2.3.1 (ESM-only, dynamic import).
- Updated all dev dependencies to latest (homebridge 2.3.1, TypeScript 7.0.2,
  @types/node 26, @types/bun 1.3.14).
- Release workflow now runs on merge to main with automatic patch version bump,
  npm publish via trusted publishing (OIDC), git tag, and GitHub release.

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
