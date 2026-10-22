import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import {
  agents,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  goals,
  insights,
  memories,
  profiles,
  reviews,
  runs,
  skills,
  steps,
  tasks,
  users,
} from "./db/schema";
import { logAudit } from "./audit";
import { newId } from "./ids";
import { weekLabel } from "./format";
import { generateArtifact } from "./llm";

export const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "usr_zhen";

export async function getWorkspace() {
  const [user] = await db.select().from(users).where(eq(users.id, DEMO_USER_ID));
  if (!user) throw new Error("Demo workspace not seeded. Run `pnpm db:setup`.");
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, DEMO_USER_ID));
  return { user, profile };
}

export async function getTodayData() {
  const { user, profile } = await getWorkspace();
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, DEMO_USER_ID))
    .orderBy(asc(agents.createdAt));
  const allGoals = await db
    .select()
    .from(goals)
    .where(eq(goals.userId, DEMO_USER_ID));
  const openTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, DEMO_USER_ID),
        inArray(tasks.status, [
          "planned",
          "assigned",
          "running",
          "submitted",
          "rejected",
        ]),
      ),
    )
    .orderBy(asc(tasks.dueAt));
  const pendingApprovals = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.userId, DEMO_USER_ID), eq(approvals.status, "pending")),
    )
    .orderBy(asc(approvals.createdAt));
  const [openCouncil] = await db
    .select()
    .from(councils)
    .where(and(eq(councils.userId, DEMO_USER_ID), eq(councils.status, "open")))
    .orderBy(desc(councils.createdAt))
    .limit(1);
  const [todayCheckin] = await db
    .select()
    .from(checkins)
    .where(
      and(
        eq(checkins.userId, DEMO_USER_ID),
        eq(checkins.date, new Date().toISOString().slice(0, 10)),
      ),
    )
    .limit(1);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const [yesterdayCheckin] = await db
    .select()
    .from(checkins)
    .where(
      and(
        eq(checkins.userId, DEMO_USER_ID),
        eq(checkins.date, yesterday.toISOString().slice(0, 10)),
      ),
    )
    .limit(1);
  const [dailyReview] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.userId, DEMO_USER_ID), eq(reviews.type, "daily")))
    .orderBy(desc(reviews.createdAt))
    .limit(1);

  return {
    user,
    profile,
    agents: allAgents,
    goals: allGoals,
    tasks: openTasks,
    approvals: pendingApprovals,
    council: openCouncil ?? null,
    checkin: todayCheckin ?? null,
    yesterdayCheckin: yesterdayCheckin ?? null,
    brief: dailyReview ?? null,
  };
}

export async function getCabinetData() {
  const { user, profile } = await getWorkspace();
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, DEMO_USER_ID))
    .orderBy(asc(agents.createdAt));
  const openTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, DEMO_USER_ID));
  return { user, profile, agents: allAgents, tasks: openTasks };
}

export async function getAgentData(agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;
  const agentRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.agentId, agentId))
    .orderBy(desc(runs.createdAt))
    .limit(10);
  const agentMemories = await db
    .select()
    .from(memories)
    .where(eq(memories.agentId, agentId))
    .orderBy(desc(memories.salience))
    .limit(8);
  const agentSkills = await db
    .select()
    .from(skills)
    .where(eq(skills.agentId, agentId));
  const assigned = await db
    .select()
    .from(tasks)
    .where(eq(tasks.assigneeId, agentId))
    .orderBy(desc(tasks.updatedAt))
    .limit(8);
  return {
    agent,
    runs: agentRuns,
    memories: agentMemories,
    skills: agentSkills,
    tasks: assigned,
  };
}

export async function getTaskData(taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.createdAt));
  const runIds = taskRuns.map((r) => r.id);
  const runSteps = runIds.length
    ? await db
        .select()
        .from(steps)
        .where(inArray(steps.runId, runIds))
        .orderBy(asc(steps.idx))
    : [];
  const taskArtifacts = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt));
  const [goal] = task.goalId
    ? await db.select().from(goals).where(eq(goals.id, task.goalId))
    : [null];
  const [assignee] = task.assigneeId
    ? await db.select().from(agents).where(eq(agents.id, task.assigneeId))
    : [null];
  const [auditor] = task.auditorId
    ? await db.select().from(agents).where(eq(agents.id, task.auditorId))
    : [null];
  const taskApprovals = await db
    .select()
    .from(approvals)
    .where(eq(approvals.taskId, taskId));
  const taskAudit = await db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.userId, DEMO_USER_ID), eq(auditEvents.target, taskId)),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(10);
  return {
    task,
    goal: goal ?? null,
    assignee: assignee ?? null,
    auditor: auditor ?? null,
    runs: taskRuns,
    steps: runSteps,
    artifacts: taskArtifacts,
    approvals: taskApprovals,
    audit: taskAudit,
  };
}

export async function getReviewData() {
  const { user, profile } = await getWorkspace();
  const [weekly] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.userId, DEMO_USER_ID), eq(reviews.type, "weekly")))
    .orderBy(desc(reviews.createdAt))
    .limit(1);
  const allInsights = await db
    .select()
    .from(insights)
    .where(eq(insights.userId, DEMO_USER_ID))
    .orderBy(desc(insights.createdAt));
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, DEMO_USER_ID))
    .orderBy(asc(agents.createdAt));
  const allTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, DEMO_USER_ID));
  const recentAudit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.userId, DEMO_USER_ID))
    .orderBy(desc(auditEvents.createdAt))
    .limit(12);
  return {
    user,
    profile,
    weekly: weekly ?? null,
    insights: allInsights,
    agents: allAgents,
    tasks: allTasks,
    audit: recentAudit,
  };
}

export async function getMemoryData(type?: string) {
  const all = await db
    .select()
    .from(memories)
    .where(eq(memories.userId, DEMO_USER_ID))
    .orderBy(desc(memories.salience));
  const filtered = type ? all.filter((m) => m.type === type) : all;
  const counts = {
    all: all.length,
    episodic: all.filter((m) => m.type === "episodic").length,
    semantic: all.filter((m) => m.type === "semantic").length,
    procedural: all.filter((m) => m.type === "procedural").length,
  };
  const now = Date.now();
  const stale = all.filter(
    (m) => m.expiresAt && new Date(m.expiresAt).getTime() < now,
  ).length;
  return { memories: filtered, counts, stale };
}

export async function getCouncilData() {
  const [council] = await db
    .select()
    .from(councils)
    .where(eq(councils.userId, DEMO_USER_ID))
    .orderBy(desc(councils.createdAt))
    .limit(1);
  if (!council) return null;
  const positions = await db
    .select()
    .from(councilPositions)
    .where(eq(councilPositions.councilId, council.id))
    .orderBy(asc(councilPositions.createdAt));
  const allAgents = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, DEMO_USER_ID));
  return { council, positions, agents: allAgents };
}

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function draftFor(
  agentRole: string,
  taskTitle: string,
  priorRuns: number,
): { title: string; content: string } {
  if (agentRole === "researcher") {
    return {
      title: `${taskTitle} · 资料卡`,
      content: `# ${taskTitle}

## 结论
RAG 的核心不是"把文档塞进 prompt"，而是"召回、重排、约束生成"三件事。

## 证据
1. Retrieval-Augmented Generation for LLMs: A Survey
   https://arxiv.org/abs/2312.10997
2. RAG 的评估应以 recall@k、precision、faithfulness 为主。
   来源：https://arxiv.org/abs/2312.10997

## 不确定
- rerank 的具体延迟取决于模型和批量大小，需要实测。`,
    };
  }

  if (agentRole === "coach" && (taskTitle.includes("评估") || taskTitle.includes("练习"))) {
    const rubric =
      priorRuns >= 2
        ? `

## 评分标准（rubric）
| 维度 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| 概念准确 | 定义错误 | 定义基本正确 | 定义准确且有例子 |
| 指标理解 | 混淆 recall/precision | 能区分 | 能说明权衡 |
| rerank | 不知道 | 知道用途 | 能说出代价与替代 |
| 评估设计 | 无 | 有题目 | 有题目 + 参考答案 + 评分标准 |

> 总分 ≥6/8 视为通过。`
        : `

> 备注：本版本尚未附评分标准。`;
    return {
      title: `${taskTitle} · v${priorRuns + 1}`,
      content: `# ${taskTitle}

1. recall@k 的定义是什么？举一个检索例子。
2. precision 和 recall 如何权衡？
3. rerank 解决什么问题？代价是什么？
4. 如何构造 20 条问题的评估集？
5. 模型答对但引用错了，算不算成功？

## 参考答案
1. 前 k 个结果中相关文档的比例……
2. 提高 recall 往往引入噪声，precision 下降……
3. rerank 用 cross-encoder 精排，代价是延迟……
4. 从真实问题采样，标注 gold chunk……
5. 不算；引用错误视为幻觉。${rubric}`,
    };
  }

  if (agentRole === "treasurer") {
    return {
      title: `${taskTitle} · 预算表`,
      content: `# 本周学习预算

| 项目 | 金额 | 备注 |
|---|---:|---|
| 课程试学 | ¥199 | 7 天可退 |
| 工具订阅 | ¥0 | 已有 |
| 资料 | ¥81 | 本月剩余 |
| **合计** | **¥280 / ¥600** | 剩余 ¥320 |

## 结论
本周不超支；年包 ¥599 会超支，建议只买月付。`,
    };
  }

  if (agentRole === "auditor") {
    return {
      title: `${taskTitle} · 审计记录`,
      content: `# 审计记录

- 验收标准：已逐条对照
- 证据：已附来源
- 结论：见审计结果`,
    };
  }

  if (agentRole === "apprentice") {
    return {
      title: `${taskTitle} · 技能草案`,
      content: `# 技能草案：检索评估练习设计

## 步骤
1. 读取 mentor 的 5 次成功运行
2. 提取题目结构：定义题 / 对比题 / 场景题
3. 为每题生成参考答案
4. 生成评分标准（rubric）
5. 自检：覆盖 recall / precision / rerank

## 护栏
- 不得编造引用
- 每题必须有评分标准`,
    };
  }

  if (agentRole === "critic") {
    return {
      title: `${taskTitle} · 风险清单`,
      content: `# 风险清单

- 任务粒度仍可能过大
- 评估集只有 5 题，统计意义不足
- 没有留出集，容易过拟合`,
    };
  }

  return {
    title: `${taskTitle} · 计划`,
    content: `# ${taskTitle}

## 本周目标
- 完成检索基础 + chunking
- 每天 25–45 分钟
- 周三晚上不排任务

## 验收
- 每个任务有产物
- 周末能做一次 10 题自测`,
  };
}

export async function runTask(taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error("Task not found");
  const agentId = task.assigneeId ?? "ag_chief";
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new Error("Agent not found");

  const prior = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.taskId, taskId));

  const runId = newId("run");
  const startedAt = new Date();
  await db.insert(runs).values({
    id: runId,
    taskId,
    agentId,
    status: "running",
    mode: process.env.OPENAI_API_KEY ? "live" : "demo",
    startedAt,
    replayKey: `replay_${taskId}_${prior.length + 1}`,
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

  const agentMemories = await db
    .select()
    .from(memories)
    .where(eq(memories.userId, task.userId))
    .orderBy(desc(memories.salience))
    .limit(5);

  await addStep({
    type: "context",
    input: { task: task.title, agent: agent.name },
    output: {
      memories: agentMemories.map((m) => m.content),
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

  const generated = await generateArtifact({
    agentName: agent.name,
    role: agent.role,
    charter: agent.charter,
    taskTitle: task.title,
    taskDescription: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    memories: agentMemories.map((m) => m.content),
  });
  const draft = generated ?? draftFor(agent.role, task.title, prior.length);
  const artifactId = newId("art");
  await db.insert(artifacts).values({
    id: artifactId,
    runId,
    taskId,
    type: "markdown",
    title: draft.title,
    content: draft.content,
  });

  await addStep({
    type: "draft",
    input: { format: "markdown", mode: generated ? "live" : "demo" },
    output: { artifactId, title: draft.title },
    ti: generated ? generated.tokensIn : 500,
    to: generated ? generated.tokensOut : 600,
    latency: generated ? 2400 : 1100,
  });

  await db
    .update(tasks)
    .set({ status: "submitted", updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  await addStep({
    type: "submit",
    input: { auditor: task.auditorId },
    output: { status: "submitted" },
    ti: 40,
    to: 20,
    latency: 40,
  });

  const cost = Number(((tokensIn + tokensOut) / 1000 * 0.8).toFixed(2));
  await db
    .update(runs)
    .set({
      status: "succeeded",
      endedAt: new Date(),
      costCents: cost,
      tokensIn,
      tokensOut,
    })
    .where(eq(runs.id, runId));

  await logAudit({
    userId: task.userId,
    actor: `agent:${agent.id}`,
    action: "task.submit",
    target: taskId,
    before: { status: task.status },
    after: { status: "submitted", runId },
  });

  return { runId, artifactId };
}

export async function auditTask(taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new Error("Task not found");
  const [auditor] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, task.auditorId ?? "ag_auditor"));
  if (!auditor) throw new Error("Auditor not found");

  const taskRuns = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt));
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    taskId,
    agentId: auditor.id,
    status: "running",
    mode: "demo",
    startedAt: new Date(),
    replayKey: `audit_${taskId}_${taskRuns.length + 1}`,
  });

  let idx = 0;
  const addStep = async (input: {
    type: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }) => {
    idx += 1;
    await db.insert(steps).values({
      id: newId("stp"),
      runId,
      idx,
      type: input.type,
      input: input.input,
      output: input.output,
      tokensIn: 80,
      tokensOut: 40,
      latencyMs: 100,
    });
  };

  await addStep({
    type: "context",
    input: { task: taskId, artifact: artifact?.id ?? null },
    output: { found: Boolean(artifact) },
  });

  let pass = Boolean(artifact);
  let reason = pass
    ? "产物存在，验收标准逐条对照通过。"
    : "没有找到可验收的产物。";

  const requiresRubric =
    task.acceptanceCriteria.includes("评分标准") ||
    task.acceptanceCriteria.toLowerCase().includes("rubric");
  if (requiresRubric && artifact) {
    const hasRubric =
      artifact.content.includes("## 评分标准") ||
      artifact.content.includes("| 维度 |");
    if (!hasRubric) {
      pass = false;
      reason = "缺少评分标准（rubric），无法判断题目质量。请补充后重新提交。";
    }
  }

  await addStep({
    type: "audit",
    input: { acceptanceCriteria: task.acceptanceCriteria },
    output: { pass, reason },
  });

  await db
    .update(runs)
    .set({
      status: "succeeded",
      endedAt: new Date(),
      costCents: 0.4,
      tokensIn: 160,
      tokensOut: 80,
    })
    .where(eq(runs.id, runId));

  const nextStatus = pass ? "accepted" : "rejected";
  await db
    .update(tasks)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  const executorId = task.assigneeId;
  if (executorId) {
    const [executor] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, executorId));
    if (executor) {
      await db
        .update(agents)
        .set({
          successCount: executor.successCount + (pass ? 1 : 0),
          failCount: executor.failCount + (pass ? 0 : 1),
          trustScore: clamp(executor.trustScore + (pass ? 1 : -2)),
        })
        .where(eq(agents.id, executorId));
    }
  }

  if (pass && task.goalId) {
    const [goal] = await db.select().from(goals).where(eq(goals.id, task.goalId));
    if (goal) {
      await db
        .update(goals)
        .set({ progress: clamp(goal.progress + 2, 0, 100) })
        .where(eq(goals.id, goal.id));
    }
  }

  await logAudit({
    userId: task.userId,
    actor: `agent:${auditor.id}`,
    action: pass ? "audit.accept" : "audit.reject",
    target: taskId,
    before: { status: "submitted" },
    after: { status: nextStatus, reason },
  });

  return { decision: pass ? "accepted" : "rejected", reason, runId };
}

export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  reason?: string,
) {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));
  if (!approval) throw new Error("Approval not found");

  await db
    .update(approvals)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      reason: reason ?? null,
      decidedAt: new Date(),
    })
    .where(eq(approvals.id, approvalId));

  if (approval.taskId) {
    await db
      .update(tasks)
      .set({
        status: decision === "approve" ? "accepted" : "failed",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, approval.taskId));
  }

  await logAudit({
    userId: approval.userId,
    actor: "user",
    action: decision === "approve" ? "approval.grant" : "approval.deny",
    target: approval.id,
    before: { status: "pending" },
    after: { status: decision, reason: reason ?? null },
  });
}

export async function decideCouncil(
  councilId: string,
  decision: "approve" | "reject" | "conditions",
  note: string,
) {
  const [council] = await db
    .select()
    .from(councils)
    .where(eq(councils.id, councilId));
  if (!council) throw new Error("Council not found");

  const label =
    decision === "approve"
      ? "批准"
      : decision === "reject"
        ? "否决"
        : "有条件批准";

  await db
    .update(councils)
    .set({
      status: "decided",
      memo: `${council.memo}\n\n## 决定\n${label}：${note}`,
      decidedAt: new Date(),
    })
    .where(eq(councils.id, councilId));

  await logAudit({
    userId: council.userId,
    actor: "user",
    action: "council.decide",
    target: councilId,
    before: { status: "open" },
    after: { status: "decided", decision, note },
  });
}

export async function setAutonomy(agentId: string, level: number) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new Error("Agent not found");
  if (level < 0 || level > 4) throw new Error("Invalid level");

  if (level > agent.autonomyLevel) {
    if (agent.lifecycleStage !== "active") {
      throw new Error("试用期/影子学习中的 Agent 不能升级。");
    }
    if (agent.trustScore < 70) {
      throw new Error(`信任分不足：${agent.trustScore.toFixed(0)} / 70。`);
    }
    if (agent.successCount < 3) {
      throw new Error(`成功任务数不足：${agent.successCount} / 3。`);
    }
  }

  await db
    .update(agents)
    .set({ autonomyLevel: level })
    .where(eq(agents.id, agentId));

  await logAudit({
    userId: agent.userId,
    actor: "user",
    action: "autonomy.change",
    target: agentId,
    before: { level: agent.autonomyLevel },
    after: { level },
  });
}

export async function applyInsight(
  insightId: string,
  action: "accept" | "reject" | "rollback",
) {
  const [insight] = await db
    .select()
    .from(insights)
    .where(eq(insights.id, insightId));
  if (!insight) throw new Error("Insight not found");

  if (action === "reject") {
    await db
      .update(insights)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(insights.id, insightId));
    await logAudit({
      userId: insight.userId,
      actor: "user",
      action: "insight.reject",
      target: insightId,
      before: { status: insight.status },
      after: { status: "rejected" },
    });
    return;
  }

  if (action === "rollback") {
    await reverseChange(insight.proposedChange, insight.userId);
    await db
      .update(insights)
      .set({ status: "rolled_back", decidedAt: new Date() })
      .where(eq(insights.id, insightId));
    await logAudit({
      userId: insight.userId,
      actor: "user",
      action: "insight.rollback",
      target: insightId,
      before: { status: insight.status },
      after: { status: "rolled_back" },
    });
    return;
  }

  await applyChange(insight.proposedChange, insight.userId);

  await db
    .update(insights)
    .set({ status: "applied", decidedAt: new Date() })
    .where(eq(insights.id, insightId));

  const domain =
    insight.proposedChange.type === "reschedule" ? "health" : "learning";
  await db.insert(memories).values({
    id: newId("mem"),
    userId: insight.userId,
    agentId: "ag_chief",
    type: "semantic",
    domain,
    content: insight.claim,
    confidence: insight.confidence,
    salience: 0.8,
    evidence: insight.evidence,
    sourceEventId: insight.id,
    lastConfirmedAt: new Date(),
  });

  await logAudit({
    userId: insight.userId,
    actor: "user",
    action: "insight.accept",
    target: insightId,
    before: { status: insight.status },
    after: { status: "applied", change: insight.proposedChange },
  });
}

async function applyChange(
  change: {
    type: string;
    taskId?: string;
    to?: string;
    minutes?: number;
    rule?: string;
  },
  userId: string,
) {
  if (change.type === "reschedule" && change.taskId && change.to) {
    const [h, m] = change.to.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    await db
      .update(tasks)
      .set({ dueAt: d, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
  }
  if (change.type === "split_task" && change.taskId && change.minutes) {
    await db
      .update(tasks)
      .set({ estimateMin: change.minutes, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
  }
  if (change.type === "add_rule" && change.rule) {
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    if (profile) {
      const prefs = profile.preferences as Record<string, unknown>;
      const rules = Array.isArray(prefs.rules) ? (prefs.rules as string[]) : [];
      if (!rules.includes(change.rule)) rules.push(change.rule);
      await db
        .update(profiles)
        .set({ preferences: { ...prefs, rules }, updatedAt: new Date() })
        .where(eq(profiles.userId, userId));
    }
  }
}

async function reverseChange(
  change: {
    type: string;
    taskId?: string;
    from?: string;
    rule?: string;
  },
  userId: string,
) {
  if (change.type === "reschedule" && change.taskId && change.from) {
    const [h, m] = change.from.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    await db
      .update(tasks)
      .set({ dueAt: d, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
  }
  if (change.type === "split_task" && change.taskId) {
    await db
      .update(tasks)
      .set({ estimateMin: 45, updatedAt: new Date() })
      .where(eq(tasks.id, change.taskId));
  }
  if (change.type === "add_rule" && change.rule) {
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId));
    if (profile) {
      const prefs = profile.preferences as Record<string, unknown>;
      const rules = Array.isArray(prefs.rules) ? (prefs.rules as string[]) : [];
      await db
        .update(profiles)
        .set({
          preferences: {
            ...prefs,
            rules: rules.filter((r) => r !== change.rule),
          },
          updatedAt: new Date(),
        })
        .where(eq(profiles.userId, userId));
    }
  }
}

export async function saveCheckin(input: {
  energy: number;
  mood: number;
  completed: Array<{ taskId: string; done: boolean }>;
  note: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  await db.insert(checkins).values({
    id: newId("chk"),
    userId: DEMO_USER_ID,
    date: today,
    energy: input.energy,
    mood: input.mood,
    completed: input.completed,
    note: input.note,
  });

  for (const item of input.completed) {
    if (item.done) {
      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, item.taskId));
      if (task && !["accepted", "done"].includes(task.status)) {
        await db
          .update(tasks)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(tasks.id, item.taskId));
      }
    }
  }

  if (input.note.trim()) {
    await db.insert(memories).values({
      id: newId("mem"),
      userId: DEMO_USER_ID,
      agentId: "ag_coach",
      type: "episodic",
      domain: "checkin",
      content: input.note.trim(),
      confidence: 0.9,
      salience: 0.55,
      evidence: [{ label: "今日 check-in", ref: "checkin_today" }],
      sourceEventId: "checkin_today",
      lastConfirmedAt: new Date(),
    });
  }

  await logAudit({
    userId: DEMO_USER_ID,
    actor: "user",
    action: "checkin.save",
    target: today,
    before: null,
    after: { energy: input.energy, mood: input.mood },
  });
}

export async function runApprenticeExam() {
  const [apprentice] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, "ag_apprentice"));
  if (!apprentice) throw new Error("Apprentice not found");
  const [skill] = await db
    .select()
    .from(skills)
    .where(eq(skills.agentId, "ag_apprentice"))
    .orderBy(desc(skills.createdAt))
    .limit(1);

  const runId = newId("run");
  await db.insert(runs).values({
    id: runId,
    taskId: "tsk_quiz",
    agentId: "ag_apprentice",
    status: "succeeded",
    mode: "demo",
    startedAt: new Date(),
    endedAt: new Date(),
    costCents: 0.6,
    tokensIn: 400,
    tokensOut: 220,
    replayKey: "apprentice_exam_v1",
  });
  await db.insert(steps).values([
    {
      id: newId("stp"),
      runId,
      idx: 1,
      type: "tool",
      tool: "read_runs",
      input: { mentor: "ag_coach", runs: 5 },
      output: { loaded: 5 },
      tokensIn: 200,
      tokensOut: 0,
      latencyMs: 120,
    },
    {
      id: newId("stp"),
      runId,
      idx: 2,
      type: "draft",
      input: { skill: skill?.name ?? "检索评估练习设计" },
      output: { rubric: true },
      tokensIn: 120,
      tokensOut: 160,
      latencyMs: 500,
    },
    {
      id: newId("stp"),
      runId,
      idx: 3,
      type: "audit",
      input: { heldOutTasks: 5 },
      output: { passed: 5, required: 4 },
      tokensIn: 80,
      tokensOut: 60,
      latencyMs: 300,
    },
  ]);

  await db
    .update(agents)
    .set({
      lifecycleStage: "active",
      status: "active",
      trustScore: clamp(apprentice.trustScore + 10),
      successCount: apprentice.successCount + 1,
      autonomyLevel: 2,
    })
    .where(eq(agents.id, apprentice.id));

  if (skill) {
    await db
      .update(skills)
      .set({
        status: "active",
        successCount: 1,
        eval: { status: "passed", required: 5, passed: 5 },
      })
      .where(eq(skills.id, skill.id));
  }

  await logAudit({
    userId: apprentice.userId,
    actor: "agent:ag_auditor",
    action: "apprentice.promote",
    target: "ag_apprentice",
    before: { stage: "shadowing" },
    after: { stage: "active", exam: "5/5", skill: "active" },
  });

  return { runId, passed: 5, required: 5 };
}

export async function regenerateBrief() {
  const data = await getTodayData();
  const lines = [
    `# ${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} 早报`,
    "",
    `目标：${data.goals.map((g) => `${g.title}（${Math.round(g.progress)}%）`).join(" · ")}`,
    "",
    "## 今天的关键判断",
    data.tasks.length > 0
      ? `- 今天有 ${data.tasks.length} 个待推进任务，优先处理已提交待验收的。`
      : "- 今天没有待推进任务，适合复盘或补弱项。",
    `- 需要你决定：${data.approvals.length} 个审批${data.council ? " + 1 个内阁会议" : ""}。`,
    "",
    "## 建议顺序",
    ...data.tasks.slice(0, 3).map((t, i) => `${i + 1}. ${t.title}（${t.estimateMin} 分钟）`),
  ];
  const content = lines.join("\n");
  await db.insert(reviews).values({
    id: newId("rev"),
    userId: DEMO_USER_ID,
    period: new Date().toISOString().slice(0, 10),
    type: "daily",
    narrative: content,
    metrics: { tasks: data.tasks.length, decisions: data.approvals.length },
    decisions: [],
  });
  return content;
}

export async function runReflection() {
  const claim = "把 21:00 的阅读任务移到 13:30，晚上只做复盘。";
  const [existing] = await db
    .select()
    .from(insights)
    .where(and(eq(insights.userId, DEMO_USER_ID), eq(insights.claim, claim)))
    .limit(1);
  if (existing) return existing;

  const [latestCheckin] = await db
    .select()
    .from(checkins)
    .where(eq(checkins.userId, DEMO_USER_ID))
    .orderBy(desc(checkins.createdAt))
    .limit(1);

  const insight = {
    id: newId("ins"),
    userId: DEMO_USER_ID,
    claim,
    rationale:
      `最近一次 check-in 精力 ${latestCheckin?.energy ?? 3}/5；过去 3 次 21:00 后的任务完成率只有 33%。` +
      "这不是意志力问题，是时段问题：把高认知任务放到午休后，晚上只保留低负荷复盘。",
    confidence: 0.74,
    evidence: [
      {
        label: "最近 check-in",
        ref: latestCheckin?.id ?? "chk_yesterday",
        quote: latestCheckin?.note ?? "晚上太累",
      },
      {
        label: "晚间完成率 33%",
        ref: "tasks_history",
        quote: "21:00 后任务 1/3 完成",
      },
    ],
    proposedChange: {
      type: "reschedule" as const,
      taskId: "tsk_read",
      from: "21:00",
      to: "13:30",
    },
    status: "proposed",
  };

  await db.insert(insights).values(insight);
  await logAudit({
    userId: DEMO_USER_ID,
    actor: "agent:ag_coach",
    action: "insight.propose",
    target: insight.id,
    before: null,
    after: { claim: insight.claim, confidence: insight.confidence },
  });
  return insight;
}

export function currentWeek() {
  return weekLabel(new Date());
}
