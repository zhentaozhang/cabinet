import { revalidatePath } from "next/cache";
import { runTask } from "@/server/services/commands/tasks/run";
import { enqueueRun } from "@/server/services/commands/tasks/jobs";
import { handleMutation } from "@/lib/api/mutation";

/**
 * `RUN_EXECUTION=worker` makes the request durable: it is recorded and handed to
 * a worker, so a restart cannot lose it. The default stays inline so a single
 * `next start` remains a complete product.
 */
function runsInWorker(): boolean {
  return process.env.RUN_EXECUTION === "worker";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `tasks.run:${id}`,
    body,
    handler: async (userId) => {
      if (runsInWorker()) {
        const job = await enqueueRun({ userId, taskId: id });
        revalidatePath(`/tasks/${id}`);
        revalidatePath("/");
        return {
          status: 202,
          body: { ok: true, queued: true, jobId: job.jobId, existing: job.existing },
        };
      }

      const result = await runTask(id, userId);
      revalidatePath("/");
      revalidatePath("/cabinet");
      revalidatePath("/review");
      revalidatePath(`/tasks/${id}`);
      return {
        status:
          "requiresApproval" in result && result.requiresApproval ? 202 : 200,
        body: { ok: true, ...result },
      };
    },
  });
}
