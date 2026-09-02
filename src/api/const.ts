/**
 * Wire constants for the MELCloud Home platform.
 *
 * Everything here was derived from Charles captures of the official iOS app
 * (`MonitorAndControl.App.Mobile`). See `docs/protocol.md` for the annotated flow.
 */

/** Mobile backend-for-frontend. All device reads and writes go here. */
export const BFF_BASE_URL = "https://mobile.bff.melcloudhome.com";

/** Duende IdentityServer instance fronting the whole platform. */
export const AUTH_BASE_URL = "https://auth.melcloudhome.com";

/**
 * AWS Cognito user pool that IdentityServer federates to (`idp: cognito-meu`).
 * The hosted UI is where credentials are actually submitted.
 */
export const COGNITO_BASE_URL = "https://live-melcloudhome.auth.eu-west-1.amazoncognito.com";
export const COGNITO_DOMAIN_SUFFIX = ".amazoncognito.com";

/** Public OAuth client of the mobile app. It has no secret. */
export const OAUTH_CLIENT_ID = "homemobile";
export const OAUTH_REDIRECT_URI = "melcloudhome://";
export const OAUTH_SCOPES = "openid profile email offline_access IdentityServerApi";

/** Matches the iOS app so we look like a known client. */
export const USER_AGENT = "MonitorAndControl.App.Mobile/62 CFNetwork/3860.600.12 Darwin/25.5.0";

/**
 * The Cognito hosted UI rejects non-browser user agents, so credential
 * submission (and only that step) claims to be Mobile Safari.
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76";

/** Auth endpoints. */
export const PAR_ENDPOINT = `${AUTH_BASE_URL}/connect/par`;
export const AUTHORIZE_ENDPOINT = `${AUTH_BASE_URL}/connect/authorize`;
export const TOKEN_ENDPOINT = `${AUTH_BASE_URL}/connect/token`;

/** BFF endpoints. */
export const CONTEXT_PATH = "/context";
export const ATA_UNIT_PATH = (unitId: string) => `/monitor/ataunit/${unitId}`;
export const ENERGY_TELEMETRY_PATH = (unitId: string) => `/telemetry/telemetry/energy/${unitId}`;

/**
 * Real-time push. A fixed AWS Lambda Function URL issues a short-lived `hash`
 * when called with the BFF bearer token; that hash authenticates the socket.
 */
export const WS_HASH_URL = "https://6x2dgdulg7omjsxalnhmo4ynba0dcgwk.lambda-url.eu-west-1.on.aws/";
export const WS_HOST = "wss://ws.melcloudhome.com";

// ---------------------------------------------------------------------------
// Control enums. The API speaks words, never numbers.
// ---------------------------------------------------------------------------

/** Note `Automatic`, not `Auto` — the API rejects the latter for operation mode. */
export const OPERATION_MODES = ["Heat", "Cool", "Automatic", "Dry", "Fan"] as const;
export type OperationMode = (typeof OPERATION_MODES)[number];

export const FAN_SPEEDS = ["Auto", "One", "Two", "Three", "Four", "Five"] as const;
export type FanSpeed = (typeof FAN_SPEEDS)[number];

export const VANE_VERTICAL_DIRECTIONS = [
  "Auto",
  "Swing",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
] as const;
export type VaneVerticalDirection = (typeof VANE_VERTICAL_DIRECTIONS)[number];

/** British spelling — `Centre`, not `Center`. */
export const VANE_HORIZONTAL_DIRECTIONS = [
  "Auto",
  "Swing",
  "Left",
  "LeftCentre",
  "Centre",
  "RightCentre",
  "Right",
] as const;
export type VaneHorizontalDirection = (typeof VANE_HORIZONTAL_DIRECTIONS)[number];

/**
 * `/context` is not self-consistent: it sometimes returns ordinals as numeric
 * strings where the control API expects words. `7` is Swing, not Seven.
 */
export const ORDINAL_TO_WORD: Record<string, string> = {
  "0": "Auto",
  "1": "One",
  "2": "Two",
  "3": "Three",
  "4": "Four",
  "5": "Five",
  "7": "Swing",
};

/** ...and it sometimes returns American spellings for horizontal vanes. */
export const VANE_HORIZONTAL_ALIASES: Record<string, VaneHorizontalDirection> = {
  CenterLeft: "LeftCentre",
  Center: "Centre",
  CenterRight: "RightCentre",
};

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/** Minimum spacing between requests — everything sits behind AWS API Gateway. */
export const MIN_REQUEST_INTERVAL_MS = 500;

/** Refresh the access token this long before it actually expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const MIN_POLL_INTERVAL_MS = 30_000;

/** How long characteristic writes are buffered before being merged into one PUT. */
export const DEFAULT_WRITE_DEBOUNCE_MS = 400;

export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Consecutive failed polls before units are reported unresponsive.
 *
 * Three rather than one: a single failed poll is routine — a dropped request,
 * a brief upstream hiccup — and flapping the whole house to "No Response" over
 * one is worse than being a poll or two late to say so.
 */
export const UNREACHABLE_AFTER_FAILURES = 3;
