import { describe, expect, it, vi } from "vitest";
import { RequestPacer } from "../src/api/pacer.js";

describe("RequestPacer", () => {
  it("returns the task result", async () => {
    await expect(new RequestPacer(0).run(async () => 42)).resolves.toBe(42);
  });

  it("runs tasks in submission order", async () => {
    const pacer = new RequestPacer(0);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        pacer.run(async () => {
          order.push(n);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3]);
  });

  it("never overlaps two tasks", async () => {
    const pacer = new RequestPacer(0);
    let running = 0;
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        pacer.run(async () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          running -= 1;
        }),
      ),
    );

    expect(maxConcurrent).toBe(1);
  });

  it("keeps the queue alive after a task rejects", async () => {
    const pacer = new RequestPacer(0);

    await expect(pacer.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // A rejected task must not wedge everything queued behind it.
    await expect(pacer.run(async () => "ok")).resolves.toBe("ok");
  });

  it("enforces the minimum gap between consecutive requests", async () => {
    vi.useFakeTimers();
    try {
      const pacer = new RequestPacer(500);
      const started: number[] = [];
      const record = () =>
        pacer.run(async () => {
          started.push(Date.now());
        });

      const all = Promise.all([record(), record(), record()]);
      await vi.advanceTimersByTimeAsync(2000);
      await all;

      expect(started).toHaveLength(3);
      expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(500);
      expect(started[2]! - started[1]!).toBeGreaterThanOrEqual(500);
    } finally {
      vi.useRealTimers();
    }
  });
});
