import { revalidatePath } from "next/cache";
import { createCouncil } from "@/lib/engine";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      topic?: string;
      trigger?: string;
    };
    const council = await createCouncil({
      topic: body.topic ?? "",
      trigger: body.trigger ?? "",
    });
    revalidatePath("/");
    revalidatePath("/council");
    return Response.json({ ok: true, council });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
