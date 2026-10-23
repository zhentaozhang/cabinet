import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/metrics/route";

const original = process.env.OPS_TOKEN;

describe("operator metrics", () => {
  beforeEach(() => {
    delete process.env.OPS_TOKEN;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OPS_TOKEN;
    else process.env.OPS_TOKEN = original;
  });

  it("does not exist when no token is configured", async () => {
    const response = await GET(new Request("http://x/api/metrics"));
    expect(response.status).toBe(404);
  });

  it("refuses a wrong or missing token once configured", async () => {
    process.env.OPS_TOKEN = "s3cret-token";

    const missing = await GET(new Request("http://x/api/metrics"));
    const wrong = await GET(
      new Request("http://x/api/metrics", { headers: { "x-ops-token": "nope" } }),
    );
    const sameLength = await GET(
      new Request("http://x/api/metrics", { headers: { "x-ops-token": "s3cret-tokeX" } }),
    );

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(sameLength.status).toBe(403);
  });

  it("reports queue, mail and retrieval state to a caller with the token", async () => {
    process.env.OPS_TOKEN = "s3cret-token";

    const response = await GET(
      new Request("http://x/api/metrics", { headers: { "x-ops-token": "s3cret-token" } }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        jobs: Record<string, number>;
        jobsStaleLeases: number;
        outbox: Record<string, number>;
        retrievalLast24h: Record<string, number>;
        tasks: { total: number; running: number };
      };
    };

    expect(payload.ok).toBe(true);
    // Shape, not values: these counts legitimately differ per run.
    expect(typeof payload.data.jobs).toBe("object");
    expect(payload.data.jobsStaleLeases).toBeGreaterThanOrEqual(0);
    expect(typeof payload.data.outbox).toBe("object");
    expect(typeof payload.data.retrievalLast24h).toBe("object");
    expect(payload.data.tasks.total).toBeGreaterThanOrEqual(0);
  });

  it("accepts a bearer token as well as the header", async () => {
    process.env.OPS_TOKEN = "s3cret-token";

    const response = await GET(
      new Request("http://x/api/metrics", {
        headers: { authorization: "Bearer s3cret-token" },
      }),
    );
    expect(response.status).toBe(200);
  });
});
