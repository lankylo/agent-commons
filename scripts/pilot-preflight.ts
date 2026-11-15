import { readFileSync, readdirSync } from "node:fs";
import { parseJsonc, preflight, type PilotPhase } from "../src/pilot/preflight";

// Offline pre-deployment check of a filled-in pilot Wrangler config (see docs/api.md,
// "Pilot deployment package"). Prints findings by path only, never configuration values.
const [configPath, ...rest] = process.argv.slice(2);
const phaseFlag = rest.indexOf("--phase");
const phase = (phaseFlag === -1 ? "initial" : rest[phaseFlag + 1]) as PilotPhase;
if (!configPath || (phase !== "initial" && phase !== "pilot")) {
  console.error("Usage: npm run pilot:preflight -- <config.jsonc> [--phase initial|pilot]");
  process.exit(2);
}

const forbiddenPolicies: string[] = [];
for (const local of ["wrangler.registry-local.jsonc", "wrangler.d1-local.jsonc"]) {
  try {
    const vars = (parseJsonc(readFileSync(local, "utf8")) as { vars?: Record<string, unknown> })
      .vars;
    for (const key of ["EXECUTION_DOMAIN_POLICY_JSON", "KNOWLEDGE_PERMISSION_POLICY_JSON"]) {
      const v = vars?.[key];
      if (typeof v === "string") forbiddenPolicies.push(v);
    }
  } catch {
    // Local fixture config absent: nothing to compare against.
  }
}

const result = preflight({
  configText: readFileSync(configPath, "utf8"),
  phase,
  migrationFiles: readdirSync("migrations"),
  forbiddenPolicies,
});
if (result.ok) {
  console.log(`Pilot preflight (${phase}) passed. Nothing was contacted or changed.`);
} else {
  console.error(`Pilot preflight (${phase}) FAILED:`);
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exitCode = 1;
}
