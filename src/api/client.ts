import type { AuthLogger, MelCloudHomeAuth } from "./auth.js";
import { redact } from "./auth.js";
import {
  ATA_UNIT_PATH,
  BFF_BASE_URL,
  CONTEXT_PATH,
  ENERGY_TELEMETRY_PATH,
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  WS_HASH_URL,
} from "./const.js";
import { ApiError, AuthenticationError, ServiceUnavailableError } from "./errors.js";
import type { RequestPacer } from "./pacer.js";
import { buildControlPayload, contextSchema, type AtaControlPatch, type Context } from "./types.js";

export type ClientOptions = {
  auth: MelCloudHomeAuth;
  pacer: RequestPacer;
  logger: AuthLogger;
  fetchImpl?: typeof fetch;
};

/** Typed access to the MELCloud Home mobile backend. */
export class MelCloudHomeClient {
  readonly #auth: MelCloudHomeAuth;
  readonly #pacer: RequestPacer;
  readonly #logger: AuthLogger;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#auth = options.auth;
    this.#pacer = options.pacer;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  /** The whole account: buildings, units, capabilities and current state. */
  async getContext(): Promise<Context> {
    const payload = await this.#request<unknown>("GET", CONTEXT_PATH);
    const result = contextSchema.safeParse(payload);
    if (!result.success) {
      // A schema change upstream should read as a clear message, not as
      // `undefined` surfacing three layers away in an accessory.
      throw new ApiError(200, CONTEXT_PATH, `unexpected response shape: ${result.error.message}`);
    }
    return result.data;
  }

  /**
   * Apply a change to one air-to-air unit.
   *
   * Callers should batch related changes into a single patch: the API accepts
   * every field at once, and on a multi-split system splitting power and mode
   * across two requests can leave the shared outdoor unit in a fault state.
   */
  async controlAtaUnit(unitId: string, patch: AtaControlPatch): Promise<void> {
    await this.#request<void>("PUT", ATA_UNIT_PATH(unitId), buildControlPayload(patch));
  }

  /**
   * Energy telemetry. Only meaningful for units reporting a consumption meter.
   *
   * Intentionally uncalled: the endpoint is the one the iOS app uses, but its
   * response has never appeared in a capture, so there is no shape to parse
   * into and the return type stays `unknown`. Kept as the starting point for
   * whoever captures an energy session — see the `exposeEnergy` option.
   */
  async getEnergyTelemetry(unitId: string): Promise<unknown> {
    return this.#request<unknown>("GET", ENERGY_TELEMETRY_PATH(unitId));
  }

  /** Short-lived credential for the real-time WebSocket. */
  async getWebSocketHash(): Promise<string> {
    const token = await this.#auth.getAccessToken();
    const response = await this.#pacer.run(() =>
      this.#fetch(WS_HASH_URL, {
        headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    );

    if (!response.ok) {
      throw new ApiError(response.status, "ws-hash");
    }

    const text = (await response.text()).trim();
    // The Lambda has returned both a bare string and a JSON envelope.
    try {
      const parsed = JSON.parse(text) as { hash?: string } | string;
      if (typeof parsed === "string") {
        return parsed;
      }
      if (parsed.hash) {
        return parsed.hash;
      }
    } catch {
      // Not JSON — the body is the hash itself.
    }
    if (!text) {
      throw new ApiError(response.status, "ws-hash", "empty response");
    }
    return text.replace(/^"|"$/g, "");
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response = await this.#send(method, path, body);

    // A 401 mid-session means the token died early (revoked, or the server
    // restarted). Refresh once and retry before giving up on the user.
    if (response.status === 401) {
      this.#logger.debug(`Got 401 on ${path}, refreshing token and retrying once`);
      this.#auth.invalidate();
      response = await this.#send(method, path, body);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(`Access denied for ${path} — re-authentication required`);
    }
    if (response.status >= 500) {
      throw new ServiceUnavailableError(response.status);
    }
    if (!response.ok) {
      throw new ApiError(response.status, path, await response.text().catch(() => ""));
    }

    // Control requests answer 204 with no body.
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#auth.getAccessToken();
    return this.#pacer.run(async () => {
      const url = `${BFF_BASE_URL}${path}`;
      this.#logger.debug(`→ ${method} ${redact(url)}`);
      const response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.#logger.debug(`← ${response.status} ${method} ${redact(url)}`);
      return response;
    });
  }
}
