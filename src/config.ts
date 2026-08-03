import type { PlatformConfig } from "homebridge";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WRITE_DEBOUNCE_MS,
  MIN_POLL_INTERVAL_MS,
} from "./api/const.js";

export type MelCloudHomeConfig = {
  email: string;
  password: string;
  pollIntervalMs: number;
  writeDebounceMs: number;
  useWebSocket: boolean;
  exposeFanService: boolean;
  exposeTemperatureSensors: boolean;
  exposeDrySwitch: boolean;
  exposeFanSwitch: boolean;
  exposeAutoFanSwitch: boolean;
  exposeEnergy: boolean;
  debug: boolean;
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const boolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/**
 * Validate and normalise the raw config.json block.
 *
 * Homebridge hands plugins whatever the user typed, so anything that would
 * later surface as a confusing runtime failure is rejected here with a message
 * that says what to fix.
 */
export const parseConfig = (config: PlatformConfig): MelCloudHomeConfig => {
  const email = typeof config["email"] === "string" ? config["email"].trim() : "";
  const password = typeof config["password"] === "string" ? config["password"] : "";

  if (!email || !password) {
    throw new ConfigError(
      "Both 'email' and 'password' are required — use your MELCloud Home account credentials.",
    );
  }

  const pollSeconds = Number(config["pollInterval"] ?? DEFAULT_POLL_INTERVAL_MS / 1000);
  const pollIntervalMs = Number.isFinite(pollSeconds)
    ? Math.max(MIN_POLL_INTERVAL_MS, pollSeconds * 1000)
    : DEFAULT_POLL_INTERVAL_MS;

  return {
    email,
    password,
    pollIntervalMs,
    writeDebounceMs: DEFAULT_WRITE_DEBOUNCE_MS,
    useWebSocket: boolean(config["useWebSocket"], true),
    // The Home app does not render fan speed or swing on a Heater Cooler tile,
    // so a Fan service is the only way to reach them natively. On by default:
    // without it, airflow control is unreachable outside third-party apps.
    exposeFanService: boolean(config["exposeFanService"], true),
    // The Heater Cooler tile already reports room temperature, so a separate
    // sensor is a duplicate reading on its own tile. Opt in when a distinct
    // sensor is wanted for automations or history.
    exposeTemperatureSensors: boolean(config["exposeTemperatureSensors"], false),
    // HomeKit gives every service of a bridged accessory its own tile, so these
    // are opt-in: three extra toggles per unit buries the thermostat itself.
    exposeDrySwitch: boolean(config["exposeDrySwitch"], false),
    exposeFanSwitch: boolean(config["exposeFanSwitch"], false),
    exposeAutoFanSwitch: boolean(config["exposeAutoFanSwitch"], false),
    exposeEnergy: boolean(config["exposeEnergy"], false),
    debug: boolean(config["debug"], false),
  };
};
