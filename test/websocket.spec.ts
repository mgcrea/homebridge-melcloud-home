import { describe, expect, it } from "vitest";
import { parseDeltaFrame } from "../src/api/websocket.js";

const frame = (body: unknown) => JSON.stringify(body);

describe("parseDeltaFrame", () => {
  it("reads a unitStateChanged frame", () => {
    expect(
      parseDeltaFrame(
        frame({
          messageType: "unitStateChanged",
          Data: { unitId: "unit-1", changedSettings: ["Power", "SetTemperature"] },
        }),
      ),
    ).toEqual([{ unitId: "unit-1", changed: ["Power", "SetTemperature"] }]);
  });

  it("accepts the lower-case data key", () => {
    expect(
      parseDeltaFrame(
        frame({ messageType: "unitStateChanged", data: { unitId: "unit-2", changedSettings: [] } }),
      ),
    ).toEqual([{ unitId: "unit-2", changed: [] }]);
  });

  it("handles a batch of frames", () => {
    const deltas = parseDeltaFrame(
      frame([
        { messageType: "unitStateChanged", Data: { unitId: "a", changedSettings: ["Power"] } },
        { messageType: "unitStateChanged", Data: { unitId: "b", changedSettings: ["Power"] } },
      ]),
    );

    expect(deltas.map((d) => d.unitId)).toEqual(["a", "b"]);
  });

  it("ignores unrelated message types", () => {
    expect(parseDeltaFrame(frame({ messageType: "heartbeat", Data: { unitId: "a" } }))).toEqual([]);
  });

  it("ignores a frame with no unit id", () => {
    expect(parseDeltaFrame(frame({ messageType: "unitStateChanged", Data: {} }))).toEqual([]);
  });

  it("survives malformed JSON rather than throwing", () => {
    expect(parseDeltaFrame("not json at all")).toEqual([]);
    expect(parseDeltaFrame("")).toEqual([]);
  });

  it("survives null and primitive frames", () => {
    expect(parseDeltaFrame("null")).toEqual([]);
    expect(parseDeltaFrame("42")).toEqual([]);
    expect(parseDeltaFrame(frame([null, 1, "x"]))).toEqual([]);
  });

  it("drops non-string entries from changedSettings", () => {
    expect(
      parseDeltaFrame(
        frame({
          messageType: "unitStateChanged",
          Data: { unitId: "a", changedSettings: ["Power", 3, null] },
        }),
      ),
    ).toEqual([{ unitId: "a", changed: ["Power"] }]);
  });

  it("defaults changedSettings to an empty list when absent", () => {
    expect(
      parseDeltaFrame(frame({ messageType: "unitStateChanged", Data: { unitId: "a" } })),
    ).toEqual([{ unitId: "a", changed: [] }]);
  });
});
