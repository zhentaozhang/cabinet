import { revalidatePath } from "next/cache";
import { saveCheckin } from "@/lib/engine";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      energy?: number;
      mood?: number;
      completed?: Array<{ taskId: string; done: boolean }>;
      note?: string;
    };
    await saveCheckin({
      energy: body.energy ?? 3,
      mood: body.mood ?? 3,
      completed: body.completed ?? [],
      note: body.note ?? "",
    });
    revalidatePath("/");
    revalidatePath("/memory");
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 400 },
    );
  }
}
