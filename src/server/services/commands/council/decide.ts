import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  councilPositions,
  councils,
  dissents,
  memories,
  tasks,
} from "@/lib/db/schema";
import type { CouncilResolution } from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { getPolicyConfig } from "@/lib/policy/config";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/domain/errors";
import { councilConditionForRole } from "./context";

export async function decideCouncil(
  councilId: string,
  decision: "approve" | "reject" | "conditions",
  note: string,
  userId: string,
) {
  const [council] = await db
    .select()
    .from(councils)
    .where(and(eq(councils.id, councilId), eq(councils.userId, userId)));
  if (!council) {
    throw new NotFoundError("Council not found");
  }
  if (council.status !== "open") {
    throw new ConflictError(`Council is already ${council.status}.`);
  }

  const positions = await db
    .select()
    .from(councilPositions)
    .where(eq(councilPositions.councilId, councilId))
    .orderBy(asc(councilPositions.createdAt));

  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId));
  const chief = allAgents.find((agent) => agent.role === "chief");
  const auditor = allAgents.find((agent) => agent.role === "auditor");
  const config = await getPolicyConfig();

  const label =
    decision === "approve"
      ? "批准"
      : decision === "reject"
        ? "否决"
        : "有条件批准";
  const trimmedNote = note.trim();

  const dissentRecords = positions
    .filter((position) => position.isDissent || position.stance === "oppose")
    .map((position) => ({
      agentId: position.agentId,
      claim: position.claim,
      risk: position.risk,
      recommendation: position.recommendation,
    }));

  let taskId: string | null = null;
  let memoryId: string | null = null;
  const dissentIds: string[] = [];
  let updated: typeof council;

  await db.transaction(async (tx) => {
    const [locked] = await tx
      .update(councils)
      .set({ status: "decided", decidedAt: new Date() })
      .where(and(eq(councils.id, councilId), eq(councils.status, "open")))
      .returning();
    if (!locked) throw new ConflictError("Council state changed; retry.");

    if (decision !== "reject") {
      if (!chief || !auditor) {
        throw new ValidationError(
          "Approved councils need both a Chief and an Auditor.",
        );
      }
      taskId = newId("tsk");
      const acceptance =
        decision === "conditions" && trimmedNote
          ? `按内阁条件执行：${trimmedNote}`
          : `完成内阁决议并附执行证据：${council.topic}`;
      await tx.insert(tasks).values({
        id: taskId,
        userId,
        title: `执行内阁决议：${council.topic}`,
        description: `内阁于 ${new Date().toISOString()} ${label}：${trimmedNote || "无附加说明"}`,
        assigneeId: chief.id,
        auditorId: auditor.id,
        status: "planned",
        priority: 1,
        acceptanceCriteria: acceptance,
        estimateMin: 25,
        actionType: "internal_write",
        resource: "task",
        estimatedCostCents: 0,
        createdBy: "user",
      });
    }

    memoryId = newId("mem");
    await tx.insert(memories).values({
      id: memoryId,
      userId,
      type: "procedural",
      domain: "council",
      content: `内阁决议（${label}）：${council.topic}。${trimmedNote || "无附加说明"}`,
      confidence: 0.8,
      salience: 0.8,
      evidence: [
        {
          label: "内阁决议",
          ref: `council:${councilId}`,
          quote: trimmedNote || label,
        },
      ],
      sourceEventId: councilId,
      lastConfirmedAt: new Date(),
      status: "active",
    });

    if (decision !== "reject") {
      for (const dissent of dissentRecords) {
        const position = positions.find(
          (candidate) => candidate.agentId === dissent.agentId,
        );
        const role =
          allAgents.find((candidate) => candidate.id === dissent.agentId)
            ?.role ?? "";
        const condition =
          position?.falsificationCondition ??
          councilConditionForRole(role, config) ?? {
            metric: "audit_reject_count" as const,
            operator: ">=" as const,
            threshold: Math.max(1, config.audit.rejectStreakLimit),
            windowDays: config.council.dissentWindowDays,
          };
        const dissentId = newId("dis");
        await tx.insert(dissents).values({
          id: dissentId,
          userId,
          councilId,
          taskId,
          agentId: dissent.agentId,
          warning: dissent.risk || dissent.claim,
          condition,
          status: "pending",
          evidence: position?.evidence ?? [],
        });
        dissentIds.push(dissentId);
      }
    }

    const resolution: CouncilResolution = {
      decision,
      note: trimmedNote,
      taskId,
      memoryId,
      dissents: dissentRecords,
      decidedAt: new Date().toISOString(),
    };

    const [withResolution] = await tx
      .update(councils)
      .set({
        memo: `${locked.memo}\n\n## 决定\n${label}：${trimmedNote || "无附加说明"}\n\n## 落地\n${
          taskId ? `已生成跟进任务 ${taskId}` : "未生成任务"
        }；已写入程序记忆 ${memoryId}。`,
        resolution,
        resolutionAppliedAt: new Date(),
      })
      .where(eq(councils.id, councilId))
      .returning();

    updated = withResolution;
  });

  await logAudit({
    userId: council.userId,
    actor: "user",
    action: "council.decide",
    target: councilId,
    before: { status: "open" },
    after: {
      status: "decided",
      decision,
      note: trimmedNote,
      taskId,
      memoryId,
      dissents: dissentRecords,
      dissentIds,
    },
  });

  return updated!;
}
