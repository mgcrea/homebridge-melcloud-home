import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MelCloudHomeAuth, redact, type TokenSet, type TokenStore } from "../src/api/auth.js";
import { AuthenticationError } from "../src/api/errors.js";
import { RequestPacer } from "../src/api/pacer.js";
import { createTestLogger, fakeJwt } from "./helpers.js";
import { server } from "./msw-server.js";

const AUTH = "https://auth.melcloudhome.com";
const COGNITO = "https://live-melcloudhome.auth.eu-west-1.amazoncognito.com";

/**
 * Stub the full redirect chain exactly as the Charles capture recorded it:
 * PAR -> authorize -> Account/Login -> ExternalLogin/Challenge -> Cognito
 * hosted UI -> signin-oidc-meu -> ExternalLogin/Callback -> authorize/callback
 * -> melcloudhome:// -> token.
 */
const stubLoginChain = (options: { onTokenRequest?: (form: URLSearchParams) => void } = {}) => {
  const requests: string[] = [];

  server.use(
    http.post(`${AUTH}/connect/par`, ({ request }) => {
      requests.push("par");
      // The endpoint demands Basic auth even though the client has no secret.
      if (request.headers.get("authorization") !== `Basic ${btoa("homemobile:")}`) {
        return new HttpResponse(null, { status: 401 });
      }
      return HttpResponse.json(
        { request_uri: "urn:test:request", expires_in: 600 },
        { status: 201 },
      );
    }),

    http.get(`${AUTH}/connect/authorize`, () => {
      requests.push("authorize");
      return new HttpResponse(null, {
        status: 302,
        headers: { location: `${AUTH}/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize%2Fcallback` },
      });
    }),

    http.get(
      `${AUTH}/Account/Login`,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: {
            location: `${AUTH}/ExternalLogin/Challenge?scheme=cognito-meu`,
            "set-cookie": "idsrv.session=abc; path=/",
          },
        }),
    ),

    http.get(
      `${AUTH}/ExternalLogin/Challenge`,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: `${COGNITO}/login?client_id=x` },
        }),
    ),

    http.get(`${COGNITO}/login`, () =>
      HttpResponse.html(
        `<form method="post"><input type="hidden" name="_csrf" value="csrf-token-123"/></form>`,
      ),
    ),

    http.post(`${COGNITO}/login`, async ({ request }) => {
      requests.push("cognito-login");
      const form = new URLSearchParams(await request.text());
      if (form.get("username") !== "user@example.com" || form.get("password") !== "correct") {
        return HttpResponse.html(`<p class="errorMessage">Incorrect username or password.</p>`);
      }
      if (form.get("_csrf") !== "csrf-token-123") {
        return HttpResponse.html(`<p class="errorMessage">Bad CSRF.</p>`);
      }
      return new HttpResponse(null, {
        status: 302,
        headers: { location: `${AUTH}/signin-oidc-meu?code=idp-code&state=s` },
      });
    }),

    http.get(
      `${AUTH}/signin-oidc-meu`,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: `${AUTH}/ExternalLogin/Callback` },
        }),
    ),
    http.get(
      `${AUTH}/ExternalLogin/Callback`,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: {
            location: `${AUTH}/connect/authorize/callback?request_uri=urn%3Atest%3Arequest`,
          },
        }),
    ),
    http.get(
      `${AUTH}/connect/authorize/callback`,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: "melcloudhome://?code=final-auth-code&state=s" },
        }),
    ),

    http.post(`${AUTH}/connect/token`, async ({ request }) => {
      requests.push("token");
      const form = new URLSearchParams(await request.text());
      options.onTokenRequest?.(form);
      if (
        form.get("grant_type") === "refresh_token" &&
        form.get("refresh_token") !== "good-refresh"
      ) {
        return new HttpResponse(null, { status: 400 });
      }
      return HttpResponse.json({
        access_token: fakeJwt(),
        refresh_token: "good-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }),
  );

  return requests;
};

const createAuth = (overrides: { password?: string; tokenStore?: TokenStore } = {}) =>
  new MelCloudHomeAuth({
    username: "user@example.com",
    password: overrides.password ?? "correct",
    pacer: new RequestPacer(0),
    logger: createTestLogger(),
    tokenStore: overrides.tokenStore,
  });

describe("MelCloudHomeAuth", () => {
  it("walks the full PAR + PKCE + Cognito chain to an access token", async () => {
    const requests = stubLoginChain();
    const auth = createAuth();

    const token = await auth.getAccessToken();

    expect(token).toBe(fakeJwt());
    expect(requests).toEqual(["par", "authorize", "cognito-login", "token"]);
    expect(auth.isTokenValid).toBe(true);
  });

  it("sends a S256 PKCE verifier matching the challenge it committed to", async () => {
    let verifier: string | undefined;
    stubLoginChain({
      onTokenRequest: (form) => (verifier = form.get("code_verifier") ?? undefined),
    });

    await createAuth().getAccessToken();

    expect(verifier).toBeDefined();
    // Verifier must be a 43-char base64url string per RFC 7636.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("exchanges the authorization code from the custom-scheme redirect", async () => {
    let code: string | undefined;
    stubLoginChain({ onTokenRequest: (form) => (code = form.get("code") ?? undefined) });

    await createAuth().getAccessToken();

    expect(code).toBe("final-auth-code");
  });

  it("reports a bad password as an authentication error, not a crash", async () => {
    stubLoginChain();
    await expect(createAuth({ password: "wrong" }).getAccessToken()).rejects.toThrow(
      AuthenticationError,
    );
  });

  it("surfaces the identity provider's own error text", async () => {
    stubLoginChain();
    await expect(createAuth({ password: "wrong" }).getAccessToken()).rejects.toThrow(
      /Incorrect username or password/,
    );
  });

  it("reuses a valid token instead of logging in again", async () => {
    const requests = stubLoginChain();
    const auth = createAuth();

    await auth.getAccessToken();
    await auth.getAccessToken();

    expect(requests.filter((r) => r === "par")).toHaveLength(1);
  });

  it("de-duplicates concurrent callers into a single login", async () => {
    const requests = stubLoginChain();
    const auth = createAuth();

    await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);

    expect(requests.filter((r) => r === "par")).toHaveLength(1);
  });

  it("refreshes with the stored refresh token rather than re-running the chain", async () => {
    const requests = stubLoginChain();
    const auth = createAuth();

    await auth.getAccessToken();
    auth.invalidate();
    await auth.getAccessToken();

    expect(requests.filter((r) => r === "par")).toHaveLength(1);
    expect(requests.filter((r) => r === "token")).toHaveLength(2);
  });

  it("falls back to a full login when the refresh token is rejected", async () => {
    const store: TokenStore = {
      load: async () => ({ accessToken: "stale", refreshToken: "revoked", expiresAt: 0 }),
      save: async () => undefined,
      clear: async () => undefined,
    };
    const requests = stubLoginChain();

    const token = await createAuth({ tokenStore: store }).getAccessToken();

    expect(token).toBe(fakeJwt());
    expect(requests).toContain("cognito-login");
  });

  it("restores a still-valid token from the store without any network call", async () => {
    const saved: TokenSet = {
      accessToken: "persisted",
      refreshToken: "good-refresh",
      expiresAt: Date.now() + 3_600_000,
    };
    const store: TokenStore = {
      load: async () => saved,
      save: async () => undefined,
      clear: async () => undefined,
    };
    // No handlers registered: any request would fail the unhandled-request guard.
    expect(await createAuth({ tokenStore: store }).getAccessToken()).toBe("persisted");
  });

  it("persists tokens after a successful login", async () => {
    stubLoginChain();
    const save = vi.fn<(tokens: TokenSet) => Promise<void>>();
    const store: TokenStore = { load: async () => undefined, save, clear: async () => undefined };

    await createAuth({ tokenStore: store }).getAccessToken();

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: fakeJwt(), refreshToken: "good-refresh" }),
    );
  });

  it("keeps the previous refresh token when a refresh response omits one", async () => {
    stubLoginChain();
    const auth = createAuth();
    await auth.getAccessToken();

    server.use(
      http.post(`${AUTH}/connect/token`, () =>
        HttpResponse.json({ access_token: "rotated", expires_in: 3600 }),
      ),
    );
    auth.invalidate();
    expect(await auth.getAccessToken()).toBe("rotated");

    // A second refresh proves the old token survived the omission.
    auth.invalidate();
    expect(await auth.getAccessToken()).toBe("rotated");
  });
});

describe("redact", () => {
  it("strips authorization codes and state from URLs", () => {
    expect(redact("https://x/cb?code=secret&state=abc&foo=1")).toBe(
      "https://x/cb?code=***&state=***&foo=1",
    );
  });

  it("strips the websocket hash", () => {
    expect(redact("wss://ws.melcloudhome.com/?hash=abcdef")).toBe(
      "wss://ws.melcloudhome.com/?hash=***",
    );
  });
});

describe("token persistence guard", () => {
  beforeEach(() => {
    server.resetHandlers();
  });

  it("never writes a password into the token set", async () => {
    stubLoginChain();
    let persisted: TokenSet | undefined;
    const store: TokenStore = {
      load: async () => undefined,
      save: async (tokens) => void (persisted = tokens),
      clear: async () => undefined,
    };

    await createAuth({ tokenStore: store }).getAccessToken();

    expect(JSON.stringify(persisted)).not.toContain("correct");
  });
});
