import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, checkins, memories, tasks, users } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { saveCheckin } from "@/server/services/commands/checkins";
import { setupWorkspace } from "@/lib/setup";
import { ValidationError } from "@/lib/domain/errors";
import { localDateKey } from "@/lib/domain/time";
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

  it("upserts the same local day instead of duplicating rows", async () => {
    await saveCheckin(
      { energy: 2, mood: 2, note: "第一次", completed: [] },
      DEMO_USER_ID,
    );
    await saveCheckin(
      { energy: 5, mood: 4, note: "第二次", completed: [] },
      DEMO_USER_ID,
    );

    const today = localDateKey(new Date(), "Asia/Shanghai");
    const rows = await db
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, DEMO_USER_ID), eq(checkins.date, today)));
    expect(rows).toHaveLength(1);
    expect(rows[0].energy).toBe(5);
    expect(rows[0].note).toBe("第二次");
  });

  it("stores learning minutes, recall and weak topics", async () => {
    await saveCheckin(
      {
        energy: 4,
        mood: 4,
        note: "retry",
        completed: [],
        studyMinutes: 35,
        recallScore: 0.65,
        errorTags: ["rerank", "precision"],
      },
      DEMO_USER_ID,
    );

    const today = localDateKey(new Date(), "Asia/Shanghai");
    const [row] = await db
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, DEMO_USER_ID), eq(checkins.date, today)));
    expect(row.studyMinutes).toBe(35);
    expect(row.recallScore).toBeCloseTo(0.65);
    expect(row.errorTags).toEqual(["rerank", "precision"]);
  });

  it("keeps one memory per check-in when the note is rewritten", async () => {
    await saveCheckin(
      { energy: 3, mood: 3, note: "旧笔记", completed: [] },
      DEMO_USER_ID,
    );
    await saveCheckin(
      { energy: 3, mood: 3, note: "新笔记", completed: [] },
      DEMO_USER_ID,
    );

    const today = localDateKey(new Date(), "Asia/Shanghai");
    const [row] = await db
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, DEMO_USER_ID), eq(checkins.date, today)));
    const notes = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.sourceEventId, row.id),
        ),
      );
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe("新笔记");
  });
});
