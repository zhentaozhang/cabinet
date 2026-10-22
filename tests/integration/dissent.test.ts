import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  dissents,
  memories,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import {
  decideCouncil,
  evaluateDissents,
  runReflection,
} from "@/server/services/engine";
import { resetDb } from "../helpers/db";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

beforeEach(async () => {
  await resetDb();
});

describe("formal dissent ledger", () => {
  it("records dissent when the user approves over opposition", async () => {
    const decided = await decideCouncil(
      "ccl_course",
      "approve",
      "批准试学，但保留退款提醒。",
      DEMO_USER_ID,
    );

    const rows = await db
      .select()
      .from(dissents)
      .where(
        and(
          eq(dissents.userId, DEMO_USER_ID),
          eq(dissents.councilId, "ccl_course"),
        ),
      );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.every((row) => row.taskId === decided.resolution?.taskId)).toBe(
      true,
    );
    expect(rows.map((row) => row.condition.metric).sort()).toEqual([
      "audit_reject_count",
      "budget_spend_cents",
    ]);
  });

  it("vindicates a dissent when reality matches the warning, once", async () => {
    const [criticBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    const [chiefBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_chief"));

    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, "ag_critic"));

    await db.insert(dissents).values({
      id: "dis_vindicate",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "强行推进会让一个 Agent 进入暂停。",
      condition: {
        metric: "agent_paused",
        operator: "==",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 1, invalidated: 0 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_vindicate"));
    expect(row.status).toBe("vindicated");
    expect(row.evaluatedAt).not.toBeNull();

    const [criticAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    const [chiefAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_chief"));
    expect(criticAfter.trustScore).toBe(
      Math.min(100, criticBefore.trustScore + 15),
    );
    expect(chiefAfter.trustScore).toBe(
      Math.max(0, chiefBefore.trustScore - 5),
    );

    const [precedent] = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, DEMO_USER_ID),
          eq(memories.type, "procedural"),
          eq(memories.sourceEventId, "dis_vindicate"),
          like(memories.factKey, "precedent:%"),
        ),
      );
    expect(precedent).toBeDefined();
    expect(precedent.content).toContain("判例");
    expect(precedent.value).toBe("vindicated:1");

    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.target, "dis_vindicate"),
        ),
      );
    expect(auditRows.map((row) => row.action)).toContain("dissent.vindicated");

    const second = await evaluateDissents(DEMO_USER_ID);
    expect(second).toEqual({ vindicated: 0, invalidated: 0 });

    const [criticAgain] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    expect(criticAgain.trustScore).toBe(criticAfter.trustScore);
  });

  it("invalidates a dissent when the window closes without the warning happening", async () => {
    const [criticBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));

    await db.insert(dissents).values({
      id: "dis_invalidate",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "审计驳回会超过 99 次。",
      condition: {
        metric: "audit_reject_count",
        operator: ">=",
        threshold: 99,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    const result = await evaluateDissents(DEMO_USER_ID);
    expect(result).toEqual({ vindicated: 0, invalidated: 1 });

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_invalidate"));
    expect(row.status).toBe("invalidated");
    expect(row.evidence.some((item) => item.label === "复盘测量")).toBe(true);

    const [criticAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, "ag_critic"));
    expect(criticAfter.trustScore).toBe(criticBefore.trustScore);
  });

  it("runs pending evaluations as part of reflection", async () => {
    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, "ag_critic"));
    await db.insert(dissents).values({
      id: "dis_reflection",
      userId: DEMO_USER_ID,
      councilId: "ccl_course",
      agentId: "ag_critic",
      warning: "暂停会发生。",
      condition: {
        metric: "agent_paused",
        operator: "==",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
      createdAt: daysAgo(8),
    });

    await runReflection(DEMO_USER_ID);

    const [row] = await db
      .select()
      .from(dissents)
      .where(eq(dissents.id, "dis_reflection"));
    expect(row.status).toBe("vindicated");
  });
});
