import type { PlatformConfig } from "homebridge";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const config = (overrides: Record<string, unknown> = {}): PlatformConfig =>
  ({
    platform: "MELCloudHome",
    email: "user@example.com",
    password: "secret",
    ...overrides,
  }) as PlatformConfig;

describe("parseConfig", () => {
  it("accepts a minimal config and applies defaults", () => {
    expect(parseConfig(config())).toMatchObject({
      email: "user@example.com",
      pollIntervalMs: 60_000,
      useWebSocket: true,
      // Opt-in: each of these is an extra HomeKit tile per unit.
      exposeTemperatureSensors: false,
      exposeDrySwitch: false,
      exposeFanSwitch: false,
      exposeAutoFanSwitch: false,
      exposeEnergy: false,
      debug: false,
    });
  });

  it("requires both credentials", () => {
    expect(() => parseConfig(config({ email: "" }))).toThrow(ConfigError);
    expect(() => parseConfig(config({ password: undefined }))).toThrow(ConfigError);
  });

  it("explains what to fix rather than failing obscurely", () => {
    expect(() => parseConfig(config({ email: "" }))).toThrow(/'email' and 'password' are required/);
  });

  it("trims a pasted email", () => {
    expect(parseConfig(config({ email: "  user@example.com " })).email).toBe("user@example.com");
  });

  it("converts the poll interval from seconds to milliseconds", () => {
    expect(parseConfig(config({ pollInterval: 90 })).pollIntervalMs).toBe(90_000);
  });

  it("clamps an aggressive poll interval to the rate-limit floor", () => {
    expect(parseConfig(config({ pollInterval: 5 })).pollIntervalMs).toBe(30_000);
  });

  it("falls back to the default when the interval is not a number", () => {
    expect(parseConfig(config({ pollInterval: "often" })).pollIntervalMs).toBe(60_000);
  });

  it("honours explicitly disabled features", () => {
    expect(
      parseConfig(config({ useWebSocket: false, exposeDrySwitch: false, exposeEnergy: true })),
    ).toMatchObject({ useWebSocket: false, exposeDrySwitch: false, exposeEnergy: true });
  });

  it("ignores non-boolean values for toggles", () => {
    expect(parseConfig(config({ useWebSocket: "yes" })).useWebSocket).toBe(true);
  });
});
