# @mgcrea/homebridge-melcloud-home

Homebridge plugin for Mitsubishi Electric air conditioners on **MELCloud Home**
(`melcloudhome.com`) — the platform used by 4th-generation Wi-Fi adapters.

> This is **not** compatible with the older `app.melcloud.com` service. The two use
> entirely different APIs and authentication. If your units still work in the classic
> MELCloud app, you want a legacy plugin instead.

## Features

- Each air-to-air unit appears as a HomeKit **Heater Cooler**: power, heat/cool/auto,
  target temperature, fan speed and swing.
- **Dry**, **Fan** and **automatic fan speed** exposed as switches, since HomeKit has no
  native equivalent for any of them.
- Optional per-unit **temperature sensor**, plus fault and connectivity status.
- **Real-time updates** over the platform's push feed, so changes made from a physical
  remote or the official app show up within seconds rather than at the next poll.
- Characteristic writes are **merged into a single request**, which keeps scenes fast and
  avoids confusing multi-split outdoor units.
- Per-unit capability detection: temperature ranges, half-degree support and the number of
  fan speeds all come from the device itself.

## Requirements

- Node.js 22 or 24
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
| `exposeTemperatureSensors` | `true` | Add a standalone temperature sensor per unit. |
| `exposeDrySwitch` | `true` | Switch for dry mode, on units that support it. |
| `exposeFanSwitch` | `true` | Switch for fan-only mode. |
| `exposeAutoFanSwitch` | `true` | Switch for automatic fan speed. |
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
| Swing mode | vertical vane `Swing` |
| Status fault / active | `IsInError` / `isConnected` |

Dry and Fan report as *Cool* on the main tile — they never heat — with the dedicated
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

## Limitations

- Air-to-water units (Ecodan heat pumps) are recognised in the API but not yet exposed.
- Horizontal vane position is read but not individually controllable from HomeKit, which
  has no characteristic for it.
- Energy telemetry is **not implemented**. The `exposeEnergy` option is accepted and the
  endpoint is known, but the response shape has never been captured, so there is nothing
  to parse yet. Enabling the option logs a warning and changes nothing. Units reporting
  `isEnergyUsageCompatible: false` — which includes every unit seen so far — are unlikely
  to return usable data even once it is built.

## License

MIT
