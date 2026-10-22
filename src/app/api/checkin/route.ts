import { revalidatePath } from "next/cache";
import { saveCheckin } from "@/lib/engine";
import { getApiUserId } from "@/lib/auth/context";
import { toErrorResponse } from "@/lib/domain/errors";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      energy?: number;
      mood?: number;
      completed?: Array<{ taskId: string; done: boolean }>;
      note?: string;
    };
    const userId = await getApiUserId();
    await saveCheckin(
      {
        energy: body.energy ?? 3,
        mood: body.mood ?? 3,
        completed: body.completed ?? [],
        note: body.note ?? "",
      },
      userId,
    );
    revalidatePath("/");
    revalidatePath("/memory");
    return Response.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return Response.json(body, { status });
  }
}
