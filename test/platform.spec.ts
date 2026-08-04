import type { API, PlatformAccessory, PlatformConfig } from "homebridge";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AtaUnit, Building, Context } from "../src/api/types.js";

/**
 * Stub the layers this spec is not about.
 *
 * These tests cover the platform's bookkeeping — which accessories it
 * registers, which it removes, and what it does to its own tables — so the
 * OAuth dance, the HTTP client and the HAP service wiring are all replaced.
 * Building the real `AtaAccessory` alone would need fakes for every
 * `getService`/`addService`/`getCharacteristic` call in a 646-line file.
 */
const { getContext, disposed, updated } = vi.hoisted(() => ({
  getContext: vi.fn<() => Promise<Context>>(),
  disposed: [] as string[],
  updated: [] as string[],
}));

vi.mock("../src/api/auth.js", () => ({
  MelCloudHomeAuth: class {
    // The platform only constructs it and hands it to the client, which is
    // itself stubbed — nothing here ever needs a token.
    readonly stub = true;
  },
}));
vi.mock("../src/api/client.js", () => ({
  MelCloudHomeClient: class {
    getContext = getContext;
  },
}));
vi.mock("../src/accessories/ata-accessory.js", () => ({
  AtaAccessory: class {
    constructor(
      _platform: unknown,
      readonly accessory: { UUID: string },
      _building: unknown,
      _unit: unknown,
    ) {}
    update(): void {
      updated.push(this.accessory.UUID);
    }
    dispose(): void {
      disposed.push(this.accessory.UUID);
    }
  },
}));

const { MelCloudHomePlatform } = await import("../src/platform.js");

type ApiCall = { op: "register" | "update" | "unregister"; uuids: string[] };

class FakePlatformAccessory {
  context: Record<string, unknown> = {};
  constructor(
    public displayName: string,
    public UUID: string,
  ) {}
}

const createFakeApi = () => {
  const calls: ApiCall[] = [];
  const listeners = new Map<string, () => void>();
  const record = (op: ApiCall["op"]) => (accessories: { UUID: string }[]) => {
    calls.push({ op, uuids: accessories.map((accessory) => accessory.UUID) });
  };
  const api = {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: (value: string) => `uuid:${value}` },
    },
    user: { storagePath: () => "/tmp/melcloud-home-spec" },
    platformAccessory: FakePlatformAccessory,
    on: (event: string, callback: () => void) => {
      listeners.set(event, callback);
      return api;
    },
    registerPlatformAccessories: (_p: string, _pl: string, accessories: { UUID: string }[]) =>
      record("register")(accessories),
    updatePlatformAccessories: record("update"),
    unregisterPlatformAccessories: (_p: string, _pl: string, accessories: { UUID: string }[]) =>
      record("unregister")(accessories),
  };
  return { api, calls, listeners };
};

const createFakeLog = () => {
  const messages: string[] = [];
  const log = ((message: string) => messages.push(message)) as never as Record<string, unknown> & {
    messages: string[];
  };
  log.messages = messages;
  for (const level of ["info", "warn", "error", "debug", "success", "log"]) {
    log[level] = (message: string) => messages.push(message);
  }
  return log;
};

const POLL_INTERVAL_MS = 60_000;

const config = {
  platform: "MELCloudHome",
  email: "someone@example.com",
  password: "s3cret",
  pollInterval: POLL_INTERVAL_MS / 1000,
  // The WebSocket is the other entry point into discovery; the poll timer
  // exercises the same re-entrancy without opening a socket.
  useWebSocket: false,
} as unknown as PlatformConfig;

/** Yield until the platform's fire-and-forget promise chains have drained. */
const drain = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick++) {
    await Promise.resolve();
  }
};

const unit = (id: string): AtaUnit => ({ id, givenDisplayName: `Unit ${id}` }) as AtaUnit;

const contextWith = (...units: AtaUnit[]): Context =>
  ({
    buildings: [{ name: "Home", airToAirUnits: units } as unknown as Building],
    guestBuildings: [],
  }) as unknown as Context;

const createPlatform = () => {
  const { api, calls, listeners } = createFakeApi();
  const log = createFakeLog();
  const platform = new MelCloudHomePlatform(log as never, config, api as unknown as API);
  /** Run `didFinishLaunching` and wait for the discovery it kicks off. */
  const start = async () => {
    listeners.get("didFinishLaunching")!();
    // `#start` is fired with `void`, so yield until its awaits have drained.
    await drain();
  };
  return { platform, calls, log, api, start };
};

/**
 * `registerPlatformAccessories` is the only call that stamps an accessory's
 * plugin association, and `updatePlatformAccessories` on an unassociated
 * accessory aborts Homebridge's whole cache write. Restored accessories carry
 * the association from deserialization, so they are seeded as already known.
 */
const expectNoPrematureUpdate = (calls: ApiCall[], restored: string[] = []): void => {
  const registered = new Set(restored);
  for (const call of calls) {
    if (call.op === "register") {
      call.uuids.forEach((uuid) => registered.add(uuid));
    }
    if (call.op === "update") {
      for (const uuid of call.uuids) {
        expect(registered.has(uuid), `persisted ${uuid} before registering it`).toBe(true);
      }
    }
  }
};

describe("MelCloudHomePlatform", () => {
  beforeEach(() => {
    disposed.length = 0;
    updated.length = 0;
    getContext.mockReset();
  });

  it("registers a newly discovered unit exactly once", async () => {
    getContext.mockResolvedValue(contextWith(unit("a")));
    const { calls, start } = createPlatform();

    await start();

    expect(calls).toEqual([{ op: "register", uuids: ["uuid:a"] }]);
    expectNoPrematureUpdate(calls);
  });

  it("does not re-register a unit on the next discovery pass", async () => {
    getContext.mockResolvedValue(contextWith(unit("a")));
    const { calls, start } = createPlatform();

    await start();
    await start();

    expect(calls.filter((call) => call.op === "register")).toHaveLength(1);
    expect(updated).toContain("uuid:a");
  });

  it("does not remove a unit on the strength of a stale overlapping read", async () => {
    // The poll tick and every WebSocket frame both land in discovery, and the
    // first thing it does is await the account context. Two runs that overlap
    // there each sweep against their own snapshot, so whichever resumes last
    // wins — and an older snapshot taken before a unit was added removes the
    // accessory the newer one just registered.
    vi.useFakeTimers();
    try {
      // Empty account on the initial pass, so the poll timer exists before the
      // unit ever shows up.
      getContext.mockResolvedValueOnce(contextWith());
      const { calls, start } = createPlatform();
      await start();
      expect(calls).toEqual([]);

      let releaseStale!: (context: Context) => void;
      let releaseFresh!: (context: Context) => void;
      getContext.mockReturnValueOnce(
        new Promise<Context>((resolve) => {
          releaseStale = resolve;
        }),
      );
      getContext.mockReturnValueOnce(
        new Promise<Context>((resolve) => {
          releaseFresh = resolve;
        }),
      );
      getContext.mockResolvedValue(contextWith(unit("a")));

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      // The newer read lands first and registers the unit; the older one then
      // resumes still believing the account is empty.
      releaseFresh(contextWith(unit("a")));
      await drain();
      releaseStale(contextWith());
      await drain();

      expect(calls.map((call) => call.op)).toEqual(["register"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a unit that disappeared from the account", async () => {
    getContext.mockResolvedValueOnce(contextWith(unit("a")));
    getContext.mockResolvedValue(contextWith());
    const { calls, start } = createPlatform();

    await start();
    await start();

    expect(calls.map((call) => call.op)).toEqual(["register", "unregister"]);
    expect(disposed).toContain("uuid:a");
  });

  it("registers a unit again after it came back", async () => {
    getContext.mockResolvedValueOnce(contextWith(unit("a")));
    getContext.mockResolvedValueOnce(contextWith());
    getContext.mockResolvedValue(contextWith(unit("a")));
    const { calls, start } = createPlatform();

    await start();
    await start();
    await start();

    // Without the wrapper being dropped on removal, the third pass short-circuits
    // on the stale handler and the unit never comes back in HomeKit.
    expect(calls.map((call) => call.op)).toEqual(["register", "unregister", "register"]);
    expectNoPrematureUpdate(calls);
  });

  it("adopts an accessory Homebridge restored instead of registering a new one", async () => {
    getContext.mockResolvedValue(contextWith(unit("a")));
    const { platform, calls, start } = createPlatform();
    const cached = new FakePlatformAccessory("Unit a", "uuid:a");
    platform.configureAccessory(cached as unknown as PlatformAccessory);

    await start();

    expect(calls).toEqual([]);
    expect(cached.context["unitId"]).toBe("a");
  });
});
