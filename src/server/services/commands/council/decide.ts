import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agents,
  councilPositions,
  councils,
  dissents,
  memories,
  tasks,
  users,
} from "@/lib/db/schema";
import type { CouncilResolution } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { formatLocalDateTime } from "@/lib/domain/time";
import { getPolicyConfigFor } from "@/lib/policy/config";
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
  // 与 createCouncil 同源：兜底出来的证伪条件也要用这个人自己的阈值。
  const config = await getPolicyConfigFor(userId);
  const [account] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  // 一次决议只有一个时刻。跟进任务的正文、程序记忆的 lastConfirmedAt、
  // resolution.decidedAt 都读这一个 now：三次 new Date() 会让同一条决议在正文里
  // 和 JSON 里差几十毫秒，读起来像两次操作。
  const now = new Date();
  const timeZone = account?.timezone ?? "UTC";

  const label =
    decision === "approve"
      ? "批准"
      : decision === "reject"
        ? "否决"
        : "有条件批准";
  const trimmedNote = note.trim();
  // 没有条件就不能记成「有条件批准」：决议卡只印 decision 的标签 + note，
  // 跟进任务的验收标准也从这段 note 抄，空的条件会让「有条件」三个字悬空。
  // 校验层已经挡了 API 入口，这里管的是直接调用（服务边界）。
  if (decision === "conditions" && !trimmedNote) {
    throw new ValidationError("Conditional approval needs the conditions written down.");
  }

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
      .set({ status: "decided", decidedAt: now })
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
      // conditions 一定带着 note（上面校验过），approve 才是没有条件的那种。
      const acceptance =
        decision === "conditions"
          ? `按内阁条件执行：${trimmedNote}`
          : `完成内阁决议并附执行证据：${council.topic}`;
      await tx.insert(tasks).values({
        id: taskId,
        userId,
        title: `执行内阁决议：${council.topic}`,
        // 这句话是跟进任务的正文，会直接给用户读：时间按他的时区写成
        // 「2026-10-29 05:30」，不是 toISOString() 那个 UTC + Z 的日志格式。
        description: `内阁于 ${formatLocalDateTime(now, timeZone)} ${label}：${trimmedNote || "无附加说明"}`,
        assigneeId: chief.id,
        auditorId: auditor.id,
        status: "planned",
        priority: 1,
        acceptanceCriteria: acceptance,
        estimateMin: 25,
        actionType: "internal_write",
        resource: "task",
        estimatedCostCents: 0,
        // 这条任务是系统按决议自动生成的：用户点的是「批准」，没有写过任务。
        // 盖成 user 会让今日页把它标成「用户手动」，把来源说反。
        createdBy: "system",
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
      lastConfirmedAt: now,
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
      decidedAt: now.toISOString(),
    };

    const [withResolution] = await tx
      .update(councils)
      .set({
        memo: `${locked.memo}\n\n## 决定\n${label}：${trimmedNote || "无附加说明"}\n\n## 落地\n${
          taskId ? `已生成跟进任务 ${taskId}` : "未生成任务"
        }；已写入程序记忆 ${memoryId}。`,
        resolution,
        resolutionAppliedAt: now,
      })
      .where(eq(councils.id, councilId))
      .returning();

    updated = withResolution;

    await logAuditTx(tx, {
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
  });

  return updated!;
}
