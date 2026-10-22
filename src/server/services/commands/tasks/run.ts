import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentGrants,
  agents,
  approvals,
  artifacts,
  auditEvents,
  runs,
  steps,
  tasks,
  users,
} from "@/lib/db/schema";
import { logAudit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { generateArtifact } from "@/lib/llm";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { getPolicyConfig } from "@/lib/policy/config";
import { decideRun } from "@/lib/domain/policy";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError, PolicyDenied } from "@/lib/domain/errors";
import { startOfLocalWeek } from "@/lib/domain/time";
import { draftFor } from "../../shared/draft";
import { loadLatestApproval, loadSpentCents } from "./execution";
import { requestApproval } from "./approvals";

export async function runTask(taskId: string, userId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  if (!task.assigneeId) throw new ConflictError("Task has no assignee");

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.assigneeId));
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError("Agent not found");
  }

  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, task.userId));
  const timezone = user?.timezone ?? "UTC";
  const config = await getPolicyConfig();
  const grants = await db
    .select()
    .from(agentGrants)
    .where(eq(agentGrants.agentId, agent.id));
  const periodStart =
    agent.budgetPeriodStart ?? startOfLocalWeek(new Date(), timezone);
  const spentCents = await loadSpentCents(agent.id, periodStart);
  const approval = await loadLatestApproval(taskId);

  const decision = decideRun({
    actor: {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      lifecycleStage: agent.lifecycleStage,
      autonomyLevel: agent.autonomyLevel,
      trustScore: agent.trustScore,
      successCount: agent.successCount,
    },
    task: {
      assigneeId: task.assigneeId,
      auditorId: task.auditorId,
      actionType: task.actionType,
      resource: task.resource,
      requiresApproval: task.requiresApproval,
      estimatedCostCents: task.estimatedCostCents,
      approvalThresholdCents: task.approvalThresholdCents,
      status: task.status,
    },
    grants: grants.map((grant) => ({
      resource: grant.resource,
      scope: grant.scope,
    })),
    budget: {
      limitCents: agent.budgetCents,
      spentCents,
    },
    approval: approval
      ? { status: approval.status, consumedAt: approval.consumedAt }
      : null,
    config,
  });

  if (decision.effect === "deny") {
    throw new PolicyDenied(decision.reason);
  }

  const prior = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId));

  if (decision.effect === "suggest") {
    const [updated] = await db
      .update(tasks)
      .set({ status: "suggested", updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, taskId),
          inArray(tasks.status, ["planned", "assigned"]),
        ),
      )
      .returning();
    if (!updated) throw new ConflictError("Task cannot be suggested now.");

    const runId = newId("run");
    const draft = draftFor(agent.role, task.title, prior.length, false);
    const artifactId = newId("art");
    await db.insert(runs).values({
      id: runId,
      taskId,
      agentId: agent.id,
      status: "succeeded",
      mode: "demo",
      startedAt: new Date(),
      endedAt: new Date(),
      replayKey: `suggest_${taskId}_${prior.length + 1}`,
    });
    await db.insert(artifacts).values({
      id: artifactId,
      runId,
      taskId,
      type: "markdown",
      title: draft.title,
      content: draft.content,
    });
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx: 1,
      type: "suggest",
      input: { task: task.title, policy: decision.reason },
      output: { artifactId },
      tokensIn: 120,
      tokensOut: 240,
      latencyMs: 80,
    });
    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "task.suggest",
      target: taskId,
      before: { status: task.status },
      after: { status: "suggested", runId, reason: decision.reason },
    });
    return { runId, artifactId, suggested: true, reason: decision.reason };
  }

  if (decision.effect === "require_approval") {
    const approvalRecord = await requestApproval({
      userId: task.userId,
      taskId,
      action: task.actionType,
      reason: decision.reason,
      estimatedCostCents: task.estimatedCostCents,
    });

    if (task.status !== "awaiting_approval") {
      assertTransition("task", task.status, "awaiting_approval");
      const [updated] = await db
        .update(tasks)
        .set({ status: "awaiting_approval", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, task.status)))
        .returning();
      if (!updated) throw new ConflictError("Task state changed; retry.");
    }

    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "approval.request",
      target: taskId,
      before: { status: task.status },
      after: { status: "awaiting_approval", approvalId: approvalRecord.id },
    });

    return {
      requiresApproval: true,
      approvalId: approvalRecord.id,
      reason: decision.reason,
    };
  }

  const runId = newId("run");
  const startedAt = new Date();
  await db.transaction(async (tx) => {
    let status = task.status;
    if (status === "planned") {
      assertTransition("task", status, "assigned");
      const [assigned] = await tx
        .update(tasks)
        .set({ status: "assigned", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "planned")))
        .returning();
      if (!assigned) throw new ConflictError("Task state changed; retry.");
      status = "assigned";
    }

    assertTransition("task", status, "running");
    const [running] = await tx
      .update(tasks)
      .set({ status: "running", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, status)))
      .returning();
    if (!running) throw new ConflictError("Task state changed; retry.");

    if (approval?.status === "approved" && !approval.consumedAt) {
      const [consumed] = await tx
        .update(approvals)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(approvals.id, approval.id),
            eq(approvals.status, "approved"),
            isNull(approvals.consumedAt),
          ),
        )
        .returning();
      if (!consumed) throw new ConflictError("Approval already consumed.");
    }

    await tx.insert(runs).values({
      id: runId,
      taskId,
      agentId: agent.id,
      status: "running",
      mode: process.env.OPENAI_API_KEY ? "live" : "demo",
      startedAt,
      replayKey: `replay_${taskId}_${prior.length + 1}`,
    });
  });

  let idx = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const addStep = async (input: {
    type: string;
    tool?: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    ti?: number;
    to?: number;
    latency?: number;
  }) => {
    idx += 1;
    tokensIn += input.ti ?? 0;
    tokensOut += input.to ?? 0;
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx,
      type: input.type,
      tool: input.tool ?? null,
      input: input.input,
      output: input.output,
      tokensIn: input.ti ?? 0,
      tokensOut: input.to ?? 0,
      latencyMs: input.latency ?? 120,
    });
  };

  try {
    const agentMemories = await retrieveMemories(
      task.userId,
      `${task.title} ${task.description}`,
      { limit: 5 },
    );

    await addStep({
      type: "context",
      input: { task: task.title, agent: agent.name },
      output: {
        memories: agentMemories.map((m) => m.content),
        retrieved: agentMemories.map((m) => ({
          id: m.id,
          content: m.content,
          scores: m.scores,
        })),
        goal: task.goalId,
      },
      ti: 220,
      latency: 90,
    });

    await addStep({
      type: "plan",
      input: { estimateMin: task.estimateMin },
      output: {
        steps: ["读取上下文", "执行", "产出草稿", "提交验收"],
        strategy: agent.role === "chief" ? "拆解与派活" : "单任务执行",
      },
      ti: 380,
      to: 180,
      latency: 700,
    });

    const tool =
      agent.role === "researcher"
        ? "web_search"
        : agent.role === "coach"
          ? "read_notes"
          : agent.role === "treasurer"
            ? "ledger_read"
            : agent.role === "auditor"
              ? "read_artifacts"
              : "read_notes";

    await addStep({
      type: "tool",
      tool,
      input: { query: task.title },
      output: {
        result:
          agent.role === "researcher"
            ? "3 条结果，已抓取 1 篇"
            : "命中 2 条相关记忆",
      },
      ti: 180,
      to: 80,
      latency: 600,
    });

    const [priorRejection] = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.target, taskId),
          eq(auditEvents.action, "audit.reject"),
        ),
      )
      .limit(1);

    const generated = await generateArtifact({
      agentName: agent.name,
      role: agent.role,
      charter: agent.charter,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      memories: agentMemories.map((m) => m.content),
    });
    const draft =
      generated ??
      draftFor(agent.role, task.title, prior.length, Boolean(priorRejection));
    const artifactId = newId("art");

    await addStep({
      type: "draft",
      input: { format: "markdown", mode: generated ? "live" : "demo" },
      output: { artifactId, title: draft.title },
      ti: generated ? generated.tokensIn : 500,
      to: generated ? generated.tokensOut : 600,
      latency: generated ? 2400 : 1100,
    });

    await addStep({
      type: "submit",
      input: { auditor: task.auditorId },
      output: { status: "submitted" },
      ti: 40,
      to: 20,
      latency: 40,
    });

    const cost = Number(
      (((tokensIn + tokensOut) / 1000) * config.cost.centsPer1kTokens).toFixed(
        2,
      ),
    );

    await db.transaction(async (tx) => {
      await tx.insert(artifacts).values({
        id: artifactId,
        runId,
        taskId,
        type: "markdown",
        title: draft.title,
        content: draft.content,
      });

      const [submitted] = await tx
        .update(tasks)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "running")))
        .returning();
      if (!submitted) throw new ConflictError("Task is not running anymore.");

      await tx
        .update(runs)
        .set({
          status: "succeeded",
          endedAt: new Date(),
          costCents: cost,
          tokensIn,
          tokensOut,
        })
        .where(eq(runs.id, runId));

      await tx
        .update(agents)
        .set({ spentCents: sql`${agents.spentCents} + ${cost}` })
        .where(eq(agents.id, agent.id));
    });

    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "task.submit",
      target: taskId,
      before: { status: "running" },
      after: { status: "submitted", runId },
    });

    return { runId, artifactId };
  } catch (error) {
    await db
      .update(runs)
      .set({
        status: "failed",
        endedAt: new Date(),
        error: error instanceof Error ? error.message : "run failed",
      })
      .where(eq(runs.id, runId));
    await db
      .update(tasks)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, "running")));
    await logAudit({
      userId: task.userId,
      actor: `agent:${agent.id}`,
      action: "task.run.failed",
      target: taskId,
      before: { status: "running" },
      after: {
        status: "failed",
        error: error instanceof Error ? error.message : "run failed",
      },
    });
    throw error;
  }
}
