## [1.0.3] - 2026-08-14

## [1.0.4] - 2026-08-14

### Fixes

- Keep changelog heading at top when prepending section


### Other

- Release: automate changelog generation from conventional commits


# Changelog

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