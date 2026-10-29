import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/health/route";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("health endpoint", () => {
  it("reports the data layer and the execution mode", async () => {
    const response = await GET();
    const body = (await response.json()) as {
      ok: boolean;
      checks: Record<string, { ok: boolean; detail: string }>;
      execution: string;
      warnings: { code: string }[];
      queue: { queued: number; staleRuns: number };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.schema.ok).toBe(true);
    expect(body.execution).toBe("inline");
    expect(body.queue.queued).toBe(0);
    expect(body.queue.staleRuns).toBe(0);
    // Missing SMTP / search providers are reported, but they must not fail the
    // probe: a monitor that cries wolf gets ignored.
    const codes = body.warnings.map((warning) => warning.code);
    expect(codes).toContain("notify.unconfigured");
  });

  it("warns that session-less requests act as the demo user, not that a production build is open", async () => {
    // This test process is not a production build, so the demo fallback in
    // `getApiUserId` is live and the probe has to say so.
    const open = (await (await GET()).json()) as { warnings: { code: string; detail: string }[] };
    const finding = open.warnings.find((warning) => warning.code === "auth.open");
    expect(finding?.detail).toContain("demo user");

    vi.stubEnv("AUTH_REQUIRED", "true");
    const closed = (await (await GET()).json()) as { warnings: { code: string }[] };
    expect(closed.warnings.map((warning) => warning.code)).not.toContain("auth.open");
  });

  it("is public: no session is required to read it", async () => {
    // The proxy exempts this path; the handler itself must never redirect or
    // demand a cookie, or a monitor would see a login page as "up".
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
