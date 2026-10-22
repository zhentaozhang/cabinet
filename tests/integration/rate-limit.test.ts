import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { DEMO_USER_ID } from "@/lib/demo";
import { RateLimitError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("rate limit", () => {
  it("allows up to the limit and rejects the next request", async () => {
    await checkRateLimit({
      userId: DEMO_USER_ID,
      action: "test-action",
      limit: 2,
      windowSeconds: 60,
    });
    await checkRateLimit({
      userId: DEMO_USER_ID,
      action: "test-action",
      limit: 2,
      windowSeconds: 60,
    });
    await expect(
      checkRateLimit({
        userId: DEMO_USER_ID,
        action: "test-action",
        limit: 2,
        windowSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});
