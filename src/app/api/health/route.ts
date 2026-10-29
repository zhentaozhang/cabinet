import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { authOpenWarning } from "@/lib/auth/mode";
import { countQueuedJobs } from "@/server/services/commands/tasks/jobs";
import { countStaleRuns } from "@/server/services/commands/tasks/recovery";

const production = process.env.NODE_ENV === "production";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness in one answer.
 *
 * Deliberately public (see `src/proxy.ts`) because a monitor has no session, and
 * deliberately honest: a deployment whose database is unreachable, whose schema
 * lags its code, or which is quietly running on demo data must say so with a
 * non-200 status rather than a cheerful ok.
 */
export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    await db.execute(sql`select 1`);
    checks.database = { ok: true, detail: "reachable" };
  } catch (error) {
    checks.database = {
      ok: false,
      detail: error instanceof Error ? error.message : "unreachable",
    };
  }

  if (checks.database.ok) {
    try {
      // The newest table the code depends on; if the migration never ran, this
      // is where a deployment finds out instead of on the first user request.
      await db.execute(sql`select 1 from run_jobs limit 1`);
      checks.schema = { ok: true, detail: "run_jobs present" };
    } catch {
      checks.schema = {
        ok: false,
        detail: "run_jobs missing — migrations are behind the code",
      };
    }
  } else {
    checks.schema = { ok: false, detail: "not checked: no database" };
  }

  let queued = 0;
  let stale = 0;
  if (checks.database.ok && checks.schema.ok) {
    [queued, stale] = await Promise.all([countQueuedJobs(), countStaleRuns()]);
  }

  /**
   * Warnings never fail the probe: a demo deployment is configured on purpose,
   * and a monitor that cries wolf gets ignored. Failures are the two things
   * that actually break requests — no database, or a schema behind the code.
   */
  const warnings: { code: string; detail: string }[] = [];
  const demoMode = process.env.DEMO_MODE === "true";
  const authOpen = authOpenWarning();

  if (production && demoMode) {
    warnings.push({
      code: "demo.mode",
      detail: "DEMO_MODE is on in a production build — artifacts are templates.",
    });
  }
  if (authOpen) {
    warnings.push(authOpen);
  }
  if (!process.env.SMTP_HOST) {
    warnings.push({
      code: "notify.unconfigured",
      detail: "No SMTP host: notices stay queued and report 未发送.",
    });
  }
  if (!(process.env.BRAVE_API_KEY || process.env.TAVILY_API_KEY)) {
    warnings.push({
      code: "retrieval.unconfigured",
      detail: "No search provider: research runs cannot persist evidence.",
    });
  }

  const failing = ["database", "schema"].filter((name) => !checks[name]?.ok);
  const ok = failing.length === 0;

  return Response.json(
    {
      ok,
      status: ok ? "healthy" : "degraded",
      failing,
      warnings,
      latencyMs: Date.now() - started,
      checks,
      queue: { queued, staleRuns: stale },
      execution: process.env.RUN_EXECUTION === "worker" ? "worker" : "inline",
      at: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
