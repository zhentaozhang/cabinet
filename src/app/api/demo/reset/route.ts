import { revalidatePath } from "next/cache";
import { seedDemo } from "@/lib/db/seed";

export async function POST() {
  try {
    await seedDemo();
    for (const path of ["/", "/cabinet", "/review", "/memory", "/council"]) {
      revalidatePath(path);
    }
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "reset failed" },
      { status: 500 },
    );
  }
}
