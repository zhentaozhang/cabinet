import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/notifications/run/route";
import { deliveryRunSchema } from "@/contracts/dto/aggregates";
import { resetDb } from "../helpers/db";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  const { DEMO_USER_ID } = await import("@/lib/demo");
  return { ...actual, getApiUserId: async () => DEMO_USER_ID };
});

beforeEach(async () => {
  await resetDb();
});

function runRequest(): Request {
  return new Request("http://localhost:3000/api/notifications/run", {
    method: "POST",
  });
}

describe("POST /api/notifications/run", () => {
  it("returns the whole delivery report, including lost", async () => {
    const response = await POST(runRequest());
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { ok: boolean; data: unknown };
    expect(payload.ok).toBe(true);

    // Parse against the contract instead of picking fields: a required field
    // the body forgot (lost) then fails here, rather than reaching the UI as
    // `undefined > 0` (src/components/actions/notify-actions.tsx:143).
    const report = deliveryRunSchema.parse(payload.data);
    expect(report.lost).toBe(0);
    expect(report.claimed).toBeGreaterThanOrEqual(0);
  });
});
