import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtaControlPatch } from "../src/api/types.js";
import { WriteCoalescer } from "../src/util/coalesce.js";

type Send = (patch: AtaControlPatch) => Promise<void>;

const setup = (send = vi.fn<Send>(async () => undefined)) => {
  const onError = vi.fn<(error: unknown) => void>();
  return { send, onError, writer: new WriteCoalescer(400, send, onError) };
};

describe("WriteCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges a burst of writes into a single request", async () => {
    const { send, writer } = setup();

    writer.submit({ power: true });
    writer.submit({ operationMode: "Cool" });
    writer.submit({ setTemperature: 22 });
    await vi.advanceTimersByTimeAsync(400);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      power: true,
      operationMode: "Cool",
      setTemperature: 22,
    });
  });

  it("keeps the last value when a field is written repeatedly", async () => {
    const { send, writer } = setup();

    // What dragging a temperature slider actually looks like.
    writer.submit({ setTemperature: 21 });
    writer.submit({ setTemperature: 22 });
    writer.submit({ setTemperature: 23 });
    await vi.advanceTimersByTimeAsync(400);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ setTemperature: 23 });
  });

  it("restarts the window on each write so a burst flushes once", async () => {
    const { send, writer } = setup();

    writer.submit({ power: true });
    await vi.advanceTimersByTimeAsync(300);
    writer.submit({ setTemperature: 20 });
    await vi.advanceTimersByTimeAsync(300);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when there is nothing pending", async () => {
    const { send, writer } = setup();
    await writer.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("starts a fresh patch after flushing", async () => {
    const { send, writer } = setup();

    writer.submit({ power: true });
    await vi.advanceTimersByTimeAsync(400);
    writer.submit({ setTemperature: 25 });
    await vi.advanceTimersByTimeAsync(400);

    expect(send).toHaveBeenNthCalledWith(2, { setTemperature: 25 });
  });

  it("serialises flushes so writes cannot land out of order", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const send = vi.fn<Send>(async (patch: AtaControlPatch) => {
      order.push(`start:${patch.setTemperature}`);
      if (patch.setTemperature === 20) {
        await new Promise<void>((resolve) => (release = resolve));
      }
      order.push(`end:${patch.setTemperature}`);
    });
    const writer = new WriteCoalescer(400, send, vi.fn<(error: unknown) => void>());

    writer.submit({ setTemperature: 20 });
    await vi.advanceTimersByTimeAsync(400);
    writer.submit({ setTemperature: 30 });
    await vi.advanceTimersByTimeAsync(400);

    release?.();
    await vi.runAllTimersAsync();

    // The second request must not begin before the first has finished.
    expect(order).toEqual(["start:20", "end:20", "start:30", "end:30"]);
  });

  it("reports failures without wedging later writes", async () => {
    const send = vi.fn<Send>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue();
    const { onError, writer } = setup(send);

    writer.submit({ power: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));

    writer.submit({ power: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops pending writes when disposed", async () => {
    const { send, writer } = setup();

    writer.submit({ power: true });
    writer.dispose();
    await vi.advanceTimersByTimeAsync(1000);

    expect(send).not.toHaveBeenCalled();
  });
});
