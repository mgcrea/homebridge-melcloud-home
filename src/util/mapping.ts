import type { FanSpeed, OperationMode, VaneVerticalDirection } from "../api/const.js";
import { FAN_SPEEDS } from "../api/const.js";
import type { Capabilities, UnitState } from "../api/types.js";

/**
 * Conversions between HomeKit's characteristic values and the MELCloud wire
 * vocabulary. Everything here is pure so it can be exercised without a running
 * HAP bridge — the numeric constants match `Characteristic.*` exactly.
 */

/** `Characteristic.TargetHeaterCoolerState` */
export const TargetState = { AUTO: 0, HEAT: 1, COOL: 2 } as const;

/** `Characteristic.CurrentHeaterCoolerState` */
export const CurrentState = { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 } as const;

export const toTargetState = (mode: OperationMode | undefined): number => {
  switch (mode) {
    case "Heat":
      return TargetState.HEAT;
    case "Cool":
    // Dry and Fan have no HomeKit equivalent. Both cool (or at least never
    // heat), so reporting COOL keeps the tile honest while the dedicated
    // switches expose the real mode.
    case "Dry":
    case "Fan":
      return TargetState.COOL;
    default:
      return TargetState.AUTO;
  }
};

export const fromTargetState = (value: number): OperationMode => {
  switch (value) {
    case TargetState.HEAT:
      return "Heat";
    case TargetState.COOL:
      return "Cool";
    default:
      // Note the spelling: the API rejects "Auto" for operation mode.
      return "Automatic";
  }
};

/**
 * What the unit is doing right now, as opposed to what it was asked to do.
 *
 * `ActualFanSpeed` of `Off` and `InStandbyMode` both mean the compressor has
 * reached the setpoint and stopped, which HomeKit calls IDLE.
 */
export const toCurrentState = (state: UnitState): number => {
  if (!state.power) {
    return CurrentState.INACTIVE;
  }
  const idle = state.inStandbyMode || state.actualFanSpeed === "Off";
  if (idle) {
    return CurrentState.IDLE;
  }

  switch (state.operationMode) {
    case "Heat":
      return CurrentState.HEATING;
    case "Cool":
    case "Dry":
      return CurrentState.COOLING;
    case "Fan":
      return CurrentState.IDLE;
    default:
      // In Automatic the unit does not report which way it is driving, so
      // infer it from the gap between room and target temperature.
      if (state.roomTemperature !== undefined && state.setTemperature !== undefined) {
        return state.roomTemperature > state.setTemperature
          ? CurrentState.COOLING
          : CurrentState.HEATING;
      }
      return CurrentState.IDLE;
  }
};

/** Temperature bounds depend on the mode the unit is in. */
export const temperatureRangeFor = (
  mode: OperationMode | undefined,
  capabilities: Capabilities,
): { min: number; max: number } => {
  switch (mode) {
    case "Heat":
      return { min: capabilities.minTempHeat, max: capabilities.maxTempHeat };
    case "Automatic":
      return { min: capabilities.minTempAutomatic, max: capabilities.maxTempAutomatic };
    default:
      return { min: capabilities.minTempCoolDry, max: capabilities.maxTempCoolDry };
  }
};

export const temperatureStep = (capabilities: Capabilities): number =>
  capabilities.hasHalfDegreeIncrements ? 0.5 : 1;

/** Round to the nearest step the unit accepts, then clamp into range. */
export const quantizeTemperature = (
  value: number,
  mode: OperationMode | undefined,
  capabilities: Capabilities,
): number => {
  const step = temperatureStep(capabilities);
  const { min, max } = temperatureRangeFor(mode, capabilities);
  const snapped = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, snapped));
};

// ---------------------------------------------------------------------------
// Fan speed
// ---------------------------------------------------------------------------

/**
 * HomeKit's `RotationSpeed` is a 0-100 percentage; the unit has N discrete
 * steps. Map them onto evenly spaced positions so the slider snaps to real
 * speeds instead of interpolating between them.
 *
 * `Auto` is deliberately not on the slider — it is exposed as its own switch,
 * because a 0% "off but not off" position reads as broken in the Home app and
 * gets misinterpreted by Siri.
 */
export const fanSpeedToPercent = (speed: FanSpeed | undefined, steps: number): number => {
  if (steps <= 0 || speed === undefined || speed === "Auto") {
    return 0;
  }
  const index = FAN_SPEEDS.indexOf(speed);
  return index < 1 ? 0 : Math.round((index / steps) * 100);
};

export const percentToFanSpeed = (percent: number, steps: number): FanSpeed | undefined => {
  if (steps <= 0 || percent <= 0) {
    return undefined;
  }
  const index = Math.min(steps, Math.max(1, Math.round((percent / 100) * steps)));
  return FAN_SPEEDS[index];
};

export const fanSpeedStep = (steps: number): number => (steps > 0 ? 100 / steps : 100);

/** `Characteristic.CurrentFanState` */
export const CurrentFanState = { INACTIVE: 0, IDLE: 1, BLOWING_AIR: 2 } as const;

/** `Characteristic.TargetFanState` */
export const TargetFanState = { MANUAL: 0, AUTO: 1 } as const;

/**
 * What the fan is actually doing. The unit reports `Off` for `ActualFanSpeed`
 * once it reaches the setpoint and stops, which is IDLE rather than INACTIVE —
 * the unit is still on, it just is not moving air.
 */
export const toCurrentFanState = (state: UnitState): number => {
  if (!state.power) {
    return CurrentFanState.INACTIVE;
  }
  if (state.inStandbyMode || state.actualFanSpeed === undefined || state.actualFanSpeed === "Off") {
    return CurrentFanState.IDLE;
  }
  return CurrentFanState.BLOWING_AIR;
};

/**
 * Automatic fan speed maps onto `TargetFanState`, which is what the Home app
 * renders as the AUTO/MANUAL toggle on a fan tile.
 */
export const toTargetFanState = (speed: FanSpeed | undefined): number =>
  speed === "Auto" ? TargetFanState.AUTO : TargetFanState.MANUAL;

// ---------------------------------------------------------------------------
// Swing
// ---------------------------------------------------------------------------

/** `Characteristic.SwingMode` */
export const SwingMode = { DISABLED: 0, ENABLED: 1 } as const;

export const isSwinging = (state: UnitState): number =>
  state.vaneVerticalDirection === "Swing" || state.vaneHorizontalDirection === "Swing"
    ? SwingMode.ENABLED
    : SwingMode.DISABLED;

// ---------------------------------------------------------------------------
// Vane position
// ---------------------------------------------------------------------------

/** Fixed vertical vane positions, lowest-to-highest as the unit numbers them. */
const VANE_POSITIONS = ["One", "Two", "Three", "Four", "Five"] as const;

/** Degrees between adjacent positions across the -90..90 tilt range. */
const VANE_ANGLE_STEP = 180 / (VANE_POSITIONS.length - 1);

/**
 * HomeKit describes a louver as a tilt angle from -90 to 90 degrees; the unit
 * has five discrete positions. Spread them evenly so each position lands on an
 * exact angle rather than somewhere the slider cannot reach.
 *
 * `Auto` and `Swing` are not positions and have no angle — they are carried by
 * SwingMode and CurrentSlatState instead.
 */
export const vanePositionToAngle = (
  vane: VaneVerticalDirection | undefined,
): number | undefined => {
  const index = VANE_POSITIONS.indexOf(vane as (typeof VANE_POSITIONS)[number]);
  return index < 0 ? undefined : -90 + index * VANE_ANGLE_STEP;
};

export const angleToVanePosition = (angle: number): VaneVerticalDirection => {
  const index = Math.round((angle + 90) / VANE_ANGLE_STEP);
  const clamped = Math.min(VANE_POSITIONS.length - 1, Math.max(0, index));
  return VANE_POSITIONS[clamped] as VaneVerticalDirection;
};

/** `Characteristic.CurrentSlatState` */
export const CurrentSlatState = { FIXED: 0, JAMMED: 1, SWINGING: 2 } as const;

export const toCurrentSlatState = (state: UnitState): number =>
  isSwinging(state) === SwingMode.ENABLED ? CurrentSlatState.SWINGING : CurrentSlatState.FIXED;
