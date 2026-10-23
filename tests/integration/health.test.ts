import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
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

  it("is public: no session is required to read it", async () => {
    // The proxy exempts this path; the handler itself must never redirect or
    // demand a cookie, or a monitor would see a login page as "up".
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
