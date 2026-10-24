/**
 * The one background entry point.
 *
 * Everything that has to happen on a schedule happens here — abandoned runs
 * recovered, expired approvals settled, exhausted jobs failed, the three TTL
 * tables pruned. One process, one pass, no long-lived timers: a `setInterval`
 * inside the web process dies with the process and silently stops maintaining
 * anything, which is exactly how these sweeps came to have no caller in the
 * first place.
 *
 * Safe to run every minute: every step is conditional and idempotent, so a pass
 * with nothing to do writes nothing.
 *
 *   pnpm tick              # one pass (this is the default)
 *   pnpm tick --once       # the same pass, spelled like the other scripts
 *
 * Exit code is 0 unless EVERY step failed, which in practice means the database
 * is unreachable. One broken step is reported (and counted) but must not turn
 * the cron job red: the other five still had work to do.
 */
// A CLI process has no Next runtime: load the same env the app would see.
import "../src/lib/env";

import { runTick } from "../src/server/jobs/maintenance";

function main(): Promise<void> {
  // `--once` is accepted for consistency with run:worker / notify:deliver. A
  // one-shot pass is the only mode this script has, so the flag changes nothing.
  const once = process.argv.includes("--once");

  return runTick().then((report) => {
    for (const step of report.steps) {
      const detail = step.detail
        ? ` ${JSON.stringify(step.detail)}`
        : "";
      const suffix = step.ok ? "" : ` — ${step.error}`;
      console.log(
        `${step.ok ? "ok  " : "FAIL"} ${step.step.padEnd(20)} ${String(step.count).padStart(4)}${detail}${suffix}`,
      );
    }

    console.log(
      JSON.stringify({
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        once,
        ok: report.ok,
        failed: report.failed,
        counts: Object.fromEntries(
          report.steps.map((step) => [step.step, step.count]),
        ),
      }),
    );

    process.exit(report.allFailed ? 1 : 0);
  });
}

main().catch((error) => {
  // `runSteps` swallows step failures, so reaching this means the pass itself
  // could not be built — a missing env, an import-time crash. That is a failed
  // tick by definition.
  console.error("[tick] failed", error);
  process.exit(1);
});
