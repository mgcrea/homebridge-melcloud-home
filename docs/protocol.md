# MELCloud Home protocol notes

Everything here was derived from Charles captures of the official iOS app
(`MonitorAndControl.App.Mobile`), plus one step that no capture could reach and had to be
reconstructed. This is the annotated companion to [`src/api/const.ts`](../src/api/const.ts).

**This is not the legacy MELCloud API.** `app.melcloud.com` (the `ClientLogin` /
`ListDevices` API that most existing plugins target) is a different service with different
credentials. Nothing here applies to it.

All identifiers below are the scrubbed fakes used in `test/fixtures/`, not real values.

## Hosts

| Host | Role |
| --- | --- |
| `auth.melcloudhome.com` | Duende IdentityServer — issues the tokens |
| `live-melcloudhome.auth.eu-west-1.amazoncognito.com` | AWS Cognito user pool it federates to (`idp: cognito-meu`); where credentials are actually submitted |
| `mobile.bff.melcloudhome.com` | Backend-for-frontend; all device reads and writes |
| `6x2dgdulg7omjsxalnhmo4ynba0dcgwk.lambda-url.eu-west-1.on.aws` | Fixed Lambda Function URL issuing the WebSocket `hash` |
| `ws.melcloudhome.com` | Real-time push socket |

Everything sits behind AWS API Gateway, so requests are serialised with a 500 ms minimum
start-to-start gap (`MIN_REQUEST_INTERVAL_MS`).

## Authentication

OAuth 2.0 authorization code flow with **PAR** (RFC 9126) and **PKCE** (S256), against
IdentityServer, which federates the actual credential check to Cognito's hosted UI. The
client is `homemobile`, public and secretless, with redirect URI `melcloudhome://` and
scopes `openid profile email offline_access IdentityServerApi`.

The nesting is what makes this awkward: there are effectively two PKCE flows, one inside
the other, and the inner one runs on a host that only speaks HTML forms.

### Step 1 — Pushed authorization request

```http
POST https://auth.melcloudhome.com/connect/par
Content-Type: application/x-www-form-urlencoded
Authorization: Basic aG9tZW1vYmlsZTo=
```

Body: `response_type=code`, `state`, `code_challenge`, `code_challenge_method=S256`,
`client_id=homemobile`, `scope=…`, `redirect_uri=melcloudhome://`.
Returns **201** with `{ "request_uri": "urn:ietf:params:oauth:request_uri:…" }`.

> **The `Authorization: Basic` header is mandatory and is the single least obvious thing
> in this document.** The value is `base64("homemobile:")` — the public client id with an
> empty secret. The client genuinely has no secret, so no public implementation of this
> API sends the header at all; every one that omits it gets a bare `401` from `/connect/par`
> with no error body explaining why. If you are reimplementing this flow and are stuck at
> the first request, this is why.

Any status other than 201 is fatal. 5xx is surfaced separately as a service outage rather
than an auth failure, because it usually is one.

### Step 2 — Authorize

`GET /connect/authorize?client_id=homemobile&request_uri=…`, then follow redirects (capped
at 12 hops). Three ways out:

1. **Existing session** — IdentityServer still has a cookie session and the chain lands
   directly on a URL carrying `code=`. No credentials needed.
2. **Cognito login page** — proceed to step 3.
3. **A callback link in the HTML body** — the page carries only a
   `/connect/authorize/callback?…` link rather than redirecting; scrape it and follow it.

Redirects are walked manually rather than by `fetch`, for two reasons: the chain terminates
in a `melcloudhome://` custom scheme that `fetch` refuses to follow, and cookies have to be
threaded across hops by hand (`fetch` has no cookie jar — hence `src/api/cookie-jar.ts`).
Non-307/308 redirects downgrade POST to GET, per spec.

### Step 3 — Credential submission to Cognito

**This step appears in no capture.** The iOS app runs it inside
`ASWebAuthenticationSession`, which uses its own network stack outside the proxy, so
Charles sees the flow go quiet here and resume two hops later. It was reconstructed from
prior art and is now confirmed working end to end by `pnpm probe`.

Scrape `_csrf` from the hosted-UI HTML, then POST it back to the same URL with
`username`, `password` and an empty `cognitoAsfData`.

> **Send a browser `User-Agent` for this request and only this request.** Cognito's hosted
> UI serves a JavaScript-only shell to non-browser agents, so the form — and the `_csrf`
> token — simply are not in the HTML you get back with the app's own UA. Every other
> request in the flow uses the iOS app UA (`USER_AGENT`); this one claims to be Mobile
> Safari (`BROWSER_USER_AGENT`).

Landing still on an `*.amazoncognito.com` host means the form re-rendered with an error
rather than redirecting onward — almost always bad credentials.

### Step 4 — Token exchange

`POST /connect/token` with `grant_type=authorization_code`, the `code`, the original
`code_verifier`, and the redirect URI. Refresh uses the same endpoint with
`grant_type=refresh_token`.

Tokens are refreshed 60 s before expiry. A refresh response that omits `refresh_token`
keeps the existing one. A rejected refresh clears the token set, the cookie jar and the
on-disk cache, then falls back to a full login.

## BFF endpoints

All require `Authorization: Bearer <access_token>`. A `401` mid-session triggers one token
invalidation and retry; a second `401` is fatal.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/context` | Everything: account, buildings, units, capabilities, current state |
| `PUT` | `/monitor/ataunit/{unitId}` | Control an air-to-air unit. Returns `204` with no body |
| `GET` | `/telemetry/telemetry/energy/{unitId}` | Energy telemetry. Doubled path segment is verbatim. **Never captured — see below** |

### The control payload

`PUT /monitor/ataunit/{unitId}` requires **all eight keys on every request**. A partial
object is rejected, so fields you are not changing must be explicitly `null`:

```json
{
  "power": true,
  "operationMode": "Cool",
  "setFanSpeed": null,
  "vaneHorizontalDirection": null,
  "vaneVerticalDirection": null,
  "setTemperature": null,
  "temperatureIncrementOverride": null,
  "inStandbyMode": null
}
```

Writes apply in arrival order with no revision check, which is why this plugin debounces
and merges characteristic writes into a single PUT
([`src/util/coalesce.ts`](../src/util/coalesce.ts)). It also pairs `power` with
`operationMode` in one request: on a multi-split system, a power change arriving separately
from its mode change can fault the compressor.

### Enums, and where `/context` contradicts itself

The API speaks words, never numbers:

| Field | Accepted values |
| --- | --- |
| `operationMode` | `Heat`, `Cool`, `Automatic`, `Dry`, `Fan` |
| `setFanSpeed` | `Auto`, `One`…`Five` |
| `vaneVerticalDirection` | `Auto`, `Swing`, `One`…`Five` |
| `vaneHorizontalDirection` | `Auto`, `Swing`, `Left`, `LeftCentre`, `Centre`, `RightCentre`, `Right` |

Three traps:

- **`Automatic`, not `Auto`**, for operation mode. `Auto` is rejected — but `Auto` *is*
  correct for fan speed and vane direction, so the two are easy to conflate.
- **`/context` returns ordinals as numeric strings** where writes expect words: `"3"` and
  `"Three"` both appear for the same position. Note `"7"` maps to **`Swing`**, not `Seven`.
- **`/context` returns American spellings** for horizontal vanes (`Center`, `CenterLeft`,
  `CenterRight`) while writes accept only the British ones (`Centre`, `LeftCentre`,
  `RightCentre`).

Reads are normalised onto the canonical write vocabulary in
[`src/api/types.ts`](../src/api/types.ts); unrecognised values are dropped rather than
guessed at.

Unit state arrives as a flat `settings` array of `{name, value}` pairs with everything
stringified — `"true"`, `"27.5"` — not as typed fields.

## Real-time updates

1. `GET` the Lambda Function URL with the BFF bearer token. It returns a short-lived hash,
   either as a bare string or wrapped as `{"hash": "…"}` — both shapes occur.
2. Connect to `wss://ws.melcloudhome.com/?hash=<hash>`.
3. Frames arrive bare or batched in an array. Relevant ones have
   `messageType: "unitStateChanged"` and a payload under either `Data` or `data`
   (both casings occur).

**The delta is not applied.** A frame names which settings moved but does not carry a full
state snapshot, so the platform treats it purely as a signal to re-read `/context`
([`src/platform.ts`](../src/platform.ts)). The socket is a latency optimisation over the
60 s poll, not a replacement for it.

Reconnection uses exponential backoff from 5 s to 300 s with ±20 % jitter, and only resets
the backoff after a session has stayed up for 60 s — otherwise a server that accepts the
connection and immediately hangs up would spin.

## Known gaps

- **Energy telemetry.** The endpoint above is the one the app uses, but no capture contains
  a response, so there is no shape to parse. Every unit seen so far reports
  `isEnergyUsageCompatible: false`, so it may return nothing useful even once implemented.
  The `exposeEnergy` config option is accepted but does nothing today.
- **Air-to-water (Ecodan).** `airToWaterUnits` is present in `/context` and parsed, but no
  capture contains a populated one.
- **Horizontal vane.** Readable and writable on the wire, but HomeKit has no characteristic
  for it, so the plugin never writes it.

## Regenerating fixtures

`scripts/build-fixtures.py` converts a Charles `.chlsj` export into the scrubbed fixtures
in `test/fixtures/`. It hardcodes no real values: identifiers are replaced by walking the
known `/context` shape and assigning positional fakes, with a shape-based sweep behind it
for anything the walk does not reach. Captures themselves contain live tokens and must
never be committed — `.gitignore` covers `*.chlsj`.
