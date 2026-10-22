import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, memories, tasks, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { saveCheckin } from "@/server/services/commands/checkins";
import { setupWorkspace } from "@/lib/setup";
import { ValidationError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("check-in", () => {
  it("rejects a task that belongs to another user", async () => {
    await db.insert(users).values({
      id: "usr_checkin_other",
      email: "checkin-other@cabinet.local",
      name: "Other",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await db.insert(tasks).values({
      id: "tsk_checkin_other",
      userId: "usr_checkin_other",
      title: "Other user's task",
      description: "Must not be mutated by another tenant.",
      status: "planned",
      acceptanceCriteria: "有产物",
      estimateMin: 25,
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      createdBy: "user",
    });

    await expect(
      saveCheckin(
        {
          energy: 3,
          mood: 3,
          note: "",
          completed: [{ taskId: "tsk_checkin_other", done: true }],
        },
        DEMO_USER_ID,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_checkin_other"));
    expect(task.status).toBe("planned");
  });

  it("does not bypass the audit state machine for a planned task", async () => {
    await saveCheckin(
      {
        energy: 3,
        mood: 3,
        note: "",
        completed: [{ taskId: "tsk_exercise", done: true }],
      },
      DEMO_USER_ID,
    );

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_exercise"));
    expect(task.status).toBe("planned");
  });

  it("allows the accepted -> done transition", async () => {
    await db
      .update(tasks)
      .set({ status: "accepted" })
      .where(eq(tasks.id, "tsk_read"));

    await saveCheckin(
      {
        energy: 3,
        mood: 3,
        note: "",
        completed: [{ taskId: "tsk_read", done: true }],
      },
      DEMO_USER_ID,
    );

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.status).toBe("done");
  });

  it("writes memory to the user's actual coach, not a demo id", async () => {
    const userId = "usr_checkin_new";
    await db.insert(users).values({
      id: userId,
      email: "checkin-new@cabinet.local",
      name: "New",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });
    await setupWorkspace({ userId, timezone: "Asia/Shanghai" });

    const [coach] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.role, "coach")));

    await saveCheckin(
      {
        energy: 2,
        mood: 3,
        note: "今天有点累",
        completed: [],
      },
      userId,
    );

    const [memory] = await db
      .select()
      .from(memories)
      .where(eq(memories.userId, userId));
    expect(memory.agentId).toBe(coach.id);
  });
});
