import { z } from "zod";
import {
  FAN_SPEEDS,
  OPERATION_MODES,
  ORDINAL_TO_WORD,
  VANE_HORIZONTAL_ALIASES,
  VANE_HORIZONTAL_DIRECTIONS,
  VANE_VERTICAL_DIRECTIONS,
  type FanSpeed,
  type OperationMode,
  type VaneHorizontalDirection,
  type VaneVerticalDirection,
} from "./const.js";

/**
 * Per-unit capability flags. These drive the HomeKit characteristic props, so a
 * unit only ever advertises what it can actually do.
 */
export const capabilitiesSchema = z.object({
  isMultiSplitSystem: z.boolean().default(false),
  isLegacyDevice: z.boolean().default(false),
  hasStandby: z.boolean().default(false),
  hasCoolOperationMode: z.boolean().default(true),
  hasHeatOperationMode: z.boolean().default(true),
  hasAutoOperationMode: z.boolean().default(true),
  hasDryOperationMode: z.boolean().default(false),
  hasAutomaticFanSpeed: z.boolean().default(false),
  hasAirDirection: z.boolean().default(false),
  hasSwing: z.boolean().default(false),
  hasExtendedTemperatureRange: z.boolean().default(false),
  hasEnergyConsumedMeter: z.boolean().default(false),
  numberOfFanSpeeds: z.number().int().min(0).default(0),
  minTempCoolDry: z.number().default(16),
  maxTempCoolDry: z.number().default(31),
  minTempHeat: z.number().default(10),
  maxTempHeat: z.number().default(31),
  minTempAutomatic: z.number().default(16),
  maxTempAutomatic: z.number().default(31),
  hasDemandSideControl: z.boolean().default(false),
  hasHalfDegreeIncrements: z.boolean().default(false),
  supportsWideVane: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** `settings` arrives as a flat list of stringly-typed name/value pairs. */
const settingSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const ataUnitSchema = z.object({
  id: z.string(),
  givenDisplayName: z.string(),
  displayIcon: z.string().nullish(),
  systemId: z.string().nullish(),
  connectedInterfaceType: z.string().nullish(),
  connectedInterfaceIdentifier: z.string().nullish(),
  timeZone: z.string().nullish(),
  rssi: z.number().nullish(),
  isConnected: z.boolean().default(true),
  isInError: z.boolean().default(false),
  isEnergyUsageCompatible: z.boolean().default(false),
  capabilities: capabilitiesSchema,
  settings: z.array(settingSchema).default([]),
});
export type AtaUnit = z.infer<typeof ataUnitSchema>;

export const buildingSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string().nullish(),
  airToAirUnits: z.array(ataUnitSchema).default([]),
  // Air-to-water (heat pump) units are recognised but not yet supported.
  airToWaterUnits: z.array(z.unknown()).default([]),
});
export type Building = z.infer<typeof buildingSchema>;

export const contextSchema = z.object({
  id: z.string(),
  firstname: z.string().nullish(),
  lastname: z.string().nullish(),
  email: z.string().nullish(),
  country: z.string().nullish(),
  buildings: z.array(buildingSchema).default([]),
  guestBuildings: z.array(buildingSchema).default([]),
});
export type Context = z.infer<typeof contextSchema>;

/**
 * The normalised view of a unit's `settings` array — parsed, spelling-corrected
 * and typed. This is what the accessories actually consume.
 */
export type UnitState = {
  roomTemperature: number | undefined;
  setTemperature: number | undefined;
  power: boolean;
  operationMode: OperationMode | undefined;
  setFanSpeed: FanSpeed | undefined;
  /** The speed the unit is really running at; `Off` when idle. */
  actualFanSpeed: string | undefined;
  vaneVerticalDirection: VaneVerticalDirection | undefined;
  vaneHorizontalDirection: VaneHorizontalDirection | undefined;
  inStandbyMode: boolean;
  isInError: boolean;
  errorCode: string | undefined;
};

/** The control payload. Every key is always present; `null` means "leave alone". */
export type AtaControlPayload = {
  power: boolean | null;
  operationMode: OperationMode | null;
  setFanSpeed: FanSpeed | null;
  vaneHorizontalDirection: VaneHorizontalDirection | null;
  vaneVerticalDirection: VaneVerticalDirection | null;
  setTemperature: number | null;
  temperatureIncrementOverride: number | null;
  inStandbyMode: boolean | null;
};

/** A control request with only the fields the caller wants to change. */
export type AtaControlPatch = Partial<AtaControlPayload>;

const EMPTY_PAYLOAD: AtaControlPayload = {
  power: null,
  operationMode: null,
  setFanSpeed: null,
  vaneHorizontalDirection: null,
  vaneVerticalDirection: null,
  setTemperature: null,
  temperatureIncrementOverride: null,
  inStandbyMode: null,
};

/**
 * Expand a patch into the full eight-key payload the API insists on. Sending a
 * partial object is rejected, so untouched fields must be explicitly `null`.
 */
export const buildControlPayload = (patch: AtaControlPatch): AtaControlPayload => ({
  ...EMPTY_PAYLOAD,
  ...patch,
});

const parseBoolean = (value: string | undefined): boolean => value?.toLowerCase() === "true";

const parseNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Map an ordinal-or-word value onto a known enum member.
 *
 * `/context` mixes representations: `"3"`, `"Three"` and (for horizontal vanes)
 * `"Center"` can all describe the same position. Control requests only accept
 * the canonical word, so normalise on the way in.
 */
const normalizeEnum = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  aliases: Record<string, string> = {},
): T | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }
  const candidate = aliases[value] ?? ORDINAL_TO_WORD[value] ?? value;
  return (allowed as readonly string[]).includes(candidate) ? (candidate as T) : undefined;
};

/** Collapse the `{name, value}` pairs into a typed state object. */
export const parseUnitState = (unit: AtaUnit): UnitState => {
  const settings = new Map(unit.settings.map(({ name, value }) => [name, value]));
  const get = (name: string) => settings.get(name);

  return {
    roomTemperature: parseNumber(get("RoomTemperature")),
    setTemperature: parseNumber(get("SetTemperature")),
    power: parseBoolean(get("Power")),
    operationMode: normalizeEnum(get("OperationMode"), OPERATION_MODES),
    setFanSpeed: normalizeEnum(get("SetFanSpeed"), FAN_SPEEDS),
    actualFanSpeed: get("ActualFanSpeed"),
    vaneVerticalDirection: normalizeEnum(get("VaneVerticalDirection"), VANE_VERTICAL_DIRECTIONS),
    vaneHorizontalDirection: normalizeEnum(
      get("VaneHorizontalDirection"),
      VANE_HORIZONTAL_DIRECTIONS,
      VANE_HORIZONTAL_ALIASES,
    ),
    inStandbyMode: parseBoolean(get("InStandbyMode")),
    isInError: parseBoolean(get("IsInError")) || unit.isInError,
    errorCode: get("ErrorCode") || undefined,
  };
};

/** Flatten every building (owned and guest) down to a list of A/C units. */
export const collectAtaUnits = (context: Context): { building: Building; unit: AtaUnit }[] =>
  [...context.buildings, ...context.guestBuildings].flatMap((building) =>
    building.airToAirUnits.map((unit) => ({ building, unit })),
  );
