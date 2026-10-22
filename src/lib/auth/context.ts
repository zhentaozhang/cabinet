import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { UnauthorizedError } from "@/lib/domain/errors";
import { isAuthRequired } from "./mode";

async function resolveUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

/**
 * Server components: require a session in production; fall back to the seeded
 * demo user only when AUTH_REQUIRED is explicitly false.
 */
export async function hasWorkspace(userId: string): Promise<boolean> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.userId, userId))
    .limit(1);
  return Boolean(agent);
}

export async function getPageUserId(options?: {
  allowMissingWorkspace?: boolean;
}): Promise<string> {
  const userId = await resolveUserId();
  const resolved =
    userId ??
    (isAuthRequired() ? null : DEMO_USER_ID);

  if (!resolved) redirect("/login");
  if (!options?.allowMissingWorkspace && !(await hasWorkspace(resolved))) {
    redirect("/setup");
  }
  return resolved;
}

/**
 * Route handlers: same policy, but returns 401 instead of redirecting.
 */
export async function getApiUserId(): Promise<string> {
  const userId = await resolveUserId();
  if (userId) return userId;
  if (isAuthRequired()) throw new UnauthorizedError();
  return DEMO_USER_ID;
}
