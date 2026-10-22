import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { logEvent } from "@/lib/obs/context";

/**
 * Liveness and readiness.
 *
 * `GET /api/health` answers "is this process up" without touching the database:
 * that probe must stay cheap and must not fail when a dependency does, or an
 * orchestrator restarts a healthy process and turns a database wobble into an
 * outage.
 *
 * `GET /api/health?deep=1` adds the dependency check and returns 503 when it
 * fails, which is the endpoint a load balancer should use.
 */

export const dynamic = "force-dynamic";

const DEEP_PROBE_TIMEOUT_MS = 800;

async function probeDatabase(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("database probe timed out")),
        DEEP_PROBE_TIMEOUT_MS,
      );
    });

    await Promise.race([db.execute(sql`select 1`), timeout]);
    return true;
  } catch (error) {
    logEvent("error", "health.database_unreachable", {
      errorMessage: error instanceof Error ? error.message : String(error),
      timeoutMs: DEEP_PROBE_TIMEOUT_MS,
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  const database = deep ? await probeDatabase() : null;
  const ok = deep ? database === true : true;

  const body = {
    ok,
    service: "cabinet",
    version:
      process.env.CABINET_VERSION ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "development",
    uptimeSeconds: Math.round(process.uptime()),
    ...(deep ? { database: database ? "up" : "down" } : {}),
  };

  return Response.json(body, {
    status: ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
