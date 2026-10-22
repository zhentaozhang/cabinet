import { revalidatePath } from "next/cache";
import { createGoal } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      title?: string;
      why?: string;
      target?: string;
      horizon?: string;
      domain?: string;
    };
    const goal = await createGoal({
      title: body.title ?? "",
      why: body.why ?? "",
      target: body.target ?? "",
      horizon: body.horizon ?? "",
      domain: body.domain ?? "learning",
    });
    revalidatePath("/");
    revalidatePath("/review");
    return Response.json({ ok: true, goal });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
