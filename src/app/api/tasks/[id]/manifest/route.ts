import { and, desc, eq, inArray } from "drizzle-orm";

import { withRequestIdHeader } from "@/lib/api/read";
import { getApiUserId } from "@/lib/auth/context";
import { db } from "@/lib/db";
import { runs, steps } from "@/lib/db/schema";
import { NotFoundError, toErrorResponse } from "@/lib/domain/errors";
import {
  currentRequestElapsedMs,
  runWithRequestScope,
} from "@/lib/observability/context";
import { logEvent } from "@/lib/observability/log";
import { buildManifest } from "@/server/services/commands/tasks/manifest";

/**
 * The newest run that actually produced the deliverable.
 *
 * Audit runs are runs too, so "the latest run" is usually the audit — exporting
 * that manifest would describe the checker instead of the work. Skipping runs
 * that carry an `audit` step keeps the default pointing at the thing a person
 * means by "the manifest for this task"; a caller that wants a specific run
 * pins it with `?run=`.
 */
async function latestDeliverableRunId(taskId: string): Promise<string | null> {
  const candidates = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(20);
  if (candidates.length === 0) return null;

  const audited = await db
    .selectDistinct({ runId: steps.runId })
    .from(steps)
    .where(
      and(
        inArray(
          steps.runId,
          candidates.map((row) => row.id),
        ),
        eq(steps.type, "audit"),
      ),
    );
  const auditRuns = new Set(audited.map((row) => row.runId));
  return (candidates.find((row) => !auditRuns.has(row.id)) ?? candidates[0]).id;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const scope = async () => {
    try {
      const userId = await getApiUserId();
      const pinned = new URL(request.url).searchParams.get("run");
      const runId = pinned ?? (await latestDeliverableRunId(id));
      if (!runId) throw new NotFoundError("Not found");

      // Ownership lives in the loader: a run of another user's task and a run
      // that does not exist answer the same 404, so the route cannot be used to
      // probe for other people's run ids.
      const manifest = await buildManifest(runId, userId);
      if (!manifest || manifest.taskId !== id) throw new NotFoundError("Not found");

      logEvent("info", "manifest.ok", {
        ms: currentRequestElapsedMs(),
        runId: manifest.runId,
        steps: manifest.steps.length,
      });

      return new Response(JSON.stringify(manifest, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="' + manifest.runId + '.manifest.json"',
        },
      });
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      logEvent("warn", "manifest.failed", {
        ms: currentRequestElapsedMs(),
        status,
        code: body.code,
      });
      return Response.json(body, { status });
    }
  };

  const { result, requestId } = await runWithRequestScope(request, scope);
  return withRequestIdHeader(result, requestId);
}
