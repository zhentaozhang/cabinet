import { revalidatePath } from "next/cache";
import { setupWorkspace } from "@/lib/setup";
import { handleMutation } from "@/lib/api/mutation";
import { handleQueryWithRequest } from "@/lib/api/read";
import { hasWorkspace } from "@/lib/auth/context";
import { setupSchema } from "@/lib/validation/schemas";
import { parseBody } from "@/lib/validation/parse";

export async function GET(request: Request) {
  return handleQueryWithRequest(request, async (userId) => ({
    hasWorkspace: await hasWorkspace(userId),
  }));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  return handleMutation({
    request: req,
    endpoint: "workspace.setup",
    body,
    handler: async (userId) => {
      const input = parseBody(setupSchema, body);
      const result = await setupWorkspace({ userId, ...input });
      revalidatePath("/");
      revalidatePath("/cabinet");
      revalidatePath("/review");
      return { status: 200, body: { ok: true, ...result } };
    },
  });
}
