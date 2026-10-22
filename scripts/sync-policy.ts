import "../src/lib/env";
import { POLICY_KEYS, syncPolicyConfig } from "../src/lib/policy/sync";

/**
 * `pnpm db:sync-policy [--check]`
 *
 * Adds policy settings that exist in the running build but are missing from
 * this database. Settings added to an existing group never get their own
 * migration, and `getPolicyConfig()` fails closed on a missing key, so an older
 * workspace answers every page with a 500 until this runs.
 *
 * Additive only: existing operator values are never overwritten, so the command
 * is safe to run repeatedly and safe against production.
 */
const check = process.argv.includes("--check");

async function main() {
  const report = await syncPolicyConfig(undefined, { dryRun: check });
  const drift = report.inserted.length + report.patched.length;

  if (drift === 0) {
    console.log(
      `policy_config is complete (${report.unchanged.length}/${POLICY_KEYS.length} groups checked).`,
    );
    return 0;
  }

  if (report.inserted.length > 0) {
    console.log(
      `${check ? "missing" : "created"} groups: ${report.inserted.join(", ")}`,
    );
  }
  for (const entry of report.patched) {
    console.log(
      `${check ? "missing" : "added"} settings: ${entry.key} → ${entry.added.join(", ")}`,
    );
  }

  if (check) {
    console.error(
      `policy_config is behind this build (${drift} group(s)). Run \`pnpm db:sync-policy\` to fix.`,
    );
    return 1;
  }
  console.log(`Synced ${drift} group(s); other values left untouched.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
