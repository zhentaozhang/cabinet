import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetReservations,
  agentGrants,
  agents,
  approvals,
  artifacts,
  auditEvents,
  profiles,
  runs,
  skills as skillsTable,
  steps,
  tasks,
  users,
} from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { generateArtifact } from "@/lib/llm";
import { currentSpan, startSpan, withSpan } from "@/lib/observability/tracing";
import { recordRetrievalCall } from "@/server/services/connectors/ledger";
import { searchAndPersist } from "@/server/services/connectors/search";
import { retrievalBudgetState } from "@/server/services/connectors/ledger";
import { fetchAndPersist } from "@/server/services/connectors/page";
import { extractFirstUrl } from "@/lib/connectors/page";
import { retrieveMemories } from "@/lib/memory/retrieval";
import { getPolicyConfig } from "@/lib/policy/config";
import {
  notConnectedReason,
  planTools,
  REJECTION_STATUS,
  selectableTools,
  type ToolStepStatus,
} from "@/lib/domain/tool-plan";
import { mergeTools, readRules } from "@/lib/domain/execution-context";
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
import type { PersistedEvidence } from "@/server/services/connectors/search";

import {
  declaredMcpTools,
  MCP_TOOL_PREFIX,
  runMcpToolLoop,
  runModelToolLoop,
} from "./tool-loop";
import {
  loadLatestApproval,
  loadWeeklyUsage,
  reserveBudget,
  settleBudget,
} from "./execution";
import { requestApproval } from "./approvals";

/**
 * Internal signal: the budget hold was refused inside the claim transaction, so
 * the transaction can roll back before anything is claimed. Never escapes this
 * module — callers see a PolicyDenied.
 */
class BudgetHoldDenied extends Error {}

/**
 * Run one task inside a trace.
 *
 * The span is the only place a run's identity, agent and step count exist in
 * one object: the database rows are per-stage, and the log lines are per-event.
 */
export async function runTask(taskId: string, userId: string) {
  return withSpan(
    { name: "run.execute", attributes: { "task.id": taskId } },
    async () => executeRun(taskId, userId),
  );
}

async function executeRun(taskId: string, userId: string) {
  const [found] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!found || found.userId !== userId) {
    throw new NotFoundError("Task not found");
  }
  let task = found;
  if (!task.assigneeId) throw new ConflictError("Task has no assignee");
  const retrying = task.status === "failed" || task.status === "rejected";
  const demoMode = process.env.DEMO_MODE === "true";

  // A failed/rejected run can be retried through the normal state machine.
  if (retrying) task = await resetForRetry(taskId, userId, task);

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.assigneeId!));
  if (!agent || agent.userId !== userId) {
    throw new NotFoundError("Agent not found");
  }
  currentSpan()?.setAttribute("agent.id", agent.id);

  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, task.userId));
  const timezone = user?.timezone ?? "UTC";
  const config = await getPolicyConfig();
  const grants = await db
    .select()
    .from(agentGrants)
    .where(and(eq(agentGrants.agentId, agent.id), isNull(agentGrants.revokedAt)));
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
      revokedAt: grant.revokedAt,
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
    timeZone: timezone,
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
    return suggestInsteadOfRunning({
      task,
      agent,
      priorRunCount: prior.length,
      demoMode,
      reason: decision.reason,
    });
  }

  if (decision.effect === "require_approval") {
    return awaitApproval({ task, agent, reason: decision.reason });
  }

  // Reserve the per-run ceiling BEFORE any provider request. The hold is always
  // created and then released when the call never happens, so a simulated
  // fallback records "attempted, no provider contact" instead of vanishing. A
  // denial happens before the task leaves planned, so it never fails the task.
  const runId = newId("run");
  currentSpan()?.setAttribute("run.id", runId);
  const startedAt = new Date();
  let budgetDenial: string | null = null;
  /**
   * The claim and the budget hold commit together or not at all.
   *
   * Reserving first and then claiming the task (the previous order) meant a
   * run that lost the claim, or that hit a state conflict, left a hold behind
   * that nothing ever released: the week's remaining budget shrank with no run
   * to show for it. Both now happen in the transaction that decides the winner.
   */
  const reservation = await claimRun().catch(async (error: unknown) => {
    if (error instanceof BudgetHoldDenied) {
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
          reason: budgetDenial ?? "预算不足",
        }),
      });
      throw new PolicyDenied(budgetDenial ?? "Budget exhausted.");
    }
    throw error;
  });

  async function claimRun(): Promise<{
    reservationId: string;
    amountCents: number;
  } | null> {
  return db.transaction(async (tx) => {
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
        // The run that spends the approval owns it from here on. Without this,
        // `approvals.run_id` was never written by anything, so a manifest could
        // not tell which run an approval authorised (46b0569 审查第 1 条).
        .set({ consumedAt: new Date(), runId })
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

    // The hold is written even when no per-run cap is configured. Skipping it
    // used to be silent and total: no reservation meant no settlement, so
    // `settled_cents` stayed 0, every later admission read an empty period, and
    // a workspace with `maxRunCents: 0` had no budget gate at all. A 0-cent hold
    // keeps the accounting path alive; `decideReservation` still refuses it once
    // the week has nothing left.
    const reserved = await reserveBudget(
      {
        userId: task.userId,
        agentId: agent.id,
        taskId,
        timezone,
        amountCents: Math.max(0, config.cost.maxRunCents),
      },
      tx,
    );
    if (!reserved.allowed) {
      budgetDenial = reserved.reason;
      throw new BudgetHoldDenied();
    }
    const hold = {
      reservationId: reserved.reservationId,
      amountCents: reserved.amountCents,
    };

    await tx.insert(runs).values({
      id: runId,
      taskId,
      agentId: agent.id,
      status: "running",
      mode: demoMode ? "demo" : "live",
      sourceType: "system_event",
      startedAt,
      runLabel: `replay_${taskId}_${prior.length + 1}`,
    });

    await tx
      .update(agentBudgetReservations)
      .set({ runId })
      .where(eq(agentBudgetReservations.id, hold.reservationId));

    return hold;
  });
  }

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
    // One child span per row: the step table answers "what happened", the trace
    // answers "how long did each part take".
    const stepSpan = startSpan({
      name: input.type,
      attributes: {
        "step.idx": idx,
        ...(input.tool ? { "step.tool": input.tool } : {}),
        ...(input.latency === undefined ? {} : { "step.latency_ms": input.latency }),
      },
    });
    try {
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
    } finally {
      stepSpan.end();
    }
    currentSpan()?.setAttribute("run.steps", idx);
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

    /**
     * Capabilities the executor is allowed to lean on. Only `active` skills
     * count: a skill still in draft/exam has not been proven, and a passing
     * exam used to mean nothing because nothing read this table.
     */
    const activeSkills = await db
      .select({
        name: skillsTable.name,
        steps: skillsTable.steps,
        tools: skillsTable.tools,
      })
      .from(skillsTable)
      .where(
        and(
          eq(skillsTable.agentId, agent.id),
          eq(skillsTable.status, "active"),
        ),
      )
      .orderBy(skillsTable.createdAt);

    const [profile] = await db
      .select({ preferences: profiles.preferences })
      .from(profiles)
      .where(eq(profiles.userId, task.userId));
    const rules = readRules(profile?.preferences);

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
        // Recorded so a draft can be traced back to the procedure and the
        // user's rules that shaped it.
        skills: activeSkills.map((skill) => skill.name),
        rules,
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
    const declaredTools = mergeTools(
      agent.tools,
      activeSkills.flatMap((skill) => skill.tools),
    );
    // MCP tools are planned one by one inside the loop below, where each one
    // learns its own resource from its server row. Feeding them to this
    // planner would only produce an `unknown_tool` rejection for a tool that
    // is about to run successfully (5f332e7f 阻断 1).
    const builtinTools = declaredTools.filter((tool) => !tool.startsWith(MCP_TOOL_PREFIX));
    const mcpTools = declaredMcpTools(declaredTools);
    // 授权只认 resource+scope；确定性与模型可选两条路径共用同一份投影。
    const toolGrants = grants.map((grant) => ({
      resource: grant.resource,
      scope: grant.scope,
    }));
    const toolPlan = planTools({
      // A passed skill may bring its own tool; the grant check below still
      // decides whether it may actually run.
      tools: builtinTools,
      grants: toolGrants,
      actionType: task.actionType,
    });
    /**
     * 模型可选工具，默认关闭（MODEL_TOOL_SELECTION 未设置即关闭）。
     *
     * 开启时工具由模型在 runModelToolLoop 里自己挑，确定性单工具执行同时让位：
     * 两者都跑会给一次运行记两次外部请求与两次预算。关闭时 selectable 为空，
     * 下面每个分支都与改动前逐字一致。
     */
    const selectable =
      process.env.MODEL_TOOL_SELECTION === "on"
        ? selectableTools({
            declaredTools: builtinTools,
            grants: toolGrants,
            actionType: task.actionType,
          })
        : [];
    const modelSelectsTools = selectable.length > 0;
    const toolStartedAt = performance.now();
    let toolStatus: ToolStepStatus;
    let toolReason: string;
    let search: Awaited<ReturnType<typeof searchAndPersist>> | null = null;
    let page: Awaited<ReturnType<typeof fetchAndPersist>> | null = null;
    /** The exact string sent to the provider, so the trace can be replayed. */
    let toolQuery: string | null = null;

    if (modelSelectsTools) {
      // 工具选择交给模型，这里只占住"确定性执行未使用"这个事实。
      // 不写 step：真正的每次调用由 runModelToolLoop 逐条记录。
      toolStatus = "skipped";
      toolReason =
        "MODEL_TOOL_SELECTION=on：本运行的工具由模型选择，确定性单工具执行未使用。";
    } else if (!toolPlan.planned) {
      const rejection = toolPlan.considered[0]?.reason;
      // Same vocabulary as the MCP loop: an unknown tool is "not connected",
      // never "unauthorized", because no permission decision was made.
      toolStatus = rejection ? REJECTION_STATUS[rejection] : "skipped";
      toolReason = toolPlan.reason;
    } else if (toolPlan.planned.tool === "web_search") {
      // A real external call. Its outcome is recorded as-is; a failure stays a
      // failure instead of being papered over by a template draft.
      toolQuery = `${task.title} ${task.description}`.trim();
      const retrievalBudget = await retrievalBudgetState(task.userId);
      if (retrievalBudget.exhausted) {
        // The ceiling is checked before the call, not after: a limit that only
        // reports overspend is a report.
        toolStatus = "skipped";
        toolReason = `本周检索预算已用尽（上限 ${(retrievalBudget.limitCents / 100).toFixed(2)} 元），本次未发起外部检索。`;
        await recordRetrievalCall({
          userId: task.userId,
          taskId,
          runId,
          tool: "web_search",
          provider: null,
          status: toolStatus,
          hits: 0,
          latencyMs: 0,
          billable: false,
        });
        search = null;
      } else {
      search = await searchAndPersist({
        userId: task.userId,
        taskId,
        runId,
        query: toolQuery,
      });
      toolStatus = search.status;
      toolReason =
        search.message ?? `检索到 ${search.hits.length} 条可引用来源，已落库。`;
      await recordRetrievalCall({
        userId: task.userId,
        taskId,
        runId,
        tool: "web_search",
        provider: search.provider,
        status: search.status,
        hits: search.hits.length,
        latencyMs: search.latencyMs,
        billable: true,
      });
      }
    } else if (toolPlan.planned.tool === "web_fetch") {
      // One URL, named by the task itself. No URL means the tool has nothing to
      // do — recorded as skipped, not as a failed fetch.
      const target = extractFirstUrl(
        `${task.description}\n${task.acceptanceCriteria}`,
      );
      if (!target) {
        toolStatus = "skipped";
        toolReason =
          "任务描述和验收标准里都没有链接，web_fetch 只抓任务自己给出的 URL。";
      } else {
        toolQuery = target;
        page = await fetchAndPersist({
          userId: task.userId,
          taskId,
          runId,
          url: target,
        });
        toolStatus = page.status;
        toolReason =
          page.message ?? `抓取了 ${page.url}，已落库 ${page.evidence.length} 条证据。`;
        await recordRetrievalCall({
          userId: task.userId,
          taskId,
          runId,
          tool: "web_fetch",
          provider: page.provider,
          status: page.status,
          hits: page.hits.length,
          latencyMs: page.latencyMs,
          // Fetching one named page is not a metered lookup.
          billable: false,
        });
      }
    } else {
      toolStatus = "not_connected";
      // Not every tool here needs a connector: read_notes, quiz, read_plan and
      // friends are local, and this runtime simply has no executor for them.
      // Calling that "no external connector configured" would blame a setting
      // that does not exist.
      //
      // 文案交给注册表而不是在这里再写一句：能力矩阵（/cabinet）和这条运行日志
      // 必须说同一件事，否则"页面显示已接入、运行显示未接入"两个都自称有据。
      // notConnectedReason 还会区分"声明未接入"和"注册表说能跑、分发链却没有"，
      // 后者是代码 bug，藏进"环境没配"里就再也查不出来了。
      toolReason = notConnectedReason(toolPlan.planned.tool);
    }

    // An MCP-only Agent gets no built-in step at all: the planner saw no
    // built-in tool, and writing "unauthorized" here would contradict the loop
    // that calls the same tool right after this comment.
    if (!modelSelectsTools && (builtinTools.length > 0 || mcpTools.length === 0)) {
      await addStep({
        type: "tool",
        tool: toolPlan.planned?.tool,
        input: { query: toolQuery ?? task.title, actionType: task.actionType },
        output: {
          status: toolStatus,
          tool: toolPlan.planned?.tool ?? null,
          provider: search?.provider ?? page?.provider ?? null,
          resource: toolPlan.planned?.resource ?? null,
          reason: toolReason,
          considered: toolPlan.considered,
          hits: (search ?? page)?.hits.length ?? 0,
          evidence: ((search ?? page)?.evidence ?? []).map((item) => ({
            id: item.id,
            url: item.url,
            title: item.title,
            publisher: item.publisher,
          })),
          latencyMs: (search ?? page)?.latencyMs ?? null,
        },
        latency: Math.max(1, Math.round(performance.now() - toolStartedAt)),
      });
    }

    // MCP tools an Agent declared run after the built-in planner, through the
    // same grant → hold → call → settle gate. Nothing is called unless the
    // workspace configured a server and the Agent declared one of its tools;
    // in that case this is a no-op and the run is unchanged.
    await runMcpToolLoop({
      userId: task.userId,
      agentId: agent.id,
      taskId,
      runId,
      timezone,
      // The same list the built-in planner saw, so the two cannot disagree
      // about what the Agent declared.
      tools: declaredTools,
      grants: grants.map((grant) => ({
        resource: grant.resource,
        scope: grant.scope,
      })),
      actionType: task.actionType,
      input: (task.title + " " + task.description).trim(),
      step: addStep,
    });

    // 模型自选工具：只在开关打开且确有可选工具时进入。
    // 每次调用仍走 grant → 周检索预算 → 连接器 → retrieval_calls 台账，
    // 失败按真实状态记录，不会写成成功。
    let modelToolEvidence: PersistedEvidence[] = [];
    // 模型自选工具那次也要计入 runs 的 token 与费用：它是一次真实计费调用。
    // usage 为 null 说明 provider 没报用量（或根本没调成功），不能当成 0。
    let modelToolUsage: { inputTokens: number; outputTokens: number } | null = null;
    // model 非 null 等价于"模型这次真的被调成功了"，是补 attempt 的依据。
    let modelToolModel: string | null = null;
    if (modelSelectsTools) {
      const selection = await runModelToolLoop({
        userId: task.userId,
        agentId: agent.id,
        taskId,
        runId,
        timezone,
        task: {
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          actionType: task.actionType,
        },
        allowed: selectable,
        grants: toolGrants,
        step: addStep,
      });
      // 模型自己取的证据同样可以进产物，否则它搜了也等于白搜。
      modelToolEvidence = selection.evidence;
      modelToolUsage = selection.usage;
      modelToolModel = selection.model;
    }

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
      skills: activeSkills.map((skill) => ({
        name: skill.name,
        steps: skill.steps,
      })),
      rules,
      evidence: [
        ...(search?.evidence ?? []),
        ...(page?.evidence ?? []),
        ...modelToolEvidence,
      ].map(
        (item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          publisher: item.publisher,
          quote: item.quote,
          kind: item.kind,
        }),
      ),
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
    // 模型自选工具那次也是一次真实的 provider 请求。如果 generateArtifact 没有
    // 产生 attempt（未配置 / 直接失败），就必须用工具那次的信息补上：
    // 否则 runs 行会声称"没联系过 provider"，而账上已经为那次调用花了钱。
    if (!attempt && modelToolModel !== null) {
      providerContact = "real";
      attempt = {
        attemptId: newId("att"),
        provider: "openai",
        model: modelToolModel,
        // provider 报了 token 才是 actual；没报就只能承认 unknown。
        costSource: modelToolUsage !== null ? "actual" : "unknown",
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
    const artifactMeasured =
      modelResult.status === "success" && modelResult.costSource === "actual"
        ? {
            tokensIn: modelResult.draft.tokensIn,
            tokensOut: modelResult.draft.tokensOut,
          }
        : null;
    // 两次真实计费调用（生成产物 + 模型自选工具）要合并成同一条 run 账：
    // 只记前者会让 runs 行少算一次 token，却仍然写着 costSource "actual"。
    // 两边都没有可信用量时才是 null——不能拿 0 冒充"没花钱"。
    const measured =
      artifactMeasured === null && modelToolUsage === null
        ? null
        : {
            tokensIn:
              (artifactMeasured?.tokensIn ?? 0) + (modelToolUsage?.inputTokens ?? 0),
            tokensOut:
              (artifactMeasured?.tokensOut ?? 0) + (modelToolUsage?.outputTokens ?? 0),
          };
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
            // measured 非 null 就说明至少有一次调用拿到了 provider 报的用量；
            // 工具那次单独拿到也算（默认关时与旧条件完全等价）。
            measured !== null
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

/** Rows as the commands layer sees them; the tables own the shape. */
type TaskRow = typeof tasks.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

/**
 * Retry path: a failed or rejected task re-enters the normal state machine at
 * planned.
 *
 * The UPDATE is guarded by the status that was just read, so a concurrent run
 * that got there first loses it and the caller sees a ConflictError instead of
 * two runs on one task.
 */
async function resetForRetry(taskId: string, userId: string, task: TaskRow) {
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
  return reset;
}

/**
 * The suggest effect: the policy lets the Agent propose but not act.
 *
 * The run is still recorded as succeeded with a rule-generated draft, so the
 * ledger and the trace say what actually happened. Nothing was executed, and
 * the task never leaves planned/assigned for running.
 */
async function suggestInsteadOfRunning(input: {
  task: TaskRow;
  agent: AgentRow;
  priorRunCount: number;
  demoMode: boolean;
  reason: string;
}) {
  const { task, agent, reason, priorRunCount, demoMode } = input;
  const taskId = task.id;
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
    const draft = draftFor(agent.role, task.title, priorRunCount, false);
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
      runLabel: `suggest_${taskId}_${priorRunCount + 1}`,
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
      input: { task: task.title, policy: reason },
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
      after: { status: "suggested", runId, reason },
    });
    return { runId, artifactId, suggested: true, reason };
  });
}

/**
 * The require_approval effect: park the task until a human decides.
 *
 * planned -> assigned -> awaiting_approval walks the legal state machine one
 * transition at a time instead of writing the final status directly, so the
 * audit trail has the same shape as a real execution.
 */
async function awaitApproval(input: {
  task: TaskRow;
  agent: AgentRow;
  reason: string;
}) {
  const { task, agent, reason } = input;
  const taskId = task.id;
  return db.transaction(async (tx) => {
    const approvalRecord = await requestApproval(
      {
        userId: task.userId,
        taskId,
        title: task.title,
        resource: task.resource,
        dueAt: task.dueAt,
        action: task.actionType,
        reason,
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
      reason,
    };
  });
}
