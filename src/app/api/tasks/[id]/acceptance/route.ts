import { withRequestIdHeader } from "@/lib/api/read";
import { getApiUserId } from "@/lib/auth/context";
import { NotFoundError, toErrorResponse } from "@/lib/domain/errors";
import {
  currentRequestElapsedMs,
  runWithRequestScope,
} from "@/lib/observability/context";
import { logEvent } from "@/lib/observability/log";
import { loadAcceptanceContract } from "@/server/readmodels/acceptance";

/**
 * The task's acceptance contract, as JSON or as a Markdown download.
 *
 * Both forms come from one `exportAcceptanceContract` call, so the file a
 * reviewer signs and the object a pipeline checks cannot disagree. The route is
 * hand-rolled rather than `handleQuery` because the Markdown form is not JSON.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const format = new URL(request.url).searchParams.get("format");

  const scope = async () => {
    try {
      const userId = await getApiUserId();
      const loaded = await loadAcceptanceContract(id, userId);
      if (!loaded) throw new NotFoundError("Not found");

      logEvent("info", "acceptance.ok", {
        ms: currentRequestElapsedMs(),
        checks: loaded.contract.checks.length,
        format: format === "markdown" || format === "md" ? "markdown" : "json",
      });

      if (format === "markdown" || format === "md") {
        return new Response(loaded.markdown, {
          status: 200,
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": 'attachment; filename="' + id + '.acceptance.md"',
          },
        });
      }

      return Response.json({ ok: true, data: loaded });
    } catch (error) {
      const { status, body } = toErrorResponse(error);
      logEvent("warn", "acceptance.failed", {
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
