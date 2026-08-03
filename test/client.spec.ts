import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { MelCloudHomeAuth } from "../src/api/auth.js";
import { MelCloudHomeClient } from "../src/api/client.js";
import { ApiError, AuthenticationError, ServiceUnavailableError } from "../src/api/errors.js";
import { RequestPacer } from "../src/api/pacer.js";
import { createTestLogger } from "./helpers.js";
import { server } from "./msw-server.js";
import contextFixture from "./fixtures/context.json" with { type: "json" };

const BFF = "https://mobile.bff.melcloudhome.com";

const createClient = (auth?: Partial<MelCloudHomeAuth>) => {
  const invalidate = vi.fn<() => void>();
  const stub = {
    getAccessToken: vi.fn<() => Promise<string>>(async () => "test-token"),
    invalidate,
    ...auth,
  } as unknown as MelCloudHomeAuth;
  return {
    invalidate,
    getAccessToken: stub.getAccessToken,
    client: new MelCloudHomeClient({
      auth: stub,
      pacer: new RequestPacer(0),
      logger: createTestLogger(),
    }),
  };
};

describe("getContext", () => {
  it("parses a real context response", async () => {
    server.use(http.get(`${BFF}/context`, () => HttpResponse.json(contextFixture)));
    const { client } = createClient();

    const context = await client.getContext();

    expect(context.buildings[0]?.airToAirUnits).toHaveLength(3);
  });

  it("sends the bearer token", async () => {
    let authorization: string | null = null;
    server.use(
      http.get(`${BFF}/context`, ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json(contextFixture);
      }),
    );

    await createClient().client.getContext();

    expect(authorization).toBe("Bearer test-token");
  });

  it("fails loudly when the response shape changes", async () => {
    server.use(http.get(`${BFF}/context`, () => HttpResponse.json({ unexpected: true })));

    await expect(createClient().client.getContext()).rejects.toThrow(ApiError);
  });

  it("maps 5xx to a transient error", async () => {
    server.use(http.get(`${BFF}/context`, () => new HttpResponse(null, { status: 503 })));

    await expect(createClient().client.getContext()).rejects.toThrow(ServiceUnavailableError);
  });
});

describe("401 handling", () => {
  it("refreshes and retries once, then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${BFF}/context`, () => {
        attempts += 1;
        return attempts === 1
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json(contextFixture);
      }),
    );
    const { client, invalidate } = createClient();

    await client.getContext();

    expect(attempts).toBe(2);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("gives up with an authentication error after a second 401", async () => {
    let attempts = 0;
    server.use(
      http.get(`${BFF}/context`, () => {
        attempts += 1;
        return new HttpResponse(null, { status: 401 });
      }),
    );

    await expect(createClient().client.getContext()).rejects.toThrow(AuthenticationError);
    // One retry, not an infinite loop.
    expect(attempts).toBe(2);
  });
});

describe("controlAtaUnit", () => {
  it("PUTs the full eight-key payload with nulls for untouched fields", async () => {
    let body: unknown;
    server.use(
      http.put(`${BFF}/monitor/ataunit/:unitId`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await createClient().client.controlAtaUnit("unit-1", { power: true, setTemperature: 24.5 });

    expect(body).toEqual({
      power: true,
      operationMode: null,
      setFanSpeed: null,
      vaneHorizontalDirection: null,
      vaneVerticalDirection: null,
      setTemperature: 24.5,
      temperatureIncrementOverride: null,
      inStandbyMode: null,
    });
  });

  it("targets the right unit and tolerates the empty 204 body", async () => {
    let path: string | undefined;
    server.use(
      http.put(`${BFF}/monitor/ataunit/:unitId`, ({ params }) => {
        path = String(params["unitId"]);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(
      createClient().client.controlAtaUnit("abc-123", { power: false }),
    ).resolves.toBeUndefined();
    expect(path).toBe("abc-123");
  });
});

describe("getWebSocketHash", () => {
  const HASH_URL = "https://6x2dgdulg7omjsxalnhmo4ynba0dcgwk.lambda-url.eu-west-1.on.aws/";

  it("accepts a bare string body", async () => {
    server.use(http.get(HASH_URL, () => new HttpResponse("raw-hash-value")));
    expect(await createClient().client.getWebSocketHash()).toBe("raw-hash-value");
  });

  it("accepts a JSON envelope", async () => {
    server.use(http.get(HASH_URL, () => HttpResponse.json({ hash: "json-hash" })));
    expect(await createClient().client.getWebSocketHash()).toBe("json-hash");
  });

  it("accepts a JSON string body", async () => {
    server.use(http.get(HASH_URL, () => HttpResponse.json("quoted-hash")));
    expect(await createClient().client.getWebSocketHash()).toBe("quoted-hash");
  });

  it("errors on an empty body rather than opening a socket with no credential", async () => {
    server.use(http.get(HASH_URL, () => new HttpResponse("")));
    await expect(createClient().client.getWebSocketHash()).rejects.toThrow(ApiError);
  });
});
