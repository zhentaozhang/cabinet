import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("database constraints", () => {
  it("rejects a task whose assignee and auditor are the same", async () => {
    await expect(
      db.insert(tasks).values({
        id: "tsk_invalid_self_audit",
        userId: DEMO_USER_ID,
        title: "Invalid",
        description: "self audit",
        assigneeId: "ag_coach",
        auditorId: "ag_coach",
        status: "planned",
        acceptanceCriteria: "none",
        estimateMin: 25,
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        createdBy: "test",
      }),
    ).rejects.toThrow();
  });

  it("rejects negative estimated cost", async () => {
    await expect(
      db.insert(tasks).values({
        id: "tsk_invalid_cost",
        userId: DEMO_USER_ID,
        title: "Invalid",
        description: "negative cost",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        status: "planned",
        acceptanceCriteria: "none",
        estimateMin: 25,
        actionType: "internal",
        resource: "task",
        estimatedCostCents: -1,
        createdBy: "test",
      }),
    ).rejects.toThrow();
  });
});
