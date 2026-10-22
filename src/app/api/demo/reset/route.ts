import { revalidatePath } from "next/cache";
import { handleMutation } from "@/lib/api/mutation";
import { seedDemo } from "@/lib/db/seed";

export async function POST(request: Request) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DEMO_RESET_ENABLED !== "true"
  ) {
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
