import "../src/lib/env";

import { deliverOutbox } from "../src/server/services/commands/delivery";

/**
 * The only thing that sends mail.
 *
 * Run it from a scheduler (cron, a platform "scheduled task", a k8s CronJob),
 * never from a timer inside the web process: a `setInterval` dies with the
 * process and silently drops everything queued while it was down.
 *
 *   npm run notify:deliver              # deliver due rows
 *   npm run notify:deliver -- --dry-run # show what would happen
 *   npm run notify:deliver -- --limit=50
 */
function parseArgs(argv: string[]): { dryRun: boolean; limit?: number } {
  const dryRun = argv.includes("--dry-run");
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  return { dryRun, limit: Number.isFinite(limit) ? limit : undefined };
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));
  const report = await deliverOutbox({ dryRun, limit });

  for (const step of report.steps) {
    const suffix =
      step.result === "failed" || step.result === "skipped"
        ? ` — ${step.reason}`
        : step.result === "deferred"
          ? ` — ${step.reason}，改到 ${step.nextAttemptAt.toISOString()}`
          : "";
    console.log(`${step.result.padEnd(11)} ${step.kind.padEnd(10)} ${step.id}${suffix}`);
  }

  console.log(
    JSON.stringify({
      dryRun,
      claimed: report.claimed,
      sent: report.sent,
      failed: report.failed,
      skipped: report.skipped,
      deferred: report.deferred,
    }),
  );

  // A failed delivery is expected during an outage; the row keeps its retry
  // schedule. Only an unusable environment should make the cron job red.
  process.exit(0);
}

main().catch((error) => {
  console.error("[notify:deliver] failed", error);
  process.exit(1);
});
