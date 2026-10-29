import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { POST } from "@/app/api/demo/reset/route";
import { db } from "@/lib/db";
import { demoResetAllowed } from "@/lib/demo";
import { goals } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

// `revalidatePath` needs Next's static-generation store, which does not exist
// in a plain vitest process; the gate below is what this file exercises.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// The gate runs before the mutation pipeline, so reaching the handler at all
// requires neutralising the pipeline's own authentication: it reads
// `headers()`, which throws outside a request scope. Everything else in the
// pipeline (rate limit, idempotency, handler) stays real.
vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  const { DEMO_USER_ID } = await import("@/lib/demo");
  return { ...actual, getApiUserId: async () => DEMO_USER_ID };
});

const saved = {
  demoReset: process.env.DEMO_RESET_ENABLED,
  demoMode: process.env.DEMO_MODE,
  nodeEnv: process.env.NODE_ENV,
};

// @types/node marks NODE_ENV as read-only; tests still need to exercise the
// production branch.
const env = process.env as Record<string, string | undefined>;

function restore(): void {
  if (saved.demoReset === undefined) delete process.env.DEMO_RESET_ENABLED;
  else process.env.DEMO_RESET_ENABLED = saved.demoReset;
  if (saved.demoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = saved.demoMode;
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

  it("is a 404 when DEMO_RESET_ENABLED=true but DEMO_MODE is not", async () => {
    // The single switch used to be enough: outside production the API answers
    // as DEMO_USER_ID for an anonymous caller, so this was a public
    // TRUNCATE-everything endpoint on any dev/staging instance.
    process.env.DEMO_RESET_ENABLED = "true";
    delete process.env.DEMO_MODE;
    env.NODE_ENV = "development";

    const response = await POST(resetRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("stays a 404 in production even when both switches are on", async () => {
    process.env.DEMO_RESET_ENABLED = "true";
    process.env.DEMO_MODE = "true";
    env.NODE_ENV = "production";
    try {
      const response = await POST(resetRequest());
      expect(response.status).toBe(404);
    } finally {
      if (saved.nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = saved.nodeEnv;
    }
  });

  it("runs the reset when both switches are on outside production", async () => {
    await resetDb();
    // Seed data that the reset must overwrite, so a 200 that skipped
    // `seedDemo()` cannot pass this test.
    await db.update(goals).set({ title: "tampered" }).where(eq(goals.id, "goal_rag"));

    process.env.DEMO_RESET_ENABLED = "true";
    process.env.DEMO_MODE = "true";
    env.NODE_ENV = "development";

    const response = await POST(resetRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });

    const [goal] = await db.select().from(goals).where(eq(goals.id, "goal_rag"));
    expect(goal.title).toBe("6 周学会 RAG");
  });
});

describe("demoResetAllowed", () => {
  it("is false unless both switches are on", () => {
    delete process.env.DEMO_MODE;
    delete process.env.DEMO_RESET_ENABLED;
    env.NODE_ENV = "development";
    expect(demoResetAllowed()).toBe(false);

    process.env.DEMO_MODE = "true";
    expect(demoResetAllowed()).toBe(false);

    delete process.env.DEMO_MODE;
    process.env.DEMO_RESET_ENABLED = "true";
    expect(demoResetAllowed()).toBe(false);
  });

  it("is true when both switches are on outside production", () => {
    process.env.DEMO_MODE = "true";
    process.env.DEMO_RESET_ENABLED = "true";
    env.NODE_ENV = "development";

    expect(demoResetAllowed()).toBe(true);
  });

  it("is false in production even when both switches are on", () => {
    process.env.DEMO_MODE = "true";
    process.env.DEMO_RESET_ENABLED = "true";
    env.NODE_ENV = "production";

    expect(demoResetAllowed()).toBe(false);
  });
});

describe("the reset button answers to the endpoint's own switch", () => {
  const read = (path: string): string =>
    readFileSync(join(process.cwd(), path), "utf8");

  it("does not show the button on the strength of the session alone", () => {
    const shell = read("src/components/shell/index.tsx");

    expect(shell).toContain("demoResetEnabled &&");
    expect(shell).not.toContain("const showReset = !sessionUser");
  });

  it("gets that flag from the server layout, not from the client", () => {
    expect(read("src/app/layout.tsx")).toContain(
      "demoResetEnabled={demoResetAllowed()}",
    );
  });
});
