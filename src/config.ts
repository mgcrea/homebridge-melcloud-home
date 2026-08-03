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
    exposeTemperatureSensors: boolean(config["exposeTemperatureSensors"], true),
    exposeDrySwitch: boolean(config["exposeDrySwitch"], true),
    exposeFanSwitch: boolean(config["exposeFanSwitch"], true),
    exposeAutoFanSwitch: boolean(config["exposeAutoFanSwitch"], true),
    exposeEnergy: boolean(config["exposeEnergy"], false),
    debug: boolean(config["debug"], false),
  };
};
