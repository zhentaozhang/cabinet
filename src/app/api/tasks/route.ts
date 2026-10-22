import { revalidatePath } from "next/cache";
import { createTask } from "@/server/services/commands/tasks/create";
import { handleMutation } from "@/lib/api/mutation";
import { taskCreateSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: "tasks.create",
    body,
    handler: async (userId) => {
      const input = parseBody(taskCreateSchema, body);
      const task = await createTask(
        {
          ...input,
          goalId: input.goalId ?? null,
          dueAt: input.dueAt ?? null,
        },
        userId,
      );
      revalidatePath("/");
      revalidatePath("/cabinet");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, task } };
    },
  });
}
