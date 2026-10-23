import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetReservations,
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
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { generateArtifact } from "@/lib/llm";
import { searchAndPersist } from "@/server/services/connectors/search";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { getPolicyConfig } from "@/lib/policy/config";
import { planTools, type ToolStepStatus } from "@/lib/domain/tool-plan";
import { decideRun } from "@/lib/domain/policy";
import { usageCents } from "@/lib/domain/agent-budget";
import { enqueueNotification, notices } from "../notify";
import { assertTransition } from "@/lib/domain/state";
import {
  ConflictError,
  NotFoundError,
  PolicyDenied,
  ValidationError,
} from "@/lib/domain/errors";
import { draftFor } from "../../shared/draft";
import {
  loadLatestApproval,
  loadWeeklyUsage,
  reserveBudget,
  settleBudget,
} from "./execution";
import { requestApproval } from "./approvals";

export async function runTask(taskId: string, userId: string) {
  const [found] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!found || found.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  let task = found;
  if (!task.assigneeId) throw new ConflictError("Task has no assignee");
  const retrying = task.status === "failed" || task.status === "rejected";
  const demoMode = process.env.DEMO_MODE === "true";

  // A failed/rejected run can be retried through the normal state machine.
  if (retrying) {
    assertTransition("task", task.status, "planned");
    const [reset] = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tasks)
        .set({ status: "planned", updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.userId, userId),
            eq(tasks.status, task.status),
          ),
        )
        .returning();
      if (!updated) throw new ConflictError("Task state changed; retry.");
      await logAuditTx(tx, {
        userId,
        actor: "user",
        action: "task.retry",
        target: taskId,
        before: { status: task.status },
        after: { status: "planned" },
      });
      return [updated] as const;
    });
    task = reset;
  }

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.assigneeId!));
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
  // One accounting authority: the persisted weekly period ledger.
  const usage = await loadWeeklyUsage(agent.id, timezone);
  let approval: Awaited<ReturnType<typeof loadLatestApproval>> =
    await loadLatestApproval(taskId);
  // A consumed approval is historical. A rejected task gets a fresh approval
  // request instead of being locked out forever.
  if (retrying && approval?.status === "approved" && approval.consumedAt) {
    approval = null;
  }

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
    standingGrants: grants.map((grant) => ({
      id: grant.id,
      resource: grant.resource,
      action: grant.action,
      createdByApprovalId: grant.createdByApprovalId,
      expiresAt: grant.expiresAt,
      maxCents: grant.maxCents,
      maxRuns: grant.maxRuns,
      useCount: grant.useCount,
      revokedAt: grant.revokedAt,
    })),
    budget: {
      limitCents: usage.limitCents,
      spentCents: usageCents(usage),
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
    return db.transaction(async (tx) => {
      const [updated] = await tx
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
      await tx.insert(runs).values({
        id: runId,
        taskId,
        agentId: agent.id,
        status: "succeeded",
        mode: demoMode ? "demo" : "rule",
        sourceType: demoMode ? "demo_fixture" : "rule_generated",
        startedAt: new Date(),
        endedAt: new Date(),
        replayKey: `suggest_${taskId}_${prior.length + 1}`,
      });
      await tx.insert(artifacts).values({
        id: artifactId,
        runId,
        taskId,
        type: "markdown",
        title: draft.title,
        content: draft.content,
        sourceType: demoMode ? "demo_fixture" : "rule_generated",
      });
      await tx.insert(steps).values({
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
      await logAuditTx(tx, {
        userId: task.userId,
        actor: `agent:${agent.id}`,
        action: "task.suggest",
        target: taskId,
        before: { status: task.status },
        after: { status: "suggested", runId, reason: decision.reason },
      });
      return { runId, artifactId, suggested: true, reason: decision.reason };
    });
  }

  if (decision.effect === "require_approval") {
    return db.transaction(async (tx) => {
      const approvalRecord = await requestApproval(
        {
          userId: task.userId,
          taskId,
          title: task.title,
          resource: task.resource,
          dueAt: task.dueAt,
          action: task.actionType,
          reason: decision.reason,
          estimatedCostCents: task.estimatedCostCents,
        },
        tx,
      );

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
      if (status !== "awaiting_approval") {
        assertTransition("task", status, "awaiting_approval");
        const [updated] = await tx
          .update(tasks)
          .set({ status: "awaiting_approval", updatedAt: new Date() })
          .where(and(eq(tasks.id, taskId), eq(tasks.status, status)))
          .returning();
        if (!updated) throw new ConflictError("Task state changed; retry.");
      }

      await logAuditTx(tx, {
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
    });
  }

  // Reserve the per-run ceiling BEFORE any provider request. The hold is always
  // created and then released when the call never happens, so a simulated
  // fallback records "attempted, no provider contact" instead of vanishing. A
  // denial happens before the task leaves planned, so it never fails the task.
  let reservation: { reservationId: string; amountCents: number } | null = null;
  if (config.cost.maxRunCents > 0) {
    const hold = await reserveBudget({
      userId: task.userId,
      agentId: agent.id,
      taskId,
      timezone,
      amountCents: config.cost.maxRunCents,
    });
    if (!hold.allowed) {
      // The denial is the interesting event: the user must learn that an Agent
      // stopped because of money, not because it finished.
      await enqueueNotification({
        userId: task.userId,
        kind: "budget",
        targetType: "task",
        targetId: taskId,
        ...notices.budget({
          agentName: agent.name,
          taskTitle: task.title,
          reason: hold.reason,
        }),
      });
      throw new PolicyDenied(hold.reason);
    }
    reservation = hold;
  }

  const runId = newId("run");
  const startedAt = new Date();
  await db.transaction(async (tx) => {
    /**
     * Spend one use of the standing policy that lifted the gate.
     *
     * The condition is part of the UPDATE, so two concurrent runs cannot both
     * take the last use: the loser sees no row and is denied, rather than
     * running past the ceiling the user set.
     */
    if (decision.standingGrantId) {
      const [spent] = await tx
        .update(agentGrants)
        .set({
          useCount: sql`${agentGrants.useCount} + 1`,
          lastUsedAt: startedAt,
        })
        .where(
          and(
            eq(agentGrants.id, decision.standingGrantId),
            isNull(agentGrants.revokedAt),
            or(
              isNull(agentGrants.maxRuns),
              lt(agentGrants.useCount, agentGrants.maxRuns),
            ),
          ),
        )
        .returning({
          id: agentGrants.id,
          useCount: agentGrants.useCount,
          maxRuns: agentGrants.maxRuns,
        });
      if (!spent) {
        throw new PolicyDenied(
          "Standing policy was revoked or used up before this run started.",
        );
      }
      await logAuditTx(tx, {
        userId: task.userId,
        actor: "user",
        action: "grant.use",
        target: spent.id,
        before: { useCount: spent.useCount - 1 },
        after: {
          useCount: spent.useCount,
          maxRuns: spent.maxRuns,
          taskId,
          runId,
        },
      });
    }

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
      mode: demoMode ? "demo" : "live",
      sourceType: "system_event",
      startedAt,
      replayKey: `replay_${taskId}_${prior.length + 1}`,
    });

    if (reservation) {
      await tx
        .update(agentBudgetReservations)
        .set({ runId })
        .where(eq(agentBudgetReservations.id, reservation.reservationId));
    }
  });

  let idx = 0;
  // Whether a provider request may have happened; drives ledger settlement.
  let providerContact: "unknown" | "none" | "real" = "unknown";
  // Provider attempt identity for this run; set only after the model call.
  let attempt: {
    attemptId: string;
    provider: string;
    model: string;
    costSource: "actual" | "unknown";
  } | null = null;
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
      {
        limit: 5,
        agentId: agent.id,
        scopes: agent.memoryScope.includes("all_evidence")
          ? ["*"]
          : agent.memoryScope,
      },
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

    // The tool comes from the agent's declared list, filtered by grants — a
    // role ternary here made `agent_grants` decorative and gave Coach a
    // research tool it was never granted.
    const toolPlan = planTools({
      tools: agent.tools,
      grants: grants.map((grant) => ({
        resource: grant.resource,
        scope: grant.scope,
      })),
      actionType: task.actionType,
    });
    const toolStartedAt = performance.now();
    let toolStatus: ToolStepStatus;
    let toolReason: string;
    let search: Awaited<ReturnType<typeof searchAndPersist>> | null = null;

    if (!toolPlan.planned) {
      toolStatus = "unauthorized";
      toolReason = toolPlan.reason;
    } else if (
      toolPlan.planned.tool === "web_search" ||
      toolPlan.planned.tool === "web_fetch"
    ) {
      // A real external call. Its outcome is recorded as-is; a failure stays a
      // failure instead of being papered over by a template draft.
      search = await searchAndPersist({
        userId: task.userId,
        taskId,
        runId,
        query: `${task.title} ${task.description}`.trim(),
      });
      toolStatus = search.status;
      toolReason =
        search.message ?? `检索到 ${search.hits.length} 条可引用来源，已落库。`;
    } else {
      toolStatus = "not_connected";
      toolReason = "No external connector is configured for this tool.";
    }

    await addStep({
      type: "tool",
      tool: toolPlan.planned?.tool,
      input: { query: task.title, actionType: task.actionType },
      output: {
        status: toolStatus,
        tool: toolPlan.planned?.tool ?? null,
        provider: search?.provider ?? null,
        resource: toolPlan.planned?.resource ?? null,
        reason: toolReason,
        considered: toolPlan.considered,
        hits: search?.hits.length ?? 0,
        evidence: (search?.evidence ?? []).map((item) => ({
          id: item.id,
          url: item.url,
          title: item.title,
          publisher: item.publisher,
        })),
        latencyMs: search?.latencyMs ?? null,
      },
      latency: Math.max(1, Math.round(performance.now() - toolStartedAt)),
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

    const modelResult = await generateArtifact({
      agentName: agent.name,
      role: agent.role,
      charter: agent.charter,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      memories: agentMemories.map((m) => m.content),
      evidence: (search?.evidence ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        publisher: item.publisher,
        quote: item.quote,
      })),
      maxOutputTokens: config.cost.maxOutputTokens,
    });

    providerContact = modelResult.status === "not_configured" ? "none" : "real";
    if (modelResult.status !== "not_configured") {
      attempt = {
        attemptId: modelResult.attemptId,
        provider: modelResult.provider,
        model: modelResult.model,
        costSource: modelResult.costSource,
      };
    }

    let draft: { title: string; content: string };
    let sourceMode: "live" | "demo";
    if (modelResult.status === "success") {
      draft = modelResult.draft;
      sourceMode = "live";
    } else if (demoMode) {
      // Explicit demo mode is the only path that may use a template draft.
      draft = draftFor(agent.role, task.title, prior.length, Boolean(priorRejection));
      sourceMode = "demo";
    } else {
      throw new ValidationError(
        modelResult.status === "not_configured"
          ? "Model is not configured. Configure OPENAI_API_KEY or enable DEMO_MODE."
          : `Model execution failed (${modelResult.status}).`,
      );
    }
    const artifactId = newId("art");

    await addStep({
      type: "draft",
      input: { format: "markdown", mode: sourceMode },
      output: {
        artifactId,
        title: draft.title,
        ...(modelResult.status === "success"
          ? {
              tokensIn: modelResult.draft.tokensIn,
              tokensOut: modelResult.draft.tokensOut,
            }
          : {}),
      },
      ti: modelResult.status === "success" ? modelResult.draft.tokensIn : 0,
      to: modelResult.status === "success" ? modelResult.draft.tokensOut : 0,
      latency: sourceMode === "live" ? 2400 : 1100,
    });

    await addStep({
      type: "submit",
      input: { auditor: task.auditorId },
      output: { status: "submitted" },
      ti: 40,
      to: 20,
      latency: 40,
    });

    // Only provider-reported tokens count as measured model usage. Trace steps
    // keep illustrative counters; they never become run usage or run cost.
    const measured =
      modelResult.status === "success" && modelResult.costSource === "actual"
        ? {
            tokensIn: modelResult.draft.tokensIn,
            tokensOut: modelResult.draft.tokensOut,
          }
        : null;
    const cost = measured
      ? Number(
          (
            ((measured.tokensIn + measured.tokensOut) / 1000) *
            config.cost.centsPer1kTokens
          ).toFixed(2),
        )
      : 0;
    // An overrun is recorded by the ledger and blocks later reservations. A
    // successful generation is never discarded for cost reasons.

    await db.transaction(async (tx) => {
      await tx.insert(artifacts).values({
        id: artifactId,
        runId,
        taskId,
        type: "markdown",
        title: draft.title,
        content: draft.content,
        sourceType:
          sourceMode === "live" ? "model_generated" : "demo_fixture",
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
          mode: sourceMode,
          endedAt: new Date(),
          costCents: cost,
          tokensIn: measured?.tokensIn ?? null,
          tokensOut: measured?.tokensOut ?? null,
          provider: attempt?.provider ?? null,
          model: attempt?.model ?? null,
          providerAttemptId: attempt?.attemptId ?? null,
          costSource: attempt?.costSource ?? null,
        })
        .where(eq(runs.id, runId));

      // Settle the hold in the same transaction as the run telemetry.
      if (reservation) {
        await settleBudget(tx, {
          runId,
          settlement:
            providerContact === "real" &&
            modelResult.status === "success" &&
            modelResult.costSource === "actual"
              ? { state: "known_usage", estimatedCents: cost }
              : providerContact === "none"
                ? { state: "not_contacted" }
                : { state: "unknown_usage" },
          providerAttemptId: attempt?.attemptId ?? null,
        });
      }

      await logAuditTx(tx, {
        userId: task.userId,
        actor: `agent:${agent.id}`,
        action: "task.submit",
        target: taskId,
        before: { status: "running" },
        after: { status: "submitted", runId },
      });
    });

    return { runId, artifactId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "run failed";
    await db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({
          status: "failed",
          endedAt: new Date(),
          error: message,
          // A failed attempt keeps its identity: it may have reached the
          // provider, so usage stays unknown instead of a measured zero.
          tokensIn: null,
          tokensOut: null,
          provider: attempt?.provider ?? null,
          model: attempt?.model ?? null,
          providerAttemptId: attempt?.attemptId ?? null,
          costSource: attempt?.costSource ?? null,
        })
        .where(eq(runs.id, runId));

      if (reservation) {
        // A failed attempt that may have reached the provider keeps its full
        // exposure as unknown; one that never left the process is released.
        await settleBudget(tx, {
          runId,
          settlement:
            providerContact === "none"
              ? { state: "not_contacted" }
              : { state: "unknown_usage" },
          providerAttemptId: attempt?.attemptId ?? null,
          reason: error instanceof Error ? error.name : "run_failed",
        });
      }

      await tx
        .update(tasks)
        .set({ status: "failed", updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "running")));
      await logAuditTx(tx, {
        userId: task.userId,
        actor: `agent:${agent.id}`,
        action: "task.run.failed",
        target: taskId,
        before: { status: "running" },
        after: { status: "failed", error: message },
      });
    });
    throw error;
  }
}
