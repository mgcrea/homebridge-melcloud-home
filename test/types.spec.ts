import { describe, expect, it } from "vitest";
import {
  buildControlPayload,
  collectAtaUnits,
  contextSchema,
  parseUnitState,
} from "../src/api/types.js";
import commands from "./fixtures/commands.json" with { type: "json" };
import contextFixture from "./fixtures/context.json" with { type: "json" };

describe("contextSchema", () => {
  it("parses a real /context response", () => {
    const context = contextSchema.parse(contextFixture);
    expect(context.buildings).toHaveLength(1);
    expect(collectAtaUnits(context)).toHaveLength(3);
  });

  it("reads the capability flags that drive the HomeKit props", () => {
    const context = contextSchema.parse(contextFixture);
    const unit = collectAtaUnits(context)[0]?.unit;
    expect(unit?.capabilities).toMatchObject({
      numberOfFanSpeeds: 5,
      hasHalfDegreeIncrements: true,
      minTempHeat: 10,
      maxTempHeat: 31,
      minTempCoolDry: 16,
      maxTempCoolDry: 31,
      hasSwing: true,
    });
  });

  it("rejects a payload missing required fields", () => {
    expect(contextSchema.safeParse({ buildings: [] }).success).toBe(false);
  });
});

describe("parseUnitState", () => {
  const context = contextSchema.parse(contextFixture);
  const units = collectAtaUnits(context);

  it("collapses the name/value settings array into typed state", () => {
    const unit = units[0]?.unit;
    expect(unit).toBeDefined();
    expect(parseUnitState(unit!)).toMatchObject({
      roomTemperature: 27,
      setTemperature: 24,
      power: false,
      operationMode: "Cool",
      setFanSpeed: "One",
      actualFanSpeed: "Off",
      vaneVerticalDirection: "Auto",
      vaneHorizontalDirection: "Centre",
      inStandbyMode: false,
      isInError: false,
    });
  });

  it("parses half-degree temperatures", () => {
    const unit = units[1]?.unit;
    expect(parseUnitState(unit!).roomTemperature).toBe(27.5);
  });

  const withSettings = (settings: Record<string, string>) => ({
    ...units[0]!.unit,
    settings: Object.entries(settings).map(([name, value]) => ({ name, value })),
  });

  it("normalises numeric ordinals to the words the control API expects", () => {
    const state = parseUnitState(
      withSettings({ SetFanSpeed: "3", VaneVerticalDirection: "7", OperationMode: "Heat" }),
    );
    expect(state.setFanSpeed).toBe("Three");
    // 7 is Swing, not "Seven".
    expect(state.vaneVerticalDirection).toBe("Swing");
  });

  it("normalises American vane spellings to British", () => {
    expect(
      parseUnitState(withSettings({ VaneHorizontalDirection: "Center" })).vaneHorizontalDirection,
    ).toBe("Centre");
    expect(
      parseUnitState(withSettings({ VaneHorizontalDirection: "CenterRight" }))
        .vaneHorizontalDirection,
    ).toBe("RightCentre");
  });

  it("treats unknown enum values as absent rather than passing them through", () => {
    expect(
      parseUnitState(withSettings({ OperationMode: "Nonsense" })).operationMode,
    ).toBeUndefined();
  });

  it("parses booleans case-insensitively and blank temperatures as undefined", () => {
    const state = parseUnitState(
      withSettings({ Power: "True", InStandbyMode: "false", RoomTemperature: "" }),
    );
    expect(state.power).toBe(true);
    expect(state.inStandbyMode).toBe(false);
    expect(state.roomTemperature).toBeUndefined();
  });
});

describe("buildControlPayload", () => {
  it("always emits all eight keys with nulls for untouched fields", () => {
    expect(buildControlPayload({ power: true })).toEqual({
      power: true,
      operationMode: null,
      setFanSpeed: null,
      vaneHorizontalDirection: null,
      vaneVerticalDirection: null,
      setTemperature: null,
      temperatureIncrementOverride: null,
      inStandbyMode: null,
    });
  });

  it("reproduces every payload the official app sent", () => {
    // Each captured command should round-trip exactly: same keys, same values.
    for (const { payload } of commands) {
      const patch = Object.fromEntries(
        Object.entries(payload).filter(([, value]) => value !== null),
      );
      expect(buildControlPayload(patch)).toEqual(payload);
    }
  });

  it("uses 'Automatic' rather than 'Auto' for operation mode", () => {
    const modes = new Set(
      commands.map((c) => c.payload.operationMode).filter((m): m is string => m !== null),
    );
    expect(modes).toContain("Automatic");
    expect(modes).not.toContain("Auto");
  });
});
