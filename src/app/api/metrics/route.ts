import { count, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { outbox, retrievalCalls, runJobs, tasks } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Operator metrics, not user data.
 *
 * Guarded by `OPS_TOKEN` rather than a session, because the caller is a
 * monitor or a dashboard that has no user. When the variable is unset the
 * route 404s: an endpoint that exists but cannot be used should not advertise
 * itself, and a missing token must never mean "open".
 */
export async function GET(request: Request) {
  const expected = process.env.OPS_TOKEN;
  if (!expected) {
    return new Response("Not found", { status: 404 });
  }
  const provided =
    request.headers.get("x-ops-token") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (!timingSafeEqual(provided, expected)) {
    return Response.json(
      { ok: false, error: "Forbidden", code: "forbidden" },
      { status: 403 },
    );
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [jobs, stale, mail, retrieval, taskRows] = await Promise.all([
    db
      .select({ status: runJobs.status, n: count() })
      .from(runJobs)
      .groupBy(runJobs.status),
    db
      .select({ n: count() })
      .from(runJobs)
      .where(sql`${runJobs.status} = 'running' and ${runJobs.leaseUntil} < now()`),
    db.select({ status: outbox.status, n: count() }).from(outbox).groupBy(outbox.status),
    db
      .select({ status: retrievalCalls.status, n: count() })
      .from(retrievalCalls)
      .where(sql`${retrievalCalls.createdAt} >= ${dayAgo.toISOString()}`)
      .groupBy(retrievalCalls.status),
    db
      .select({
        total: count(),
        running: sql<number>`count(*) filter (where ${tasks.status} = 'running')`,
      })
      .from(tasks),
  ]);

  return Response.json({
    ok: true,
    data: {
      at: new Date().toISOString(),
      jobs: toMap(jobs),
      jobsStaleLeases: Number(stale[0]?.n ?? 0),
      outbox: toMap(mail),
      retrievalLast24h: toMap(retrieval),
      tasks: {
        total: Number(taskRows[0]?.total ?? 0),
        running: Number(taskRows[0]?.running ?? 0),
      },
    },
  });
}

function toMap(rows: Array<{ status: string; n: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
}

/** Length-independent comparison, so the token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqualBytes(left, right);
}

function timingSafeEqualBytes(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}
