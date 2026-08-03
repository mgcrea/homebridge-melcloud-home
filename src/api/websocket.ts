import { WebSocket, type RawData } from "ws";
import { redact, type AuthLogger } from "./auth.js";
import { WS_HOST } from "./const.js";
import type { MelCloudHomeClient } from "./client.js";
import { sleep } from "./pacer.js";

/** Called with the unit that changed and the names of the settings that moved. */
export type DeltaHandler = (unitId: string, changed: string[]) => void;
export type ConnectionHandler = (connected: boolean) => void;

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;
const HEARTBEAT_MS = 30_000;

/**
 * A session must last this long before we treat it as healthy. Without this, a
 * server that accepts the upgrade and immediately hangs up looks like a clean
 * session every time, and we would reconnect at the initial backoff forever —
 * each attempt costing a hash fetch and possibly a token refresh.
 */
const STABLE_SESSION_MS = 60_000;

/**
 * Real-time state push, used as an accelerator over polling.
 *
 * When someone changes a unit from the physical remote or the official app, the
 * platform pushes a `unitStateChanged` frame here within a second or two, which
 * beats waiting up to a minute for the next poll.
 *
 * Strictly best-effort: polling remains the source of truth, so every failure
 * mode here just backs off and retries. The server also drops the connection at
 * a hard two-hour API Gateway cap, which is normal and not worth logging as an
 * error.
 */
export class MelCloudHomeWebSocket {
  #socket: WebSocket | undefined;
  #closing = false;
  #connected = false;
  #backoff = INITIAL_BACKOFF_MS;

  constructor(
    private readonly client: MelCloudHomeClient,
    private readonly logger: AuthLogger,
    private readonly onDelta: DeltaHandler,
    private readonly onConnectionChange?: ConnectionHandler,
  ) {}

  get connected(): boolean {
    return this.#connected;
  }

  /** Run until `stop()` is called, reconnecting as needed. */
  async run(): Promise<void> {
    while (!this.#closing) {
      const startedAt = Date.now();
      try {
        await this.#connectOnce();
      } catch (error) {
        this.logger.debug(`WebSocket session ended: ${redact(errorMessage(error))}`);
      }

      this.#setConnected(false);
      if (this.#closing) {
        return;
      }

      if (Date.now() - startedAt >= STABLE_SESSION_MS) {
        this.#backoff = INITIAL_BACKOFF_MS;
      }
      // Jitter so a platform-wide disconnect doesn't stampede on reconnect.
      await sleep(this.#backoff * (0.8 + Math.random() * 0.4));
      this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
    }
  }

  stop(): void {
    this.#closing = true;
    this.#socket?.close();
    this.#socket = undefined;
  }

  async #connectOnce(): Promise<void> {
    const hash = await this.client.getWebSocketHash();
    const socket = new WebSocket(`${WS_HOST}/?hash=${encodeURIComponent(hash)}`, {
      handshakeTimeout: 15_000,
    });
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      const heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.ping();
        }
      }, HEARTBEAT_MS);

      const settle = (error?: Error) => {
        clearInterval(heartbeat);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      socket.on("open", () => {
        this.logger.info("Real-time updates connected");
        this.#setConnected(true);
      });
      socket.on("message", (data: RawData) => {
        this.#handleFrame(data.toString());
      });
      socket.on("error", (error: Error) => settle(error));
      socket.on("close", () => settle());
    });
  }

  #handleFrame(raw: string): void {
    for (const { unitId, changed } of parseDeltaFrame(raw)) {
      this.onDelta(unitId, changed);
    }
  }

  #setConnected(connected: boolean): void {
    if (this.#connected === connected) {
      return;
    }
    this.#connected = connected;
    this.onConnectionChange?.(connected);
  }
}

export type UnitDelta = { unitId: string; changed: string[] };

/**
 * Pull `unitStateChanged` deltas out of a text frame.
 *
 * Tolerant by design: frames arrive either bare or batched in an array, the
 * payload key has been seen as both `Data` and `data`, and anything malformed
 * is skipped rather than allowed to tear down the session.
 */
export const parseDeltaFrame = (raw: string): UnitDelta[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }

  const deltas: UnitDelta[] = [];
  for (const item of Array.isArray(payload) ? payload : [payload]) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const frame = item as { messageType?: unknown; Data?: unknown; data?: unknown };
    if (frame.messageType !== "unitStateChanged") {
      continue;
    }

    const data = (frame.Data ?? frame.data) as Record<string, unknown> | undefined;
    const unitId = typeof data?.["unitId"] === "string" ? data["unitId"] : undefined;
    if (!unitId) {
      continue;
    }

    const changed = Array.isArray(data?.["changedSettings"])
      ? (data["changedSettings"] as unknown[]).filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    deltas.push({ unitId, changed });
  }
  return deltas;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
