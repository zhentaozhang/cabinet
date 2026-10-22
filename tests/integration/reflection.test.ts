import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  checkins,
  insights,
  memories,
  tasks,
  users,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { retrieveMemories } from "@/lib/memory/retrieval";
import {
  applyInsight,
  getMemoryData,
  runReflection,
} from "@/server/services/engine";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("real reflection", () => {
  it("turns a real audit rejection into an evidence-backed insight", async () => {
    const insight = await runReflection(DEMO_USER_ID);
    expect(insight).not.toBeNull();
    expect(insight!.claim).not.toContain("把 21:00 的阅读任务移到 13:30");
    expect(insight!.evidence.length).toBeGreaterThan(0);
    expect(insight!.evidence.every((item) => Boolean(item.ref))).toBe(true);
    expect(insight!.evidence[0].ref).toBe("audit:aud_seed_6");
    expect(insight!.proposedChange.type).toBe("add_rule");
  });

  it("does not repeat the same claim, and falls through to the next signal", async () => {
    const first = await runReflection(DEMO_USER_ID);
    const second = await runReflection(DEMO_USER_ID);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.claim).not.toBe(first!.claim);

    const third = await runReflection(DEMO_USER_ID);
    expect(third).toBeNull();
  });

  it("returns null when there is no signal at all", async () => {
    await db.insert(users).values({
      id: "usr_empty",
      email: "empty@cabinet.local",
      name: "Empty",
      emailVerified: true,
      timezone: "Asia/Shanghai",
      updatedAt: new Date(),
    });

    expect(await runReflection("usr_empty")).toBeNull();
  });

  it("uses low energy check-ins as a real signal", async () => {
    await db.insert(checkins).values({
      id: "chk_low",
      userId: DEMO_USER_ID,
      date: "2026-10-22",
      energy: 1,
      mood: 2,
      completed: [],
      note: "完全没力气",
      createdAt: new Date(),
    });

    const first = await runReflection(DEMO_USER_ID);
    const second = await runReflection(DEMO_USER_ID);
    const third = await runReflection(DEMO_USER_ID);
    expect(first!.claim).toContain("审计驳回");
    expect(second!.claim).toContain("晚间");
    expect(third!.claim).toContain("精力只有 1/5");
  });
});

describe("bi-temporal memory", () => {
  it("supersedes an old fact instead of silently overwriting it", async () => {
    const [first] = await db
      .insert(insights)
      .values({
        id: "ins_fact_1",
        userId: DEMO_USER_ID,
        claim: "把阅读移到 09:00。",
        rationale: "测试第一版事实。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "21:00",
          to: "09:00",
        },
        status: "proposed",
      })
      .returning();

    await applyInsight(first.id, "accept", DEMO_USER_ID);

    const [second] = await db
      .insert(insights)
      .values({
        id: "ins_fact_2",
        userId: DEMO_USER_ID,
        claim: "把阅读移到 10:00。",
        rationale: "测试第二版事实。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "09:00",
          to: "10:00",
        },
        status: "proposed",
      })
      .returning();

    await applyInsight(second.id, "accept", DEMO_USER_ID);

    const facts = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.factKey, "schedule:tsk_read"),
        ),
      )
      .orderBy(memories.validFrom);

    expect(facts).toHaveLength(2);
    const oldFact = facts.find((fact) => fact.value === "09:00");
    const newFact = facts.find((fact) => fact.value === "10:00");
    expect(oldFact?.validTo).not.toBeNull();
    expect(oldFact?.status).toBe("superseded");
    expect(oldFact?.supersededBy).toBe(newFact?.id);
    expect(newFact?.validTo).toBeNull();

    const current = await getMemoryData(DEMO_USER_ID, undefined, "current");
    const history = await getMemoryData(DEMO_USER_ID, undefined, "history");
    expect(current.memories.some((memory) => memory.id === oldFact?.id)).toBe(
      false,
    );
    expect(history.memories.some((memory) => memory.id === oldFact?.id)).toBe(
      true,
    );

    const retrieved = await retrieveMemories(DEMO_USER_ID, "阅读", {
      limit: 50,
    });
    expect(retrieved.some((memory) => memory.id === oldFact?.id)).toBe(false);
    expect(retrieved.some((memory) => memory.id === newFact?.id)).toBe(true);
  });

  it("does not supersede when the fact value is confirmed again", async () => {
    const [first] = await db
      .insert(insights)
      .values({
        id: "ins_same_1",
        userId: DEMO_USER_ID,
        claim: "阅读固定在 09:00。",
        rationale: "第一次确认。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "21:00",
          to: "09:00",
        },
        status: "proposed",
      })
      .returning();
    await applyInsight(first.id, "accept", DEMO_USER_ID);

    const [second] = await db
      .insert(insights)
      .values({
        id: "ins_same_2",
        userId: DEMO_USER_ID,
        claim: "再次确认阅读固定在 09:00。",
        rationale: "第二次确认。",
        confidence: 0.8,
        evidence: [{ label: "任务", ref: "task:tsk_read" }],
        proposedChange: {
          type: "reschedule",
          taskId: "tsk_read",
          from: "08:00",
          to: "09:00",
        },
        status: "proposed",
      })
      .returning();
    await applyInsight(second.id, "accept", DEMO_USER_ID);

    const facts = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.factKey, "schedule:tsk_read"),
        ),
      );
    expect(facts).toHaveLength(1);
    expect(facts[0].validTo).toBeNull();
    expect(facts[0].lastConfirmedAt).not.toBeNull();

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, "tsk_read"));
    expect(task.dueAt).not.toBeNull();
  });
});
