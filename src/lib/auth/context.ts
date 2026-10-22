import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DEMO_USER_ID } from "@/lib/demo";
import { UnauthorizedError } from "@/lib/domain/errors";

async function resolveUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

/**
 * Server components: require a session in production; fall back to the seeded
 * demo user only when AUTH_REQUIRED is explicitly false.
 */
export async function getPageUserId(): Promise<string> {
  const userId = await resolveUserId();
  if (userId) return userId;
  if (process.env.AUTH_REQUIRED === "true") redirect("/login");
  return DEMO_USER_ID;
}

/**
 * Route handlers: same policy, but returns 401 instead of redirecting.
 */
export async function getApiUserId(): Promise<string> {
  const userId = await resolveUserId();
  if (userId) return userId;
  if (process.env.AUTH_REQUIRED === "true") throw new UnauthorizedError();
  return DEMO_USER_ID;
}
