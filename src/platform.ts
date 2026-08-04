import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";
import { MelCloudHomeAuth, type AuthLogger } from "./api/auth.js";
import { MelCloudHomeClient } from "./api/client.js";
import { RequestPacer } from "./api/pacer.js";
import { FileTokenStore } from "./api/token-store.js";
import { collectAtaUnits, type AtaUnit, type Building } from "./api/types.js";
import { MelCloudHomeWebSocket } from "./api/websocket.js";
import { AtaAccessory } from "./accessories/ata-accessory.js";
import { ConfigError, parseConfig, type MelCloudHomeConfig } from "./config.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

/**
 * Dynamic platform: discovers every air-to-air unit on the account and keeps
 * them in sync via a poll loop, accelerated by a real-time WebSocket.
 */
export class MelCloudHomePlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;

  readonly #config: MelCloudHomeConfig | undefined;
  readonly #cached = new Map<string, PlatformAccessory>();
  readonly #accessories = new Map<string, AtaAccessory>();

  #client: MelCloudHomeClient | undefined;
  #socket: MelCloudHomeWebSocket | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #shuttingDown = false;
  /** The discovery run in flight, and whether another was asked for meanwhile. */
  #discovering: Promise<void> | undefined;
  #rediscover = false;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    try {
      this.#config = parseConfig(config);
    } catch (error) {
      // A misconfigured platform must not take Homebridge down with it; log
      // clearly and stay dormant so the rest of the bridge keeps working.
      this.log.error(
        error instanceof ConfigError ? error.message : `Invalid configuration: ${String(error)}`,
      );
      return;
    }

    this.api.on("didFinishLaunching", () => {
      void this.#start();
    });
    this.api.on("shutdown", () => {
      this.#stop();
    });
  }

  /** Homebridge replays every cached accessory here before launch completes. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.#cached.set(accessory.UUID, accessory);
  }

  get client(): MelCloudHomeClient {
    if (!this.#client) {
      throw new Error("Platform is not initialised");
    }
    return this.#client;
  }

  get options(): MelCloudHomeConfig {
    if (!this.#config) {
      throw new Error("Platform is not configured");
    }
    return this.#config;
  }

  async #start(): Promise<void> {
    const config = this.#config;
    if (!config) {
      return;
    }

    if (config.exposeEnergy) {
      // The option is accepted so the setting survives a future release, but
      // nothing consumes it yet — say so rather than silently doing nothing.
      this.log.warn(
        "'exposeEnergy' is not implemented yet and has no effect. " +
          "The telemetry endpoint is known but its response shape has not been captured.",
      );
    }

    const logger = this.#authLogger(config.debug);
    const pacer = new RequestPacer();
    const auth = new MelCloudHomeAuth({
      username: config.email,
      password: config.password,
      pacer,
      logger,
      tokenStore: new FileTokenStore(this.api.user.storagePath(), config.email),
    });
    this.#client = new MelCloudHomeClient({ auth, pacer, logger });

    try {
      await this.#discover();
    } catch (error) {
      this.log.error(`Initial discovery failed: ${describe(error)}`);
      this.log.info("Will keep retrying on the normal poll interval.");
    }

    this.#pollTimer = setInterval(() => {
      void this.#refresh();
    }, config.pollIntervalMs);
    // Don't hold the event loop open for the sake of a poll timer.
    this.#pollTimer.unref?.();

    if (config.useWebSocket) {
      this.#startWebSocket();
    }
  }

  #stop(): void {
    this.#shuttingDown = true;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    this.#socket?.stop();
    for (const accessory of this.#accessories.values()) {
      accessory.dispose();
    }
  }

  #startWebSocket(): void {
    this.#socket = new MelCloudHomeWebSocket(
      this.client,
      this.#authLogger(this.options.debug),
      (unitId) => {
        // The frame names which settings moved, but the payload is not a full
        // state snapshot — re-read rather than trust a partial delta.
        this.log.debug(`Real-time change on unit ${unitId}`);
        void this.#refresh();
      },
      (connected) => {
        if (!connected && !this.#shuttingDown) {
          this.log.debug("Real-time updates disconnected, falling back to polling");
        }
      },
    );

    void this.#socket.run().catch((error: unknown) => {
      this.log.debug(`Real-time updates unavailable: ${describe(error)}`);
    });
  }

  /**
   * Reconcile the account against the accessories we have registered.
   *
   * Serialised, because the poll tick and every WebSocket frame both land here
   * and the first thing the run does is await the account context. Overlapping
   * runs cannot double-register — everything after that await is synchronous,
   * so they resume one after the other — but they each sweep against their own
   * snapshot, and whichever resumes last wins. A read taken before a unit was
   * added therefore unregisters the accessory the newer read just registered,
   * and the unit flaps out of HomeKit until a later pass puts it back. Frames
   * arrive in bursts, so the overlap is not hypothetical.
   *
   * A request that arrives mid-flight cannot simply join the run in progress:
   * that run may have read the account before the change it is reporting. It
   * queues exactly one more pass instead — enough to see the change, without
   * piling up a pass per frame during a burst.
   */
  async #discover(): Promise<void> {
    if (this.#discovering) {
      this.#rediscover = true;
      return this.#discovering;
    }
    const run = (async () => {
      do {
        this.#rediscover = false;
        await this.#runDiscovery();
      } while (this.#rediscover);
    })();
    this.#discovering = run;
    try {
      await run;
    } finally {
      this.#discovering = undefined;
      this.#rediscover = false;
    }
  }

  async #runDiscovery(): Promise<void> {
    const context = await this.client.getContext();
    const units = collectAtaUnits(context);

    if (units.length === 0) {
      this.log.warn("No air-to-air units found on this MELCloud Home account.");
    }

    const seen = new Set<string>();
    for (const { building, unit } of units) {
      const uuid = this.api.hap.uuid.generate(unit.id);
      seen.add(uuid);
      this.#register(uuid, building, unit);
    }

    // Anything cached that the account no longer has was removed upstream.
    for (const [uuid, accessory] of this.#cached) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.#cached.delete(uuid);
        // Drop the live wrapper too. `#register` checks `#accessories` first,
        // so leaving it behind would make a unit that comes back push values
        // into a handler bound to an accessory Homebridge no longer knows
        // about — and never register it again, so it stays invisible in
        // HomeKit until a restart. Its debounced writer would also keep its
        // timer alive for as long as the bridge runs.
        this.#accessories.get(uuid)?.dispose();
        this.#accessories.delete(uuid);
      }
    }
  }

  #register(uuid: string, building: Building, unit: AtaUnit): void {
    const existing = this.#accessories.get(uuid);
    if (existing) {
      existing.update(unit);
      return;
    }

    const cached = this.#cached.get(uuid);
    if (cached) {
      this.log.info(`Restoring ${unit.givenDisplayName}`);
      cached.context["unitId"] = unit.id;
      this.#accessories.set(uuid, new AtaAccessory(this, cached, building, unit));
      return;
    }

    this.log.info(`Adding ${building.name} › ${unit.givenDisplayName}`);
    const accessory = new this.api.platformAccessory(unit.givenDisplayName, uuid);
    accessory.context["unitId"] = unit.id;
    this.#accessories.set(uuid, new AtaAccessory(this, accessory, building, unit));
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.#cached.set(uuid, accessory);
  }

  /** Poll tick: re-read everything and push fresh values into HomeKit. */
  async #refresh(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    try {
      // Discovery is idempotent and also picks up units added in the app.
      await this.#discover();
    } catch (error) {
      this.log.debug(`Refresh failed: ${describe(error)}`);
    }
  }

  #authLogger(debug: boolean): AuthLogger {
    return {
      debug: (message) => {
        if (debug) {
          this.log.info(`[debug] ${message}`);
        } else {
          this.log.debug(message);
        }
      },
      info: (message) => this.log.info(message),
      warn: (message) => this.log.warn(message),
    };
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
