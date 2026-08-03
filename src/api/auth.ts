import { createHash, randomBytes } from "node:crypto";
import { CookieJar } from "./cookie-jar.js";
import {
  AUTHORIZE_ENDPOINT,
  AUTH_BASE_URL,
  BROWSER_USER_AGENT,
  COGNITO_DOMAIN_SUFFIX,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES,
  PAR_ENDPOINT,
  REQUEST_TIMEOUT_MS,
  TOKEN_ENDPOINT,
  TOKEN_REFRESH_MARGIN_MS,
  USER_AGENT,
} from "./const.js";
import { AuthenticationError, ServiceUnavailableError } from "./errors.js";
import type { RequestPacer } from "./pacer.js";

export type TokenSet = {
  accessToken: string;
  refreshToken: string | undefined;
  /** Absolute epoch milliseconds. */
  expiresAt: number;
};

export type TokenStore = {
  load(): Promise<TokenSet | undefined>;
  save(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
};

export type AuthLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

export type AuthOptions = {
  username: string;
  password: string;
  pacer: RequestPacer;
  logger: AuthLogger;
  tokenStore?: TokenStore | undefined;
  fetchImpl?: typeof fetch;
};

/** Strip anything that would leak a credential into the logs. */
export const redact = (value: string): string =>
  value.replace(/([?&])(code|state|hash|id_token_hint|code_verifier)=[^&\s]*/gi, "$1$2=***");

const maskEmail = (email: string): string => {
  const at = email.indexOf("@");
  return at < 1 ? "***" : `${email.slice(0, 1)}***@${email.slice(at + 1, at + 2)}***`;
};

const base64Url = (buffer: Buffer): string => buffer.toString("base64url");

const generatePkce = (): { verifier: string; challenge: string } => {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

/**
 * Drives the MELCloud Home OAuth flow and keeps a valid access token on hand.
 *
 * The flow is a standard authorization-code + PKCE exchange with two wrinkles
 * worth knowing about:
 *
 *  1. It starts with a Pushed Authorization Request (PAR), and the PAR endpoint
 *     requires HTTP Basic auth with the (secretless) client id. Omitting it
 *     fails with a bare 401.
 *  2. IdentityServer delegates the actual login to an AWS Cognito hosted UI.
 *     The mobile app opens that in a system browser; we drive it directly by
 *     posting the login form, which means carrying cookies across ~6 redirects
 *     and reading the terminal `melcloudhome://?code=` redirect rather than
 *     following it.
 */
export class MelCloudHomeAuth {
  readonly #username: string;
  readonly #password: string;
  readonly #pacer: RequestPacer;
  readonly #logger: AuthLogger;
  readonly #tokenStore: TokenStore | undefined;
  readonly #fetch: typeof fetch;
  readonly #jar = new CookieJar();

  #tokens: TokenSet | undefined;
  /** De-duplicates concurrent callers so we never run two logins at once. */
  #inflight: Promise<string> | undefined;

  constructor(options: AuthOptions) {
    this.#username = options.username;
    this.#password = options.password;
    this.#pacer = options.pacer;
    this.#logger = options.logger;
    this.#tokenStore = options.tokenStore;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  get isTokenValid(): boolean {
    return (
      this.#tokens !== undefined && Date.now() < this.#tokens.expiresAt - TOKEN_REFRESH_MARGIN_MS
    );
  }

  /**
   * Return a usable access token, doing the least work necessary: reuse, then
   * restore from disk, then refresh, then a full login.
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid && this.#tokens) {
      return this.#tokens.accessToken;
    }
    this.#inflight ??= this.#acquireToken().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /** Drop the current access token so the next call re-authenticates. */
  invalidate(): void {
    if (this.#tokens) {
      this.#tokens = { ...this.#tokens, expiresAt: 0 };
    }
  }

  async #acquireToken(): Promise<string> {
    if (!this.#tokens && this.#tokenStore) {
      const restored = await this.#tokenStore.load();
      if (restored) {
        this.#logger.debug("Restored persisted tokens");
        this.#tokens = restored;
        if (this.isTokenValid) {
          return restored.accessToken;
        }
      }
    }

    if (this.#tokens?.refreshToken) {
      try {
        return await this.#refresh(this.#tokens.refreshToken);
      } catch (error) {
        // A rejected refresh token is expected after a password change or a
        // server-side session revoke; fall through to a full login.
        this.#logger.warn(
          `Token refresh failed, falling back to full login: ${errorMessage(error)}`,
        );
        this.#tokens = undefined;
        this.#jar.clear();
        await this.#tokenStore?.clear();
      }
    }

    return this.#login();
  }

  // -------------------------------------------------------------------------
  // Token endpoint
  // -------------------------------------------------------------------------

  async #refresh(refreshToken: string): Promise<string> {
    this.#logger.debug("Refreshing access token");
    return this.#requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });
  }

  async #requestToken(form: Record<string, string>): Promise<string> {
    const response = await this.#send(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams(form).toString(),
    });

    if (response.status >= 500) {
      throw new ServiceUnavailableError(response.status);
    }
    if (!response.ok) {
      throw new AuthenticationError(`Token request rejected (HTTP ${response.status})`);
    }

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) {
      throw new AuthenticationError("Token response contained no access_token");
    }

    this.#tokens = {
      accessToken: payload.access_token,
      // A refresh response may omit the refresh token, meaning "keep the old one".
      refreshToken: payload.refresh_token ?? this.#tokens?.refreshToken,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
    await this.#tokenStore?.save(this.#tokens);
    this.#logger.debug("Access token acquired");
    return this.#tokens.accessToken;
  }

  // -------------------------------------------------------------------------
  // Full interactive-style login
  // -------------------------------------------------------------------------

  async #login(): Promise<string> {
    this.#logger.info(`Signing in to MELCloud Home as ${maskEmail(this.#username)}`);
    this.#jar.clear();

    const { verifier, challenge } = generatePkce();
    const state = base64Url(randomBytes(16));

    const requestUri = await this.#pushAuthorizationRequest(state, challenge);
    const code = await this.#authorize(requestUri);

    return this.#requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
      client_id: OAUTH_CLIENT_ID,
    });
  }

  /** Step 1 — hand the authorization parameters to the server up front. */
  async #pushAuthorizationRequest(state: string, codeChallenge: string): Promise<string> {
    const response = await this.#send(PAR_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": USER_AGENT,
        // The client has no secret, but the endpoint still demands Basic auth.
        authorization: `Basic ${Buffer.from(`${OAUTH_CLIENT_ID}:`).toString("base64")}`,
      },
      body: new URLSearchParams({
        response_type: "code",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPES,
        redirect_uri: OAUTH_REDIRECT_URI,
      }).toString(),
    });

    if (response.status >= 500) {
      throw new ServiceUnavailableError(response.status);
    }
    if (response.status !== 201) {
      throw new AuthenticationError(
        `Pushed authorization request failed (HTTP ${response.status})`,
      );
    }

    const { request_uri: requestUri } = (await response.json()) as { request_uri?: string };
    if (!requestUri) {
      throw new AuthenticationError("Pushed authorization request returned no request_uri");
    }
    return requestUri;
  }

  /**
   * Steps 2-5 — walk the redirect chain to an authorization code, submitting
   * credentials to Cognito along the way if the server asks for them.
   */
  async #authorize(requestUri: string): Promise<string> {
    const start = `${AUTHORIZE_ENDPOINT}?${new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      request_uri: requestUri,
    }).toString()}`;

    let landing = await this.#followRedirects(start, { "user-agent": USER_AGENT });

    // Fast path: IdentityServer still had a session, so no login was required.
    const early = extractAuthCode(landing.url) ?? extractAuthCode(landing.body);
    if (early) {
      this.#logger.debug("Existing session accepted, skipping credential submission");
      return early;
    }

    if (isCognitoLoginPage(landing.url)) {
      landing = await this.#submitCredentials(landing.url, landing.body);
    }

    const code = extractAuthCode(landing.url) ?? extractAuthCode(landing.body);
    if (code) {
      return code;
    }

    // The redirect page may only carry a link back to the callback; follow it.
    const callback = /\/connect\/authorize\/callback\?([^"'\s]+)/.exec(landing.body);
    if (callback?.[1]) {
      const url = `${AUTH_BASE_URL}/connect/authorize/callback?${callback[1].replaceAll("&amp;", "&")}`;
      const final = await this.#followRedirects(url, { "user-agent": USER_AGENT });
      const found = extractAuthCode(final.url) ?? extractAuthCode(final.body);
      if (found) {
        return found;
      }
    }

    throw new AuthenticationError(
      `Could not obtain an authorization code (ended at ${redact(landing.url)})`,
    );
  }

  /** Step 3 — post the Cognito hosted-UI login form. */
  async #submitCredentials(loginUrl: string, html: string): Promise<Landing> {
    const csrf = extractCsrfToken(html);
    if (!csrf) {
      throw new AuthenticationError("Could not find the CSRF token on the Cognito login page");
    }

    this.#logger.debug("Submitting credentials to the identity provider");
    const origin = new URL(loginUrl).origin;
    const landing = await this.#followRedirects(
      loginUrl,
      {
        // Cognito serves a different (JS-only) page to non-browser agents.
        "user-agent": BROWSER_USER_AGENT,
        "content-type": "application/x-www-form-urlencoded",
        origin,
        referer: loginUrl,
      },
      {
        method: "POST",
        body: new URLSearchParams({
          _csrf: csrf,
          username: this.#username,
          password: this.#password,
          cognitoAsfData: "",
        }).toString(),
      },
    );

    // Still on Cognito means the form came back with an error rather than
    // redirecting onwards — almost always bad credentials.
    if (isCognitoHost(landing.url)) {
      throw new AuthenticationError(
        describeCognitoFailure(landing.body) ??
          "Sign-in was rejected — check the MELCloud Home email and password",
      );
    }

    return landing;
  }

  // -------------------------------------------------------------------------
  // Redirect-aware transport
  // -------------------------------------------------------------------------

  /**
   * Follow redirects manually, threading cookies through each hop.
   *
   * Manual because the chain terminates in a `melcloudhome://` custom-scheme
   * redirect that carries the authorization code — `fetch` would throw on it
   * rather than hand it back.
   */
  async #followRedirects(
    url: string,
    headers: Record<string, string>,
    init?: { method?: string; body?: string },
  ): Promise<Landing> {
    let current = url;
    let method = init?.method ?? "GET";
    let body = init?.body;

    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const response = await this.#send(current, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
      });

      if (response.status >= 500) {
        throw new ServiceUnavailableError(response.status);
      }

      const location = response.headers.get("location");
      if (!location || response.status < 300 || response.status >= 400) {
        return { url: current, body: await response.text() };
      }

      const next = new URL(location, current).toString();

      // The custom-scheme hop is the finish line, not a request to make.
      if (next.startsWith(OAUTH_REDIRECT_URI)) {
        return { url: next, body: "" };
      }

      // Per RFC 7231 a 303 (and in practice a 302 after POST) becomes a GET.
      if (method !== "GET" && response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = undefined;
      }
      current = next;
    }

    throw new AuthenticationError("Too many redirects during sign-in");
  }

  /** One request: pacing, cookies, timeout. */
  async #send(url: string, init: RequestInit): Promise<Response> {
    return this.#pacer.run(async () => {
      const cookie = this.#jar.headerFor(url);
      const headers = new Headers(init.headers);
      if (cookie) {
        headers.set("cookie", cookie);
      }

      this.#logger.debug(`→ ${init.method ?? "GET"} ${redact(url)}`);
      const response = await this.#fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.#jar.storeFrom(response, url);
      this.#logger.debug(`← ${response.status} ${redact(url)}`);
      return response;
    });
  }
}

type Landing = { url: string; body: string };

const MAX_REDIRECTS = 12;

const extractAuthCode = (source: string): string | undefined =>
  /[?&]code=([^&"'\s]+)/.exec(source)?.[1];

const isCognitoHost = (url: string): boolean => {
  try {
    return new URL(url).hostname.endsWith(COGNITO_DOMAIN_SUFFIX);
  } catch {
    return false;
  }
};

const isCognitoLoginPage = (url: string): boolean => isCognitoHost(url) && url.includes("/login");

/** Pull the antiforgery token out of the hosted-UI form. */
const extractCsrfToken = (html: string): string | undefined =>
  /name="_csrf"[^>]*value="([^"]+)"/i.exec(html)?.[1] ??
  /value="([^"]+)"[^>]*name="_csrf"/i.exec(html)?.[1];

/** Surface Cognito's own error text when it gives us one. */
const describeCognitoFailure = (html: string): string | undefined => {
  const message = /class="errorMessage"[^>]*>([^<]+)</i.exec(html)?.[1]?.trim();
  return message ? `Sign-in was rejected: ${message}` : undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
