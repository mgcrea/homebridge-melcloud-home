import { describe, expect, it } from "vitest";
import { capabilitiesSchema, type Capabilities, type UnitState } from "../src/api/types.js";
import {
  angleToVanePosition,
  CurrentFanState,
  CurrentSlatState,
  CurrentState,
  SwingMode,
  TargetFanState,
  TargetState,
  fanSpeedStep,
  fanSpeedToPercent,
  fromTargetState,
  isSwinging,
  percentToFanSpeed,
  quantizeTemperature,
  temperatureRangeFor,
  temperatureStep,
  toCurrentFanState,
  toCurrentState,
  toTargetFanState,
  toCurrentSlatState,
  toTargetState,
  vanePositionToAngle,
} from "../src/util/mapping.js";

const capabilities = (overrides: Partial<Capabilities> = {}): Capabilities =>
  capabilitiesSchema.parse({
    numberOfFanSpeeds: 5,
    hasHalfDegreeIncrements: true,
    minTempHeat: 10,
    maxTempHeat: 31,
    minTempCoolDry: 16,
    maxTempCoolDry: 31,
    minTempAutomatic: 16,
    maxTempAutomatic: 31,
    ...overrides,
  });

const state = (overrides: Partial<UnitState> = {}): UnitState => ({
  roomTemperature: 25,
  setTemperature: 22,
  power: true,
  operationMode: "Cool",
  setFanSpeed: "Two",
  actualFanSpeed: "Two",
  vaneVerticalDirection: "Auto",
  vaneHorizontalDirection: "Centre",
  inStandbyMode: false,
  isInError: false,
  errorCode: undefined,
  ...overrides,
});

describe("operation mode", () => {
  it("round-trips the three HomeKit-native modes", () => {
    expect(fromTargetState(toTargetState("Heat"))).toBe("Heat");
    expect(fromTargetState(toTargetState("Cool"))).toBe("Cool");
    expect(fromTargetState(toTargetState("Automatic"))).toBe("Automatic");
  });

  it("maps AUTO to 'Automatic', which is what the API accepts", () => {
    expect(fromTargetState(TargetState.AUTO)).toBe("Automatic");
  });

  it("shows Dry and Fan as COOL since HomeKit has no equivalent", () => {
    expect(toTargetState("Dry")).toBe(TargetState.COOL);
    expect(toTargetState("Fan")).toBe(TargetState.COOL);
  });
});

describe("toCurrentState", () => {
  it("is INACTIVE when powered off", () => {
    expect(toCurrentState(state({ power: false }))).toBe(CurrentState.INACTIVE);
  });

  it("is IDLE when the fan has stopped at setpoint", () => {
    expect(toCurrentState(state({ actualFanSpeed: "Off" }))).toBe(CurrentState.IDLE);
  });

  it("is IDLE in standby even while the fan reports a speed", () => {
    expect(toCurrentState(state({ inStandbyMode: true }))).toBe(CurrentState.IDLE);
  });

  it("reports HEATING and COOLING for the explicit modes", () => {
    expect(toCurrentState(state({ operationMode: "Heat" }))).toBe(CurrentState.HEATING);
    expect(toCurrentState(state({ operationMode: "Cool" }))).toBe(CurrentState.COOLING);
    expect(toCurrentState(state({ operationMode: "Dry" }))).toBe(CurrentState.COOLING);
  });

  it("infers direction in Automatic from the temperature gap", () => {
    const auto = { operationMode: "Automatic" } as const;
    expect(toCurrentState(state({ ...auto, roomTemperature: 26, setTemperature: 22 }))).toBe(
      CurrentState.COOLING,
    );
    expect(toCurrentState(state({ ...auto, roomTemperature: 18, setTemperature: 22 }))).toBe(
      CurrentState.HEATING,
    );
  });
});

describe("temperature", () => {
  it("uses a different range per mode", () => {
    const caps = capabilities();
    expect(temperatureRangeFor("Heat", caps)).toEqual({ min: 10, max: 31 });
    expect(temperatureRangeFor("Cool", caps)).toEqual({ min: 16, max: 31 });
    expect(temperatureRangeFor("Automatic", caps)).toEqual({ min: 16, max: 31 });
  });

  it("steps by 0.5 only when the unit supports half degrees", () => {
    expect(temperatureStep(capabilities())).toBe(0.5);
    expect(temperatureStep(capabilities({ hasHalfDegreeIncrements: false }))).toBe(1);
  });

  it("snaps to the nearest supported step", () => {
    expect(quantizeTemperature(24.3, "Cool", capabilities())).toBe(24.5);
    expect(
      quantizeTemperature(24.3, "Cool", capabilities({ hasHalfDegreeIncrements: false })),
    ).toBe(24);
  });

  it("clamps into the range for the active mode", () => {
    // 12 degrees is legal in Heat but below the Cool minimum.
    expect(quantizeTemperature(12, "Heat", capabilities())).toBe(12);
    expect(quantizeTemperature(12, "Cool", capabilities())).toBe(16);
    expect(quantizeTemperature(40, "Heat", capabilities())).toBe(31);
  });
});

describe("fan speed", () => {
  it("maps each ordinal onto an evenly spaced percentage", () => {
    expect(fanSpeedToPercent("One", 5)).toBe(20);
    expect(fanSpeedToPercent("Three", 5)).toBe(60);
    expect(fanSpeedToPercent("Five", 5)).toBe(100);
  });

  it("round-trips every speed the unit supports", () => {
    for (const speed of ["One", "Two", "Three", "Four", "Five"] as const) {
      expect(percentToFanSpeed(fanSpeedToPercent(speed, 5), 5)).toBe(speed);
    }
  });

  it("keeps Auto off the slider", () => {
    expect(fanSpeedToPercent("Auto", 5)).toBe(0);
    expect(percentToFanSpeed(0, 5)).toBeUndefined();
  });

  it("never exceeds the number of speeds the unit has", () => {
    expect(percentToFanSpeed(100, 3)).toBe("Three");
    expect(percentToFanSpeed(90, 3)).toBe("Three");
  });

  it("derives a slider step from the speed count", () => {
    expect(fanSpeedStep(5)).toBe(20);
    expect(fanSpeedStep(3)).toBeCloseTo(33.33, 1);
  });
});

describe("swing", () => {
  it("is enabled when either vane is swinging", () => {
    expect(isSwinging(state({ vaneVerticalDirection: "Swing" }))).toBe(SwingMode.ENABLED);
    expect(isSwinging(state({ vaneHorizontalDirection: "Swing" }))).toBe(SwingMode.ENABLED);
    expect(isSwinging(state())).toBe(SwingMode.DISABLED);
  });
});

describe("fan state", () => {
  it("is inactive only when the unit is off", () => {
    expect(toCurrentFanState(state({ power: false }))).toBe(CurrentFanState.INACTIVE);
  });

  it("is idle when the unit is on but has stopped moving air", () => {
    // Reaching the setpoint parks the fan; the unit is still on, so this is
    // IDLE rather than INACTIVE.
    expect(toCurrentFanState(state({ actualFanSpeed: "Off" }))).toBe(CurrentFanState.IDLE);
    expect(toCurrentFanState(state({ inStandbyMode: true }))).toBe(CurrentFanState.IDLE);
    expect(toCurrentFanState(state({ actualFanSpeed: undefined }))).toBe(CurrentFanState.IDLE);
  });

  it("is blowing when the unit reports a real speed", () => {
    expect(toCurrentFanState(state({ actualFanSpeed: "Three" }))).toBe(CurrentFanState.BLOWING_AIR);
  });

  it("maps automatic fan speed onto the AUTO toggle", () => {
    expect(toTargetFanState("Auto")).toBe(TargetFanState.AUTO);
    expect(toTargetFanState("Three")).toBe(TargetFanState.MANUAL);
    expect(toTargetFanState(undefined)).toBe(TargetFanState.MANUAL);
  });
});

describe("vane position", () => {
  it("spreads the five positions evenly across the tilt range", () => {
    expect(vanePositionToAngle("One")).toBe(-90);
    expect(vanePositionToAngle("Three")).toBe(0);
    expect(vanePositionToAngle("Five")).toBe(90);
  });

  it("round-trips every fixed position", () => {
    for (const vane of ["One", "Two", "Three", "Four", "Five"] as const) {
      expect(angleToVanePosition(vanePositionToAngle(vane)!)).toBe(vane);
    }
  });

  it("has no angle for Auto or Swing, which are not positions", () => {
    expect(vanePositionToAngle("Auto")).toBeUndefined();
    expect(vanePositionToAngle("Swing")).toBeUndefined();
    expect(vanePositionToAngle(undefined)).toBeUndefined();
  });

  it("snaps an arbitrary angle onto the nearest position", () => {
    expect(angleToVanePosition(-80)).toBe("One");
    expect(angleToVanePosition(10)).toBe("Three");
    expect(angleToVanePosition(1000)).toBe("Five");
    expect(angleToVanePosition(-1000)).toBe("One");
  });

  it("reports the slat as swinging only while a vane is swinging", () => {
    expect(toCurrentSlatState(state({ vaneVerticalDirection: "Swing" }))).toBe(
      CurrentSlatState.SWINGING,
    );
    expect(toCurrentSlatState(state({ vaneVerticalDirection: "Three" }))).toBe(
      CurrentSlatState.FIXED,
    );
  });
});
