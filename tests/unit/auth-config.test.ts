import { describe, expect, it } from "vitest";

import { auth } from "@/lib/auth";

type AuthOptions = {
  rateLimit?: { enabled?: boolean };
  emailAndPassword?: {
    requireEmailVerification?: boolean;
    sendResetPassword?: unknown;
  };
  emailVerification?: { sendVerificationEmail?: unknown };
};

const options = auth.options as unknown as AuthOptions;

describe("better-auth configuration", () => {
  it("enables the built-in rate limiter for auth endpoints", () => {
    expect(options.rateLimit?.enabled).toBe(true);
  });

  it("does not half-enable email verification or password reset", () => {
    // Both features need a mail transport. Requiring verification without
    // `sendVerificationEmail` would lock users out of the product.
    expect(options.emailAndPassword?.requireEmailVerification).not.toBe(true);
    expect(options.emailVerification?.sendVerificationEmail).toBeUndefined();
    expect(options.emailAndPassword?.sendResetPassword).toBeUndefined();
  });
});
