import { revalidatePath } from "next/cache";
import { handleMutation } from "@/lib/api/mutation";
import { seedDemo } from "@/lib/db/seed";

/**
 * Two switches, not one.
 *
 * `seedDemo()` truncates 31 tables including `users`, and the auth gate is
 * fail-open outside production (AUTH_REQUIRED 未设时 getApiUserId 直接返回
 * DEMO_USER_ID), so a dev/staging instance with only DEMO_RESET_ENABLED=true
 * was a one-click, anonymous, whole-database wipe. Demo mode must be opted into
 * as well, and production never qualifies regardless of the flags.
 */
function isDemoResetAllowed(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DEMO_MODE === "true" &&
    process.env.DEMO_RESET_ENABLED === "true"
  );
}

export async function POST(request: Request) {
  if (!isDemoResetAllowed()) {
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
