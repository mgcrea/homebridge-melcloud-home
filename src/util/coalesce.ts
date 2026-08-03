import type { AtaControlPatch } from "../api/types.js";

/**
 * Buffers control changes and flushes them as a single request.
 *
 * HomeKit writes one characteristic at a time: changing mode and temperature
 * together arrives as two separate `set` handlers milliseconds apart, and a
 * scene can fire half a dozen. Sending one PUT each is slow, invites rate
 * limiting, and — on a multi-split system where several indoor units share an
 * outdoor unit — a power change landing separately from its mode change can
 * fault the compressor. The API accepts every field in one payload, so merge.
 */
export class WriteCoalescer {
  #pending: AtaControlPatch = {};
  #timer: NodeJS.Timeout | undefined;
  #flush: Promise<void> | undefined;

  constructor(
    private readonly delayMs: number,
    private readonly send: (patch: AtaControlPatch) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  /**
   * Queue a change. Later values for the same field win, which matches what a
   * user dragging a slider expects.
   */
  submit(patch: AtaControlPatch): void {
    this.#pending = { ...this.#pending, ...patch };

    // Restart the window so a burst of writes flushes once, after it settles.
    if (this.#timer) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      void this.flush();
    }, this.delayMs);
  }

  /** Send whatever is buffered now, without waiting for the timer. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    const patch = this.#pending;
    this.#pending = {};
    if (Object.keys(patch).length === 0) {
      return this.#flush ?? Promise.resolve();
    }

    // Chain onto any in-flight send so two flushes can't race and land out of
    // order — the API applies writes in arrival order with no revision check.
    const previous = this.#flush ?? Promise.resolve();
    this.#flush = previous
      .catch(() => undefined)
      .then(() => this.send(patch))
      .catch((error: unknown) => {
        this.onError(error);
      });
    return this.#flush;
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pending = {};
  }
}
