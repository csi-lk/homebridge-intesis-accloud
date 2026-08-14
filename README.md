# Homebridge Intesis AC Cloud

[![Build & Test](https://github.com/csi-lk/homebridge-intesis-accloud/actions/workflows/ci.yml/badge.svg)](https://github.com/csi-lk/homebridge-intesis-accloud/actions/workflows/ci.yml)

Homebridge plugin for controlling **IntesisHome** AC controllers through the
Intesis cloud (accloud.intesis.com). Built in **TypeScript**, run with **Bun**,
and covered by **unit tests with 100% line coverage**.

> **Based on** [jhschuster/homebridge-intesisweb](https://github.com/jhschuster/homebridge-intesisweb)
> — a huge thanks to Jay Schuster and the original contributors for reverse
> engineering the Intesis web interface and writing the original plugin. This
> project is a from-scratch TypeScript rewrite that keeps the same protocol but
> adds reliable command delivery.

## Why a rewrite?

The original plugin had a critical reliability bug: when the Intesis cloud
session expires, `device/setVal` responds with **HTTP 200 plus a login page**
instead of the expected `OK`. The original treated any truthy response as
success, so HomeKit would report the change as applied while the cloud never
received the command — and it never retried.

This rewrite:

- **Validates every `setVal` response** and detects the login-page / expired
  session signature, forcing a re-login and retry.
- **Tracks desired state** — when you change something in Apple Home, the
  plugin records it and keeps sending it on every poll until the cloud
  confirms the value actually changed. It never silently gives up.
- **Coalesces concurrent syncs** and rate-limits retries so the cloud is never
  hammered.
- **Zero runtime dependencies** — uses Node's built-in `fetch` and a small
  cookie jar.

## Features

- Power on/off
- Mode (auto / heat / cool)
- Fan speed (0–4)
- Target temperature (cooling & heating thresholds)
- Swing mode (horizontal or vertical vanes)
- Current temperature reporting
- Background polling with configurable interval (default 30s)
- Automatic re-login and command retry

## Installation

```sh
npm install -g homebridge-intesis-accloud
```

Or install it via the Homebridge UI: **Settings → Plugins → Search for
"Intesis AC Cloud"** → Install.

## Configuration

Add the platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "IntesisWeb",
      "username": "your-intesis-username",
      "password": "your-intesis-password",
      "swingMode": "H",
      "configCacheSeconds": 30
    }
  ]
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `username` | string | — | Intesis account username (**required**) |
| `password` | string | — | Intesis account password (**required**) |
| `swingMode` | `"H"` or `"V"` | `"H"` | Which vane the swing control affects |
| `apiBaseURL` | string | `https://accloud.intesis.com/` | Base URL of the Intesis site |
| `configCacheSeconds` | integer | `30` | Polling interval (seconds) |
| `defaultTemperature` | integer | `0` | Default current temp (°C) when no reading is available; `0` uses the setpoint |

> **Note:** this is a cloud-control plugin. It talks to the Intesis **cloud**
> (via your IntesisHome/AC Cloud account), not to a local IntesisBox or
> LAN-capable WiFi module.

## Development

Requirements: [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install        # install dependencies
bun test           # run tests + enforce 100% coverage
bun run build      # compile TypeScript -> dist/
bun run lint       # type-check without emitting
```

## Publishing

Releases are fully automated via GitHub Actions:

1. **CI workflow** (`.github/workflows/ci.yml`) runs on every push/PR —
   installs deps, runs the test suite with coverage, and builds.
2. **Release workflow** (`.github/workflows/release.yml`) runs on every merge
   to `main`. It builds, runs tests, and then:
   - If the `version` in `package.json` is **already published**, it
     auto-bumps the **patch** version (`1.0.1` → `1.0.2`).
   - It auto-generates a `CHANGELOG.md` entry from your conventional commits
     since the last release, publishes to **npm** (via trusted publishing),
     commits the version bump + changelog back, tags `v<version>`, and creates
     a **GitHub release**.
   - If you bumped the version yourself (e.g. `npm version minor`), it
     publishes that exact version without auto-bumping.

To make the auto-generated changelog useful, use conventional commit
prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`,
`perf:`, `build:`.

So to cut a release you just merge to `main` — the patch bump, npm publish,
git tag, and GitHub release all happen automatically. For a **minor** or
**major** release, bump the version in `package.json` first, then merge:

```sh
npm version minor   # or major
git push origin main
```

## Homebridge catalog

To make the plugin discoverable in Homebridge's plugin search, the repository
must meet the [homebridge plugin guidelines](https://github.com/homebridge/homebridge-plugins#readme):

- [x] `homebridge` prefix in the package name
- [x] Valid `engines.homebridge` field
- [x] `config.schema.json` (UI form)
- [x] Public npm package published to the npm registry
- [x] Verified plugin badge / repository listing (optional, requires approval)

The Homebridge plugin search indexes npm packages that match the
`homebridge-*` pattern. Once the package is published to npm, search
"Intesis AC Cloud" from the Homebridge UI plugin page to install it.

## License

MIT — see [LICENSE](./LICENSE). Original work (c) 2018 Phillip Moon,
(c) 2019 Jay Schuster; this rewrite (c) 2026 csilk.
