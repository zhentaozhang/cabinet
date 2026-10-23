import { revalidatePath } from "next/cache";
import { updateAgent } from "@/server/services/commands/agents";
import { handleMutation } from "@/lib/api/mutation";
import { handleQueryWithRequest } from "@/lib/api/read";
import { agentUpdateSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";
import { loadAgent } from "@/server/readmodels";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleQueryWithRequest(request, (userId) => loadAgent(id, userId));
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: `agents.update:${id}`,
    body,
    handler: async (userId) => {
      const input = parseBody(agentUpdateSchema, body);
      const agent = await updateAgent(id, input, userId);
      revalidatePath("/cabinet");
      revalidatePath(`/cabinet/${id}`);
      revalidatePath("/");
      return { status: 200, body: { ok: true, agent } };
    },
  });
}
