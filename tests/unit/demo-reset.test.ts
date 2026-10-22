import { afterEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/demo/reset/route";

const saved = {
  demoReset: process.env.DEMO_RESET_ENABLED,
  nodeEnv: process.env.NODE_ENV,
};

// @types/node marks NODE_ENV as read-only; tests still need to exercise the
// production branch.
const env = process.env as Record<string, string | undefined>;

function restore(): void {
  if (saved.demoReset === undefined) delete process.env.DEMO_RESET_ENABLED;
  else process.env.DEMO_RESET_ENABLED = saved.demoReset;
  if (saved.nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = saved.nodeEnv;
}

afterEach(restore);

function resetRequest(): Request {
  return new Request("http://localhost:3000/api/demo/reset", {
    method: "POST",
  });
}

describe("demo reset endpoint", () => {
  it("is a 404 unless DEMO_RESET_ENABLED=true", async () => {
    delete process.env.DEMO_RESET_ENABLED;

    const response = await POST(resetRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("stays a 404 in production even when enabled", async () => {
    process.env.DEMO_RESET_ENABLED = "true";
    env.NODE_ENV = "production";
    try {
      const response = await POST(resetRequest());
      expect(response.status).toBe(404);
    } finally {
      if (saved.nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = saved.nodeEnv;
    }
  });
});
