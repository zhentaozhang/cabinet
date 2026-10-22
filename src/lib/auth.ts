import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  throw new Error(
    "BETTER_AUTH_SECRET is required. Add it to .env.local before starting Cabinet.",
  );
}

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    // `requireEmailVerification` and `sendResetPassword` are intentionally not
    // enabled: this deployment has no mail transport, so turning them on would
    // lock users out (verification) or silently drop reset links. Wire an
    // email provider first, then add `emailVerification.sendVerificationEmail`
    // and `emailAndPassword.sendResetPassword` together.
  },
  rateLimit: {
    // better-auth only enables its own limiter in production by default; turn
    // it on everywhere so /sign-in, /sign-up and password-reset endpoints are
    // covered in staging too. The default in-memory store is per-process; a
    // multi-instance deployment should switch to `storage: "database"` after
    // adding the `rateLimit` model, or provide `secondaryStorage`.
    enabled: true,
  },
  secret,
  baseURL,
  // Multi-domain deployments add their origins through TRUSTED_ORIGINS; the
  // login endpoint itself rejects any other origin.
  trustedOrigins: [
    ...new Set([
      baseURL,
      ...(process.env.TRUSTED_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim().replace(/\/$/, ""))
        .filter(Boolean),
    ]),
  ],
  session: {
    expiresIn: 60 * 60 * 24 * 7,
  },
  plugins: [nextCookies()],
});
