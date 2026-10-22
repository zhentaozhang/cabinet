import { revalidatePath } from "next/cache";
import { createTask } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      goalId?: string | null;
      title?: string;
      description?: string;
      assigneeId?: string;
      auditorId?: string;
      actionType?: string;
      resource?: string;
      estimatedCostCents?: number;
      acceptanceCriteria?: string;
      estimateMin?: number;
      dueAt?: string | null;
    };
    const task = await createTask({
      goalId: body.goalId ?? null,
      title: body.title ?? "",
      description: body.description ?? "",
      assigneeId: body.assigneeId ?? "",
      auditorId: body.auditorId ?? "",
      actionType: body.actionType ?? "internal",
      resource: body.resource ?? "task",
      estimatedCostCents: body.estimatedCostCents ?? 0,
      acceptanceCriteria: body.acceptanceCriteria ?? "",
      estimateMin: body.estimateMin ?? 25,
      dueAt: body.dueAt ?? null,
    });
    revalidatePath("/");
    revalidatePath("/cabinet");
    revalidatePath("/review");
    return Response.json({ ok: true, task });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
