import { MIN_REQUEST_INTERVAL_MS } from "./const.js";

/**
 * Serialises requests and enforces a floor on the gap between them.
 *
 * The whole platform sits behind AWS API Gateway, which throttles aggressively.
 * A HomeKit scene can fire a dozen characteristic writes at once, so without
 * this the first thing a user does after adding the plugin is get rate limited.
 */
export class RequestPacer {
  #queue: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(private readonly minIntervalMs: number = MIN_REQUEST_INTERVAL_MS) {}

  /** Run `task` once the pacing gap has elapsed, excluding all other callers. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      const elapsed = Date.now() - this.#lastRequestAt;
      if (elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }
      // Stamped before the request so the gap is measured start-to-start;
      // a slow request must not earn the next one a free pass.
      this.#lastRequestAt = Date.now();
      return task();
    });

    // Keep the chain alive even when a task rejects, otherwise one failure
    // would wedge every subsequent request behind a rejected promise.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
