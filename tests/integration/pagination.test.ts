import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_USER_ID } from "@/lib/demo";
import { getMemoryData } from "@/server/services/queries/memory";
import { getReviewData } from "@/server/services/queries/review";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("list pagination", () => {
  it("pages memories without changing the total count", async () => {
    const first = await getMemoryData(DEMO_USER_ID, undefined, "current", {
      limit: 2,
      offset: 0,
    });
    const second = await getMemoryData(DEMO_USER_ID, undefined, "current", {
      limit: 2,
      offset: 2,
    });

    expect(first.memories).toHaveLength(2);
    expect(first.total).toBeGreaterThan(2);
    expect(first.hasMore).toBe(true);
    expect(second.offset).toBe(2);
    expect(second.memories.map((m) => m.id)).not.toEqual(
      first.memories.map((m) => m.id),
    );
  });

  it("pages review insights and dissents independently", async () => {
    const data = await getReviewData(DEMO_USER_ID, {
      limit: 1,
      insightOffset: 0,
      dissentOffset: 0,
    });

    expect(data.insights).toHaveLength(1);
    expect(data.dissents).toHaveLength(1);
    expect(data.insightTotal).toBeGreaterThan(1);
    expect(data.dissentTotal).toBeGreaterThan(0);
    expect(data.limit).toBe(1);
  });
});
