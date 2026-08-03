/**
 * Live smoke test against a real MELCloud Home account.
 *
 * Verifies the whole auth chain end to end and prints the units it finds. This
 * exists mainly to validate the one step that could not be captured from the
 * iOS app — credential submission to the Cognito hosted UI — without having to
 * stand up Homebridge.
 *
 *   MELCLOUD_EMAIL=you@example.com MELCLOUD_PASSWORD='…' pnpm probe
 *
 * Add DEBUG=1 for the full (redacted) request trace.
 */
import { MelCloudHomeAuth } from "../src/api/auth.js";
import { MelCloudHomeClient } from "../src/api/client.js";
import { RequestPacer } from "../src/api/pacer.js";
import { collectAtaUnits, parseUnitState } from "../src/api/types.js";

const username = process.env["MELCLOUD_EMAIL"];
const password = process.env["MELCLOUD_PASSWORD"];

if (!username || !password) {
  console.error("Set MELCLOUD_EMAIL and MELCLOUD_PASSWORD in the environment.");
  process.exit(2);
}

const verbose = process.env["DEBUG"] === "1";
const logger = {
  debug: (message: string) => {
    if (verbose) {
      console.log(`  · ${message}`);
    }
  },
  info: (message: string) => console.log(`  ${message}`),
  warn: (message: string) => console.warn(`  ! ${message}`),
};

const pacer = new RequestPacer();
const auth = new MelCloudHomeAuth({ username, password, pacer, logger });
const client = new MelCloudHomeClient({ auth, pacer, logger });

try {
  console.log("\n1. Authenticating…");
  await auth.getAccessToken();
  console.log("   ✓ access token acquired");

  console.log("\n2. Fetching context…");
  const context = await client.getContext();
  const units = collectAtaUnits(context);
  console.log(`   ✓ ${context.buildings.length} building(s), ${units.length} air-to-air unit(s)`);

  for (const { building, unit } of units) {
    const state = parseUnitState(unit);
    console.log(`\n   ${building.name} › ${unit.givenDisplayName}  (${unit.id})`);
    console.log(
      `     power=${state.power} mode=${state.operationMode} ` +
        `room=${state.roomTemperature}°C target=${state.setTemperature}°C`,
    );
    console.log(
      `     fan=${state.setFanSpeed} (actual ${state.actualFanSpeed}) ` +
        `vane=${state.vaneVerticalDirection}/${state.vaneHorizontalDirection}`,
    );
    console.log(
      `     connected=${unit.isConnected} error=${state.isInError} ` +
        `halfDegree=${unit.capabilities.hasHalfDegreeIncrements} ` +
        `fanSpeeds=${unit.capabilities.numberOfFanSpeeds}`,
    );
  }

  console.log("\n3. Fetching WebSocket hash…");
  const hash = await client.getWebSocketHash();
  console.log(`   ✓ hash acquired (${hash.length} chars)`);

  console.log("\nAll checks passed.\n");
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? `${error.name}: ${error.message}` : error}\n`);
  process.exit(1);
}
