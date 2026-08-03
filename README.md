<!-- markdownlint-disable no-inline-html -->

# @mgcrea/homebridge-melcloud-home

<p align="center">
  <a href="https://www.npmjs.com/package/@mgcrea/homebridge-melcloud-home">
    <img src="https://img.shields.io/npm/v/@mgcrea/homebridge-melcloud-home.svg?style=for-the-badge" alt="npm version" />
  </a>
  <a href="https://www.npmjs.com/package/@mgcrea/homebridge-melcloud-home">
    <img src="https://img.shields.io/npm/dt/@mgcrea/homebridge-melcloud-home.svg?style=for-the-badge" alt="npm total downloads" />
  </a>
  <a href="https://www.npmjs.com/package/@mgcrea/homebridge-melcloud-home">
    <img src="https://img.shields.io/npm/dm/@mgcrea/homebridge-melcloud-home.svg?style=for-the-badge" alt="npm monthly downloads" />
  </a>
  <a href="https://www.npmjs.com/package/@mgcrea/homebridge-melcloud-home">
    <img src="https://img.shields.io/npm/l/@mgcrea/homebridge-melcloud-home.svg?style=for-the-badge" alt="npm license" />
  </a>
  <a href="https://github.com/mgcrea/homebridge-melcloud-home/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/mgcrea/homebridge-melcloud-home/ci.yml?style=for-the-badge" alt="github ci workflow" />
  </a>
</p>

---

Homebridge plugin for Mitsubishi Electric air conditioners on **MELCloud Home**
(`melcloudhome.com`) — the platform used by 4th-generation Wi-Fi adapters.

> This is **not** compatible with the older `app.melcloud.com` service. The two use
> entirely different APIs and authentication. If your units still work in the classic
> MELCloud app, you want a legacy plugin instead.

## Features

- Each air-to-air unit appears as a HomeKit **Heater Cooler**: power, heat/cool/auto,
  target temperature, fan speed and swing.
- **Fan speed, automatic fan speed and swing** included natively, on a companion Fan
  service — the Home app does not render them on a Heater Cooler. It folds into the same
  control, so a unit stays a single accessory.
- **Vane position** on a second Fan control, whose slider picks one of the five positions.
- **Dry** and **fan-only** mode available as opt-in switches, since HomeKit has no native
  equivalent. Off by default: the modes are already reachable from the mode picker.
- Optional per-unit **temperature sensor** (off by default — the climate control already
  reports room temperature), carrying fault and connectivity status.
- **Real-time updates** over the platform's push feed, so changes made from a physical
  remote or the official app show up within seconds rather than at the next poll.
- Characteristic writes are **merged into a single request**, which keeps scenes fast and
  avoids confusing multi-split outdoor units.
- Per-unit capability detection: temperature ranges, half-degree support and the number of
  fan speeds all come from the device itself.

## Requirements

- Node.js 22, 24 or 26
- Homebridge 2.x

## Install

```sh
npm install -g @mgcrea/homebridge-melcloud-home
```

## Configuration

Add a platform block to `config.json`, or use the Homebridge UI form:

```json
{
  "platforms": [
    {
      "platform": "MELCloudHome",
      "name": "MELCloud Home",
      "email": "you@example.com",
      "password": "your-password"
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `email` | — | MELCloud Home account email. Required. |
| `password` | — | MELCloud Home account password. Required. |
| `pollInterval` | `60` | Seconds between polls. Clamped to a 30 second minimum. |
| `useWebSocket` | `true` | Subscribe to real-time push updates. |
| `exposeFanService` | `true` | Fan speed, auto and swing. The only native way to reach them; folds into the same control. |
| `exposeVaneControl` | `true` | Vane position as a second Fan control: slider picks the position, AUTO and swing alongside. |
| `exposeTemperatureSensors` | `false` | Separate temperature sensor per unit. Duplicates the climate reading, but carries fault/connectivity status. |
| `exposeDrySwitch` | `false` | Switch for dry mode, on units that support it. Extra control. |
| `exposeFanSwitch` | `false` | Switch for fan-only mode. Extra control. |
| `exposeAutoFanSwitch` | `false` | Switch for automatic fan speed. Redundant when `exposeFanService` is on. |
| `exposeEnergy` | `false` | Reserved for a future release. Enabling it currently does nothing. |
| `debug` | `false` | Verbose, redacted request logging. |

### Credentials

Your password is used to sign in to Mitsubishi's identity provider and is never written to
disk. The resulting tokens are cached under the Homebridge storage directory
(`melcloud-home/<hash>.json`, mode `0600`) so a restart does not trigger a new sign-in.
Tokens are refreshed automatically about a minute before they expire.

## How it maps to HomeKit

| HomeKit | MELCloud Home |
| --- | --- |
| Active | `Power` |
| Target state — Heat / Cool / Auto | `Heat` / `Cool` / `Automatic` |
| Current state | derived from mode, standby and actual fan speed |
| Current temperature | `RoomTemperature` |
| Heating / cooling threshold | `SetTemperature` (one setpoint, shown on both) |
| Rotation speed | `SetFanSpeed`, spaced across the unit's speed count |
| Fan AUTO toggle | `SetFanSpeed` of `Auto` |
| Current fan state | `ActualFanSpeed` — `Off` or standby reads as idle |
| Swing mode | vertical vane `Swing` |
| Vane fan slider | vertical vane `One`–`Five`, spread across the slider |
| Vane AUTO toggle | vertical vane `Auto` |
| Status fault / active | `IsInError` / `isConnected` — on the temperature sensor only, since HeaterCooler does not carry these characteristics |

Dry and Fan report as *Cool* on the main control — they never heat — with the dedicated
switches showing the real mode.

## Verifying your account

Before wiring it into Homebridge you can check credentials and discovery directly:

```sh
MELCLOUD_EMAIL=you@example.com MELCLOUD_PASSWORD='…' pnpm probe
```

Add `DEBUG=1` for the full redacted request trace.

## Development

```sh
pnpm install
pnpm test      # lint, typecheck, unit tests, format check
pnpm build
```

Tests run entirely against recorded fixtures via `msw`; nothing reaches the real service.
The fixtures were generated from Charles captures of the official iOS app and scrubbed of
all identifying data by `scripts/build-fixtures.py`.

See [`docs/protocol.md`](docs/protocol.md) for the annotated wire protocol.

## Releasing

Versioning happens locally, publishing happens in CI.

```sh
pnpm release            # or: pnpm release minor
```

`release-it` runs the test suite and a build, bumps the version, commits as
`chore(release): cut the vX.Y.Z release`, tags it (`0.2.0`, unprefixed), pushes, and opens
a GitHub release. It does **not** publish to npm — pushing the tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which reruns the checks,
verifies the tag matches `package.json`, and publishes.

Set `GITHUB_TOKEN` in your environment first, or release-it falls back to opening the
GitHub release form in a browser instead of creating it directly.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) via
OIDC, so there is no `NPM_TOKEN` to store or rotate, and every release carries a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements) tying the
tarball to the workflow run that built it.

### One-time setup

Trusted publishing is configured against a package that already exists, so the first
release has to be published by hand:

```sh
pnpm test && pnpm build
npm publish --access public
```

Then on npmjs.com → the package → *Settings* → *Trusted Publisher*, add a GitHub Actions
publisher with:

| Field | Value |
| --- | --- |
| Organization / user | `mgcrea` |
| Repository | `homebridge-melcloud-home` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |

Every release after that is just `pnpm release`. Renaming the workflow file means updating
it here too, or publishes will start failing authentication.

## Limitations

- Air-to-water units (Ecodan heat pumps) are recognised in the API but not yet exposed.
- Horizontal vane position is read but not individually controllable from HomeKit, which
  has no characteristic for it.
- Vertical vane position rides on a second Fan control whose speed slider is really the
  position. HAP does model a louver properly — the `Slats` service, with a tilt angle — but
  Apple's Home app has never shipped UI for it, so it is invisible where it matters. A fan
  slider is the only representation that is both native and rendered. Set
  `exposeVaneControl: false` to drop it. HomeKit has no general-purpose selector
  characteristic, so a labelled list of positions is not possible without presenting the
  unit as a television.
- Energy telemetry is **not implemented**. The `exposeEnergy` option is accepted and the
  endpoint is known, but the response shape has never been captured, so there is nothing
  to parse yet. Enabling the option logs a warning and changes nothing. Units reporting
  `isEnergyUsageCompatible: false` — which includes every unit seen so far — are unlikely
  to return usable data even once it is built.

## License

MIT
