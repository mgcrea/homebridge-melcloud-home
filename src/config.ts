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
  exposeVaneControl: boolean;
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
    // The Home app does not render fan speed or swing on a Heater Cooler, so a
    // Fan service is the only way to reach them natively. It folds into the
    // same control as the Heater Cooler rather than appearing separately,
    // because the Heater Cooler is marked the primary service.
    exposeFanService: boolean(config["exposeFanService"], true),
    // Off by default, and the reason is a dead end rather than a preference.
    // HAP's louver service (Slats) is not drawn by the Home app at all, so the
    // only visible representation is a second Fan — which renders as another
    // identical fan slider. ConfiguredName, the characteristic the Home app
    // uses to label a service, is not permitted on Fanv2, so the two cannot
    // even be told apart. Available for anyone who wants it anyway.
    exposeVaneControl: boolean(config["exposeVaneControl"], false),
    // The Heater Cooler already reports room temperature, so a separate sensor
    // is a duplicate reading. Opt in when a distinct sensor is wanted for
    // automations or history.
    exposeTemperatureSensors: boolean(config["exposeTemperatureSensors"], false),
    // Opt-in: each is another control on the accessory, and the mode they set
    // is already reachable from the Heater Cooler's own mode picker.
    exposeDrySwitch: boolean(config["exposeDrySwitch"], false),
    exposeFanSwitch: boolean(config["exposeFanSwitch"], false),
    exposeAutoFanSwitch: boolean(config["exposeAutoFanSwitch"], false),
    exposeEnergy: boolean(config["exposeEnergy"], false),
    debug: boolean(config["debug"], false),
  };
};
