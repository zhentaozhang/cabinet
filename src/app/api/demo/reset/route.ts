import { revalidatePath } from "next/cache";
import { handleMutation } from "@/lib/api/mutation";
import { seedDemo } from "@/lib/db/seed";
import { demoResetAllowed } from "@/lib/demo";

// 开关的判断在 `src/lib/demo.ts`：侧边栏要用同一个答案决定按钮显示不显示。

export async function POST(request: Request) {
  if (!demoResetAllowed()) {
    return Response.json(
      { ok: false, error: "Not available", code: "not_found" },
      { status: 404 },
    );
  }

  // Reuse the mutation pipeline so the reset is authenticated, same-origin
  // guarded and rate limited. Idempotency-Key stays optional.
  return handleMutation({
    request,
    endpoint: "demo.reset",
    handler: async () => {
      await seedDemo();
      for (const path of ["/", "/cabinet", "/review", "/memory", "/council"]) {
        revalidatePath(path);
      }
      return { status: 200, body: { ok: true } };
    },
  });
}
