import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  auditEvents,
  councilPositions,
  memories,
  tasks,
} from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { ConflictError } from "@/lib/domain/errors";
import { createCouncil, decideCouncil } from "@/server/services/engine";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("council closed loop", () => {
  it("generates five evidence-backed positions and a matrix", async () => {
    const council = await createCouncil(
      {
        topic: "要不要报名 8 周系统设计训练营？",
        trigger: "单笔支出 > ¥200",
      },
      DEMO_USER_ID,
    );

    expect(council.status).toBe("open");
    expect(council.matrix).not.toBeNull();
    expect(council.matrix?.support).toBeGreaterThanOrEqual(0);
    expect(council.matrix?.oppose).toBeGreaterThanOrEqual(0);
    expect(
      (council.matrix?.support ?? 0) +
        (council.matrix?.oppose ?? 0) +
        (council.matrix?.neutral ?? 0),
    ).toBe(5);

    const positions = await db
      .select()
      .from(councilPositions)
      .where(eq(councilPositions.councilId, council.id));
    expect(positions).toHaveLength(5);

    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, DEMO_USER_ID));
    const roleById = new Map(agentRows.map((agent) => [agent.id, agent.role]));
    expect(positions.map((position) => roleById.get(position.agentId)).sort()).toEqual(
      ["chief", "coach", "critic", "researcher", "treasurer"],
    );

    for (const position of positions) {
      expect(position.evidence.length).toBeGreaterThan(0);
      expect(position.evidence.every((item) => Boolean(item.ref))).toBe(true);
      expect(position.scores).not.toBeNull();
      expect(position.claim.length).toBeGreaterThan(0);
      expect(position.risk.length).toBeGreaterThan(0);
      expect(position.recommendation.length).toBeGreaterThan(0);
    }
  });

  it("applies an approval to a task, memory and audit chain once", async () => {
    const council = await createCouncil(
      {
        topic: "要不要购买 RAG 课程？",
        trigger: "单笔支出 > ¥200",
      },
      DEMO_USER_ID,
    );

    const positions = await db
      .select()
      .from(councilPositions)
      .where(eq(councilPositions.councilId, council.id));
    const expectedDissents = positions.filter(
      (position) => position.isDissent || position.stance === "oppose",
    ).length;

    const decided = await decideCouncil(
      council.id,
      "approve",
      "批准，但设 7 天退款提醒。",
      DEMO_USER_ID,
    );

    expect(decided.status).toBe("decided");
    expect(decided.resolution?.decision).toBe("approve");
    expect(decided.resolution?.taskId).toBeTruthy();
    expect(decided.resolution?.memoryId).toBeTruthy();
    expect(decided.resolution?.dissents).toHaveLength(expectedDissents);
    expect(decided.resolutionAppliedAt).not.toBeNull();

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, decided.resolution!.taskId!), eq(tasks.userId, DEMO_USER_ID)));
    expect(task).toBeDefined();
    expect(task.title).toContain("执行内阁决议");
    expect(task.assigneeId).not.toBe(task.auditorId);

    const [memory] = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, decided.resolution!.memoryId!),
          eq(memories.userId, DEMO_USER_ID),
        ),
      );
    expect(memory).toBeDefined();
    expect(memory.type).toBe("procedural");
    expect(memory.sourceEventId).toBe(council.id);

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.action, "council.decide"),
          eq(auditEvents.target, council.id),
        ),
      );
    expect(audit).toBeDefined();

    await expect(
      decideCouncil(council.id, "approve", "重复决定", DEMO_USER_ID),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("records a rejection without creating a follow-up task", async () => {
    const council = await createCouncil(
      {
        topic: "要不要买年包会员？",
        trigger: "单笔支出 > ¥500",
      },
      DEMO_USER_ID,
    );

    const decided = await decideCouncil(
      council.id,
      "reject",
      "本月预算不足。",
      DEMO_USER_ID,
    );

    expect(decided.status).toBe("decided");
    expect(decided.resolution?.decision).toBe("reject");
    expect(decided.resolution?.taskId).toBeNull();
    expect(decided.resolution?.memoryId).toBeTruthy();

    const [memory] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, decided.resolution!.memoryId!));
    expect(memory.content).toContain("否决");
  });
});
