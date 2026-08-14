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

Releases are automated via GitHub Actions:

1. **CI workflow** (`.github/workflows/ci.yml`) runs on every push/PR —
   installs deps, runs the test suite with coverage, and builds.
2. **Release workflow** (`.github/workflows/release.yml`) triggers on a
   `v*` tag push — builds, runs tests, publishes to **npm**, and creates a
   **GitHub release** with auto-generated notes.

To cut a release:

```sh
git tag v1.0.0
git push origin v1.0.0
```

### Trusted publishing (recommended)

The release workflow uses **npm trusted publishing** (OIDC) — no `NPM_TOKEN`
secret is stored in GitHub. Trusted publishing is configured **per package** on
npmjs.com (not via the access-tokens page), so the package must be published
once to claim the name before you can add a trusted publisher.

**First publish (one-time, from your machine):**

```sh
bun run build
npm publish --access public
```

**Then enable trusted publishing:**

1. Go to **npmjs.com → Packages → `homebridge-intesis-accloud` → Settings →
   Trusted publishing**.
2. Under "Select your publisher", choose **GitHub Actions**.
3. Fill in:
   - **Organization or user**: `csi-lk`
   - **Repository**: `homebridge-intesis-accloud`
   - **Workflow filename**: `release.yml`
   - **Allowed actions**: `npm publish`
4. Save. The workflow's `id-token: write` permission lets `npm publish`
   authenticate automatically, and npm auto-generates provenance attestations.

> You can set this up **before** cutting your first tagged release, but the
> package name must already exist on npm (hence the one-time manual publish
> above).

### Cutting a release

```sh
git tag v1.0.0
git push origin v1.0.0
```

The release workflow runs tests, enforces 100% coverage, builds, publishes to
npm (with provenance), and creates a GitHub release with auto-generated notes.

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
