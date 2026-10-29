import { and, desc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db } from "./index";
import {
  accounts,
  agentBudgetPeriods,
  agentGrants,
  agentTemplates,
  agents,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  dissents,
  goals,
  insights,
  memories,
  policyConfig,
  profiles,
  reviews,
  runs,
  skills,
  steps,
  tasks,
  userActions,
  users,
} from "./schema";
import { canonicalJson, sha256 } from "../ids";
import { weekLabel } from "../format";
import { SEED_POLICY_CONFIG } from "../domain/policy";
import { computeLearningProgress } from "../domain/learning-progress";
import { LEARNING_TEMPLATES } from "../domain/learning";
import { getPolicyConfig } from "../policy/config";
import {
  addLocalDays,
  localDateKey,
  localDateTimeParts,
  startOfLocalWeek,
  weekRange,
  zonedTimeToUtc,
} from "../domain/time";
import { AGENT_TEMPLATES } from "@/contracts/templates";
import { hashPassword } from "better-auth/crypto";

const USER_ID = "usr_zhen";
const DEMO_TIMEZONE = "Asia/Shanghai";

/**
 * Money is integer cents everywhere (see `money(cents)` in lib/format). A run
 * that costs ¥2.10 stores 210, never 2.1, so `runs.cost_cents` and the weekly
 * `agent_budget_periods` ledger can be summed and compared without rescaling.
 * The three demo runs are the whole of this week's model usage.
 *
 * Exported so integration tests can assert the weekly ledger against the seeded
 * amount instead of hardcoding a second copy of the numbers.
 */
export const RUN_COST_CENTS = {
  plan: 210, // ¥2.10
  research: 340, // ¥3.40
  quiz: 180, // ¥1.80
} as const;

/** This week's model spend, as the seeded runs report it. */
const WEEK_RUN_SPEND_CENTS =
  RUN_COST_CENTS.plan + RUN_COST_CENTS.research + RUN_COST_CENTS.quiz;

function at(dayOffset: number, hour: number, minute = 0): Date {
  // Demo data must mean the same wall-clock time on every machine, including
  // CI (UTC), so resolve the demo timezone explicitly instead of using
  // process-local setHours().
  const now = localDateTimeParts(new Date(), DEMO_TIMEZONE);
  const shifted = new Date(
    Date.UTC(now.year, now.month - 1, now.day + dayOffset),
  );
  return zonedTimeToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
    DEMO_TIMEZONE,
  );
}

function day(offset: number): string {
  return localDateKey(at(offset, 12), DEMO_TIMEZONE);
}

/**
 * 重建整个演示工作区。
 *
 * 这个函数只做一件事：按顺序点名各段数据，让「种子数据长什么样」变成一张可读的目录。
 * 任何一段的顺序都不能随便调——后面的段引用前面的 id，FK 会立刻发现。
 */
export async function seedDemo(): Promise<void> {
  await wipeDemoTables();

  const now = new Date();
  const weekStart = startOfLocalWeek(now, DEMO_TIMEZONE);

  await seedAccount();
  await seedPolicyAndAgents(weekStart);
  await seedGoalsAndTasks();
  await seedRuns();
  await seedBudgetPeriods(weekStart);
  await seedRunDetails();
  await seedMemoryLayer(now);
  await seedGovernance();
  await seedCouncil();
  await seedSamples();
  await markDemoFixtures();
  await seedLearningProgress();
}

/**
 * 学习目标的进度是派生值，不是设定值。
 *
 * 这里以前写死 `progress: 38`，而公式按种子自己的数据算出来是 16：用户第一次
 * 打卡（或复盘、验收任何一步触发重算）就会看到进度"掉"了 22 点——他没有取消
 * 任何任务，只是那次重算第一次把真话说出来。种子只负责把输入铺好，输出按同一份
 * 公式算，`tests/integration/demo-progress.test.ts` 守着两者相等。
 */
async function seedLearningProgress(): Promise<void> {
  const config = await getPolicyConfig();
  const range = weekRange(new Date(), DEMO_TIMEZONE);
  const [taskRows, checkinRows, recallRows] = await Promise.all([
    db
      .select({ status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, USER_ID),
          eq(tasks.goalId, "goal_rag"),
          inArray(tasks.template, [...LEARNING_TEMPLATES]),
          // 撤回的任务不进分母（与 commands/progress.ts 的同一条规则）。
          ne(tasks.status, "cancelled"),
        ),
      ),
    db
      .select({ id: checkins.id })
      .from(checkins)
      .where(
        and(
          eq(checkins.userId, USER_ID),
          gte(checkins.date, localDateKey(range.start, DEMO_TIMEZONE)),
          lt(checkins.date, localDateKey(range.end, DEMO_TIMEZONE)),
        ),
      ),
    db
      .select({ recallScore: checkins.recallScore })
      .from(checkins)
      .where(and(eq(checkins.userId, USER_ID), isNotNull(checkins.recallScore)))
      .orderBy(desc(checkins.date))
      .limit(1),
  ]);

  const progress = computeLearningProgress({
    acceptedLearningTasks: taskRows.filter((row) =>
      ["accepted", "done"].includes(row.status),
    ).length,
    totalLearningTasks: taskRows.length,
    latestRecallScore: recallRows[0]?.recallScore ?? null,
    checkinsThisWeek: checkinRows.length,
    config: config.learning,
  });

  await db
    .update(goals)
    .set({ progress })
    .where(and(eq(goals.id, "goal_rag"), eq(goals.userId, USER_ID)));
}

/** 先把 demo 用到的表清空。单一入口保证重复 seed 不会累积出两份历史。 */
async function wipeDemoTables(): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      agent_budget_reservations, agent_budget_periods,
      apprentice_exam_snapshots, apprentice_observations,
      dissents, council_positions, councils, skills, checkins, audit_events, approvals,
      reviews, insights, policy_overrides, memories, artifacts, steps, runs, tasks, goals,
      learning_attempts, learning_mastery, learning_topics,
      agent_grants, agent_templates, agents, profiles, policy_config,
      idempotency_keys, rate_limits, user_actions, sessions, accounts,
      verifications, users
    CASCADE
  `);
}

/** 一个用户、一个登录方式、一份画像。演示口令固定，方便本地反复登录。 */
async function seedAccount(): Promise<void> {
  const demoPasswordHash = await hashPassword("cabinet-demo");

  await db.insert(users).values({
    id: USER_ID,
    email: "demo@cabinet.local",
    name: "Zhen",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });

  await db.insert(accounts).values({
    id: "acc_demo",
    accountId: USER_ID,
    providerId: "credential",
    userId: USER_ID,
    password: demoPasswordHash,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(profiles).values({
    userId: USER_ID,
    constraints: {
      weekdayMinutes: 90,
      monthlyLearningBudgetCents: 60000,
      noWorkAfter: "21:30",
    },
    preferences: {
      examplesBeforeTheory: true,
      shortTasks: true,
      language: "zh-CN",
      rules: ["讲解先给例子，再给定义"],
    },
    energyPattern: {
      peak: "09:00-11:30",
      dip: "14:00-15:00",
      low: "20:00-23:00",
    },
    managementBudgetMin: 3,
  });
}

/** 策略配置、Agent 模板、五个 Agent 与它们的授权。预算周期起点跟着本周走，否则演示数据会漂到上一周。 */
async function seedPolicyAndAgents(weekStart: Date): Promise<void> {
  await db.insert(policyConfig).values(
    (
      [
        "autonomy",
        "audit",
        "budget",
        "management",
        "cost",
        "council",
        "reflection",
        "dissent",
        "learning",
      ] as const
    ).map((key) => ({
      key,
      valueJson: SEED_POLICY_CONFIG[key],
      description: `Cabinet policy: ${key}`,
    })),
  );

  await db.insert(agentTemplates).values(AGENT_TEMPLATES);

  await db.insert(agents).values([
    {
      id: "ag_chief",
      userId: USER_ID,
      role: "chief",
      name: "Atlas",
      title: "Chief of Staff",
      avatar: "AT",
      objective: "目标推进",
      charter:
        "我负责把目标变成一周内可执行的计划。我不亲自执行，也不给自己的任务盖章。任何超出预算或涉及外部世界的动作，必须交给用户批准。",
      model: "auto",
      status: "active",
      autonomyLevel: 2,
      trustScore: 78,
      lifecycleStage: "active",
      tools: ["read_all", "write_plan", "dispatch", "convene_council"],
      memoryScope: ["goals", "tasks", "reviews"],
      budgetCents: 3000,
      spentCents: RUN_COST_CENTS.plan,
      successCount: 24,
      failCount: 2,
    },
    {
      id: "ag_research",
      userId: USER_ID,
      role: "researcher",
      name: "Iris",
      title: "Researcher",
      avatar: "IR",
      objective: "证据质量",
      charter:
        "我只相信可追溯的来源。每条结论必须带链接和原文引用；找不到证据时，我说不知道。",
      model: "auto",
      status: "active",
      autonomyLevel: 2,
      trustScore: 74,
      lifecycleStage: "active",
      tools: ["web_search", "web_fetch", "read_notes"],
      memoryScope: ["notes", "web"],
      budgetCents: 800,
      spentCents: RUN_COST_CENTS.research,
      successCount: 18,
      failCount: 3,
    },
    {
      id: "ag_coach",
      userId: USER_ID,
      role: "coach",
      name: "Mira",
      title: "Coach",
      avatar: "MI",
      objective: "你的学习效果",
      charter:
        "我负责让你真的学会，而不是让任务显示完成。我根据你的错误模式调整难度，必要时把任务拆小。",
      model: "auto",
      status: "active",
      autonomyLevel: 2,
      trustScore: 66,
      lifecycleStage: "active",
      tools: ["read_notes", "write_task", "calendar_read", "quiz"],
      memoryScope: ["learning", "health", "checkins", "checkin"],
      budgetCents: 1200,
      spentCents: RUN_COST_CENTS.quiz,
      successCount: 12,
      failCount: 4,
    },
    {
      id: "ag_treasurer",
      userId: USER_ID,
      role: "treasurer",
      name: "Vault",
      title: "Treasurer",
      avatar: "VA",
      objective: "资源效率",
      charter:
        "我保护你的钱、时间和注意力。任何超预算的计划，我会否决并给替代方案。",
      model: "auto",
      status: "active",
      autonomyLevel: 1,
      trustScore: 81,
      lifecycleStage: "active",
      tools: ["ledger_read", "calendar_read", "budget_veto"],
      memoryScope: ["budget", "calendar"],
      budgetCents: 1000,
      spentCents: 0,
      successCount: 9,
      failCount: 0,
    },
    {
      id: "ag_auditor",
      userId: USER_ID,
      role: "auditor",
      name: "Justus",
      title: "Auditor",
      avatar: "JU",
      objective: "真实性",
      charter:
        "我只验收，不执行。我按验收标准检查证据；我可以驳回，Chief 不能推翻我。只有用户能覆盖，且必须留下理由。",
      model: "auto",
      status: "active",
      autonomyLevel: 2,
      trustScore: 88,
      lifecycleStage: "active",
      tools: ["read_artifacts", "read_runs", "audit_decision"],
      memoryScope: ["all_evidence"],
      budgetCents: 500,
      spentCents: 0,
      successCount: 31,
      failCount: 1,
    },
    {
      id: "ag_apprentice",
      userId: USER_ID,
      role: "apprentice",
      name: "Pip",
      title: "Apprentice",
      avatar: "PI",
      objective: "能力增长",
      charter:
        "我在影子中学习。我先观察 5 次成功运行，再提出技能草案，最后通过留出任务考试，才能转正。",
      model: "auto",
      status: "probation",
      autonomyLevel: 1,
      trustScore: 42,
      lifecycleStage: "shadowing",
      mentorId: "ag_coach",
      tools: ["read_runs", "sandbox_execute"],
      memoryScope: ["mentor_runs", "skills"],
      budgetCents: 200,
      spentCents: 12,
      successCount: 2,
      failCount: 3,
    },
    {
      id: "ag_critic",
      userId: USER_ID,
      role: "critic",
      name: "Cass",
      title: "Critic",
      avatar: "CA",
      objective: "反脆弱",
      charter:
        "我负责唱反调。我找失败路径、隐藏成本和沉没成本；我只在关键时刻出现。",
      model: "auto",
      status: "active",
      autonomyLevel: 1,
      trustScore: 70,
      lifecycleStage: "active",
      tools: ["read_plan", "read_evidence"],
      memoryScope: ["plans", "evidence"],
      budgetCents: 500,
      spentCents: 0,
      successCount: 5,
      failCount: 1,
    },
  ]);

  await db.execute(
    sql`UPDATE agents SET budget_period_start = ${weekStart.toISOString()} WHERE user_id = ${USER_ID}`,
  );

  await db.insert(agentGrants).values([
    {
      id: "grt_chief",
      agentId: "ag_chief",
      resource: "plan",
      scope: "write",
      config: { approvalRequired: ["external_action", "spend"] },
    },
    {
      id: "grt_research",
      agentId: "ag_research",
      resource: "web",
      scope: "read",
      config: { requireCitation: true },
    },
    {
      id: "grt_coach",
      agentId: "ag_coach",
      resource: "calendar",
      scope: "write",
      config: { writeRequiresApproval: true },
    },
    {
      id: "grt_coach_task",
      agentId: "ag_coach",
      resource: "task",
      scope: "write",
      config: {},
    },
    {
      id: "grt_coach_notes",
      agentId: "ag_coach",
      resource: "notes",
      scope: "read",
      config: {},
    },
    {
      id: "grt_apprentice_task",
      agentId: "ag_apprentice",
      resource: "task",
      scope: "read",
      config: {},
    },
    {
      id: "grt_critic_plan",
      agentId: "ag_critic",
      resource: "plan",
      scope: "read",
      config: {},
    },
    {
      id: "grt_chief_task",
      agentId: "ag_chief",
      resource: "task",
      scope: "write",
      config: {},
    },
    {
      id: "grt_research_task",
      agentId: "ag_research",
      resource: "task",
      scope: "write",
      config: {},
    },
    {
      id: "grt_treasurer_task",
      agentId: "ag_treasurer",
      resource: "task",
      scope: "write",
      config: {},
    },
    {
      id: "grt_treasurer",
      agentId: "ag_treasurer",
      resource: "ledger",
      scope: "read",
      config: { vetoThresholdCents: 20000 },
    },
    {
      id: "grt_auditor",
      agentId: "ag_auditor",
      resource: "artifacts",
      scope: "read",
      config: { binding: true },
    },
  ]);
}

/** 目标与任务。任务是这条链的主角：状态、风险、审批阈值都取自真实取值，不是占位符。 */
async function seedGoalsAndTasks(): Promise<void> {
  await db.insert(goals).values([
    {
      id: "goal_rag",
      userId: USER_ID,
      domain: "learning",
      title: "6 周学会 RAG",
      why: "能独立做一个可用的 RAG demo",
      target: "完成一个可检索、可评估、可部署的 RAG 项目",
      horizon: "6 weeks",
      status: "active",
      // 进度由 seedLearningProgress() 按公式算出来，这里不写死。
    },
    {
      id: "goal_fitness",
      userId: USER_ID,
      domain: "health",
      title: "每周 3 次运动",
      why: "久坐 + 睡眠差",
      target: "连续 4 周，每周 3 次 25 分钟运动",
      horizon: "4 weeks",
      status: "active",
      progress: 60,
    },
  ]);

  await db.insert(tasks).values([
    {
      id: "tsk_plan",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "拆解 RAG 六周学习路径",
      description: "把目标拆成每周可执行的任务，每个任务 25–45 分钟。",
      assigneeId: "ag_chief",
      auditorId: "ag_auditor",
      status: "done",
      priority: 1,
      dueAt: at(-1, 18, 0),
      acceptanceCriteria: "包含 6 周计划、每周目标、验收标准；总时长不超过 90 分钟/天。",
      estimateMin: 30,
      acceptedAt: at(-1, 18, 10),
      acceptedAutonomyLevel: 2,
      createdBy: "user",
    },
    {
      id: "tsk_research",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "整理 RAG 三大范式资料",
      description: "检索、增强、生成三类范式，各给 1 个例子和 1 个来源。",
      assigneeId: "ag_research",
      auditorId: "ag_auditor",
      status: "accepted",
      priority: 1,
      dueAt: at(-1, 12, 0),
      acceptanceCriteria: "每个范式有定义、例子、来源链接；不得编造引用。",
      estimateMin: 25,
      acceptedAt: at(-1, 12, 10),
      acceptedAutonomyLevel: 2,
      createdBy: "agent",
    },
    {
      id: "tsk_quiz",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "设计检索评估练习（含评分标准）",
      description: "设计 5 道题，覆盖 recall、precision、rerank。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "submitted",
      priority: 1,
      dueAt: at(0, 18, 0),
      acceptanceCriteria: "5 道题；每题有参考答案；必须包含评分标准（rubric）。",
      acceptanceChecklist: [
        { type: "section", value: "评分标准", required: true },
        { type: "min_words", value: 50, required: true },
      ],
      estimateMin: 30,
      template: "learning",
      createdBy: "agent",
    },
    {
      id: "tsk_budget",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "审核本周学习预算",
      description: "检查本周课程、资料、工具支出是否超预算。",
      assigneeId: "ag_treasurer",
      auditorId: "ag_auditor",
      status: "planned",
      priority: 2,
      dueAt: at(1, 10, 0),
      acceptanceCriteria: "列出本周支出、剩余预算、超支项与否决建议。",
      estimateMin: 15,
      createdBy: "agent",
    },
    {
      id: "tsk_booking",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "预约周三 20:00 口语陪练",
      description: "外部动作：需要用户批准后才能预约。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "awaiting_approval",
      priority: 2,
      dueAt: at(1, 20, 0),
      acceptanceCriteria: "确认时间、费用、取消政策；保留确认截图。",
      estimateMin: 10,
      createdBy: "agent",
    },
    {
      id: "tsk_exercise",
      userId: USER_ID,
      goalId: "goal_fitness",
      title: "运动：午休快走 25 分钟",
      description: "从 20:00 移到 12:30，降低启动成本。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "planned",
      priority: 1,
      dueAt: at(0, 12, 30),
      acceptanceCriteria: "25 分钟；心率截图或手动打卡；不得用散步代替。",
      estimateMin: 25,
      createdBy: "agent",
    },
    {
      id: "tsk_read",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "阅读 RAG 检索章节 45 分钟",
      description: "先看例子，再看定义；结束后写 3 行笔记。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "planned",
      priority: 1,
      dueAt: at(0, 21, 0),
      acceptanceCriteria: "45 分钟专注；3 行笔记；至少 1 个自己的例子。",
      estimateMin: 45,
      createdBy: "agent",
    },
    {
      id: "tsk_evening_notes",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "补昨晚的笔记：三个概念各写一句",
      description: "昨晚 21:00 排的活没做完，留到今晚；先把概念写清再补例子。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "planned",
      priority: 2,
      dueAt: at(-1, 21, 0),
      acceptanceCriteria: "三个概念各一句自己的话；不抄原文；能指出各自的反例。",
      estimateMin: 20,
      createdBy: "agent",
    },
    {
      id: "tsk_arch_1",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "搭建 RAG 最小索引",
      description: "用 20 篇文档跑通检索，记录 top-5 与延迟。",
      assigneeId: "ag_research",
      auditorId: "ag_auditor",
      status: "accepted",
      priority: 2,
      dueAt: at(-3, 18, 0),
      acceptanceCriteria: "20 篇文档可检索；返回 top-5；有延迟数据。",
      estimateMin: 30,
      acceptedAt: at(-3, 19, 0),
      acceptedAutonomyLevel: 2,
      createdBy: "agent",
    },
    {
      id: "tsk_arch_2",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "读完 retrieval 综述",
      description: "读完综述的检索章节，写 5 行笔记。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      status: "accepted",
      priority: 2,
      dueAt: at(-2, 18, 0),
      acceptanceCriteria: "5 行笔记；至少 2 个引用。",
      estimateMin: 30,
      acceptedAt: at(-2, 19, 0),
      acceptedAutonomyLevel: 2,
      createdBy: "agent",
    },
    {
      id: "tsk_arch_3",
      userId: USER_ID,
      goalId: "goal_rag",
      title: "跑通 BM25 baseline",
      description: "在 20 篇文档上跑 BM25，记录 recall@5。",
      assigneeId: "ag_research",
      auditorId: "ag_auditor",
      status: "accepted",
      priority: 2,
      dueAt: at(-1, 18, 0),
      acceptanceCriteria: "有 baseline 数字；脚本可复现。",
      estimateMin: 30,
      acceptedAt: at(-1, 19, 0),
      acceptedAutonomyLevel: 2,
      createdBy: "agent",
    },
  ]);

  const taskPolicies = [
    {
      id: "tsk_plan",
      actionType: "internal",
      resource: "plan",
      estimatedCostCents: 60,
    },
    {
      id: "tsk_research",
      actionType: "internal_read",
      resource: "web",
      estimatedCostCents: 50,
    },
    {
      id: "tsk_quiz",
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 60,
    },
    {
      id: "tsk_budget",
      actionType: "internal_read",
      resource: "ledger",
      estimatedCostCents: 30,
    },
    {
      id: "tsk_booking",
      actionType: "external",
      resource: "calendar",
      estimatedCostCents: 18000,
      requiresApproval: true,
      approvalThresholdCents: 20000,
      riskLevel: "high",
    },
    {
      id: "tsk_exercise",
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 50,
    },
    {
      id: "tsk_read",
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 50,
    },
  ];

  for (const { id, ...fields } of taskPolicies) {
    await db.update(tasks).set(fields).where(eq(tasks.id, id));
  }
}

/** 已经跑过的运行。step 明细放在 seedRunDetails，因为预算周期要插在两者之间。 */
async function seedRuns(): Promise<void> {
  await db.insert(runs).values([
    {
      id: "run_plan",
      taskId: "tsk_plan",
      agentId: "ag_chief",
      status: "succeeded",
      mode: "demo",
      startedAt: at(-1, 17, 20),
      endedAt: at(-1, 17, 24),
      costCents: RUN_COST_CENTS.plan,
      tokensIn: 1820,
      tokensOut: 920,
      runLabel: "replay_plan_v1",
    },
    {
      id: "run_research",
      taskId: "tsk_research",
      agentId: "ag_research",
      status: "succeeded",
      mode: "demo",
      startedAt: at(-1, 11, 10),
      endedAt: at(-1, 11, 16),
      costCents: RUN_COST_CENTS.research,
      tokensIn: 2400,
      tokensOut: 1300,
      runLabel: "replay_research_v1",
    },
    {
      id: "run_quiz",
      taskId: "tsk_quiz",
      agentId: "ag_coach",
      status: "succeeded",
      mode: "demo",
      startedAt: at(0, 16, 10),
      endedAt: at(0, 16, 14),
      costCents: RUN_COST_CENTS.quiz,
      tokensIn: 1500,
      tokensOut: 800,
      runLabel: "replay_quiz_v1",
    },
  ]);
}

/**
 * 本周预算周期。它是每周花费的权威账本，`runs.cost_cents` 只是遥测。
 *
 * The weekly ledger is the accounting authority for "this week's spend", so the
 * seeded runs need a matching period row per Agent or the demo would report
 * ¥0.00 while showing paid runs. `limitCents` mirrors `agents.budget_cents`
 * (all three are below the policy weekly ceiling, so the per-Agent cap wins)
 * and nothing is in flight, so `reserved_cents` stays 0 while every finished
 * run is settled — the sums never exceed the Agent's limit.
 */
async function seedBudgetPeriods(weekStart: Date): Promise<void> {
  const weekPeriodEnd = addLocalDays(weekStart, 7, DEMO_TIMEZONE);
  await db.insert(agentBudgetPeriods).values([
    {
      id: `bpd_ag_chief_${weekStart.getTime()}`,
      userId: USER_ID,
      agentId: "ag_chief",
      timezone: DEMO_TIMEZONE,
      periodStart: weekStart,
      periodEnd: weekPeriodEnd,
      limitCents: 3000,
      reservedCents: 0,
      settledCents: RUN_COST_CENTS.plan,
      unknownCents: 0,
    },
    {
      id: `bpd_ag_research_${weekStart.getTime()}`,
      userId: USER_ID,
      agentId: "ag_research",
      timezone: DEMO_TIMEZONE,
      periodStart: weekStart,
      periodEnd: weekPeriodEnd,
      limitCents: 800,
      reservedCents: 0,
      settledCents: RUN_COST_CENTS.research,
      unknownCents: 0,
    },
    {
      id: `bpd_ag_coach_${weekStart.getTime()}`,
      userId: USER_ID,
      agentId: "ag_coach",
      timezone: DEMO_TIMEZONE,
      periodStart: weekStart,
      periodEnd: weekPeriodEnd,
      limitCents: 1200,
      reservedCents: 0,
      settledCents: RUN_COST_CENTS.quiz,
      unknownCents: 0,
    },
  ]);
}

/** 运行的步骤与产物。页面上看到的执行记录就是这些行，不是重新执行出来的。 */
async function seedRunDetails(): Promise<void> {
  await db.insert(steps).values([
    {
      id: "stp_plan_1",
      runId: "run_plan",
      idx: 1,
      type: "context",
      input: { memories: 4, goal: "goal_rag" },
      output: { loaded: ["goal", "constraints", "memories"] },
      tokensIn: 300,
      tokensOut: 0,
      latencyMs: 120,
    },
    {
      id: "stp_plan_2",
      runId: "run_plan",
      idx: 2,
      type: "plan",
      input: { weeks: 6 },
      output: {
        outline: ["检索基础", "chunking", "embedding", "rerank", "评估", "部署"],
      },
      tokensIn: 700,
      tokensOut: 380,
      latencyMs: 900,
    },
    {
      id: "stp_plan_3",
      runId: "run_plan",
      idx: 3,
      type: "tool",
      tool: "read_notes",
      input: { query: "可用时间" },
      output: { hit: "工作日 90 分钟，午休 25 分钟" },
      tokensIn: 120,
      tokensOut: 60,
      latencyMs: 80,
    },
    {
      id: "stp_plan_4",
      runId: "run_plan",
      idx: 4,
      type: "draft",
      input: { format: "markdown" },
      output: { artifact: "art_plan" },
      tokensIn: 400,
      tokensOut: 420,
      latencyMs: 1100,
    },
    {
      id: "stp_plan_5",
      runId: "run_plan",
      idx: 5,
      type: "submit",
      input: { auditor: "ag_auditor" },
      output: { status: "accepted" },
      tokensIn: 40,
      tokensOut: 20,
      latencyMs: 60,
    },
    {
      id: "stp_res_1",
      runId: "run_research",
      idx: 1,
      type: "context",
      input: { memories: 2 },
      output: { loaded: ["learning_state"] },
      tokensIn: 200,
      tokensOut: 0,
      latencyMs: 90,
    },
    {
      id: "stp_res_2",
      runId: "run_research",
      idx: 2,
      type: "tool",
      tool: "web_search",
      input: { query: "RAG retrieval augmented generation survey" },
      output: {
        results: 3,
        top: "arxiv.org/abs/2312.10997",
      },
      tokensIn: 300,
      tokensOut: 120,
      latencyMs: 1400,
    },
    {
      id: "stp_res_3",
      runId: "run_research",
      idx: 3,
      type: "tool",
      tool: "web_fetch",
      input: { url: "https://arxiv.org/abs/2312.10997" },
      output: { title: "Retrieval-Augmented Generation for LLMs: A Survey" },
      tokensIn: 900,
      tokensOut: 200,
      latencyMs: 1600,
    },
    {
      id: "stp_res_4",
      runId: "run_research",
      idx: 4,
      type: "draft",
      input: { format: "markdown" },
      output: { artifact: "art_research" },
      tokensIn: 500,
      tokensOut: 600,
      latencyMs: 1200,
    },
    {
      id: "stp_res_5",
      runId: "run_research",
      idx: 5,
      type: "submit",
      input: { auditor: "ag_auditor" },
      output: { status: "accepted" },
      tokensIn: 40,
      tokensOut: 20,
      latencyMs: 50,
    },
    {
      id: "stp_quiz_1",
      runId: "run_quiz",
      idx: 1,
      type: "context",
      input: { memories: 3 },
      output: { loaded: ["learning_state", "error_patterns"] },
      tokensIn: 220,
      tokensOut: 0,
      latencyMs: 80,
    },
    {
      id: "stp_quiz_2",
      runId: "run_quiz",
      idx: 2,
      type: "plan",
      input: { questions: 5 },
      output: { coverage: ["recall", "precision", "rerank"] },
      tokensIn: 300,
      tokensOut: 120,
      latencyMs: 500,
    },
    {
      id: "stp_quiz_3",
      runId: "run_quiz",
      idx: 3,
      type: "draft",
      input: { format: "markdown" },
      output: { artifact: "art_quiz" },
      tokensIn: 600,
      tokensOut: 700,
      latencyMs: 1300,
    },
    {
      id: "stp_quiz_4",
      runId: "run_quiz",
      idx: 4,
      type: "submit",
      input: { auditor: "ag_auditor" },
      output: { status: "submitted", note: "等待 Auditor 验收" },
      tokensIn: 40,
      tokensOut: 20,
      latencyMs: 50,
    },
  ]);

  await db.insert(artifacts).values([
    {
      id: "art_plan",
      runId: "run_plan",
      taskId: "tsk_plan",
      type: "markdown",
      title: "六周 RAG 学习路径",
      content: `# 六周 RAG 学习路径

## 目标
6 周后能独立完成一个可检索、可评估、可部署的 RAG demo。

## 每周安排
1. **检索基础**：BM25 / dense retrieval / hybrid
2. **Chunking**：固定窗口 vs 语义切分
3. **Embedding**：模型选择与维度、归一化
4. **Rerank**：cross-encoder、延迟与成本
5. **评估**：recall@k、precision、faithfulness
6. **部署**：索引、缓存、监控

## 每日约束
- 工作日最多 90 分钟
- 单任务 25–45 分钟
- 晚上 20:00 后不安排学习任务`,
    },
    {
      id: "art_research",
      runId: "run_research",
      taskId: "tsk_research",
      type: "markdown",
      title: "RAG 三大范式速览",
      content: `# RAG 三大范式速览

## 1. 检索（Retrieval）
从外部知识库召回相关片段。核心指标：recall@k、延迟。
例子：BM25 召回 top-20，再用 dense 检索补召回。
来源：https://arxiv.org/abs/2312.10997

## 2. 增强（Augmentation）
把召回内容压缩、重排、注入上下文。核心问题：上下文窗口与噪声。
例子：先 rerank，再取 top-5 注入。
来源：https://arxiv.org/abs/2312.10997

## 3. 生成（Generation）
基于增强后的上下文生成答案，并用引用约束幻觉。
例子：要求模型逐句引用来源，缺失则拒答。
来源：https://arxiv.org/abs/2312.10997`,
    },
    {
      id: "art_quiz",
      runId: "run_quiz",
      taskId: "tsk_quiz",
      type: "markdown",
      title: "检索评估练习 v1",
      content: `# 检索评估练习 v1

1. 什么是 recall@k？请用一个例子说明。
2. precision 和 recall 在 RAG 里如何权衡？
3. rerank 解决什么问题？代价是什么？
4. 如何构造一个 20 条问题的评估集？
5. 如果模型答对了但引用错了，算不算成功？

## 参考答案
（略）

> 备注：本版本尚未附评分标准。`,
    },
  ]);
}

/** 记忆、洞察、周复盘。复盘的 metrics 是生成当时的快照，和实时重算的数字不一致是有意的。 */
async function seedMemoryLayer(now: Date): Promise<void> {
  await db.insert(memories).values([
    {
      id: "mem_evening",
      userId: USER_ID,
      agentId: "ag_coach",
      type: "semantic",
      domain: "health",
      content: "晚上 20:00 后精力低；运动任务连续 3 次被跳过。",
      confidence: 0.86,
      salience: 0.92,
      evidence: [
        {
          label: "10/14 运动任务跳过",
          ref: "tsk_exercise",
          quote: "计划 20:00，实际未开始",
        },
        {
          label: "10/16 运动任务跳过",
          ref: "chk_1016",
          quote: "晚上太累",
        },
        {
          label: "10/19 运动任务跳过",
          ref: "chk_1019",
          quote: "加班到 21:00",
        },
      ],
      sourceEventId: "chk_1019",
      lastConfirmedAt: at(-1, 22, 10),
    },
    {
      id: "mem_examples",
      userId: USER_ID,
      agentId: "ag_coach",
      type: "semantic",
      domain: "learning",
      content: "讲解时先给具体例子，再给定义，吸收更好。",
      confidence: 0.9,
      salience: 0.85,
      evidence: [
        {
          label: "10/12 反馈",
          ref: "chk_1012",
          quote: "定义太抽象，先举个例子",
        },
        {
          label: "10/17 反馈",
          ref: "chk_1017",
          quote: "有例子好懂多了",
        },
      ],
      sourceEventId: "chk_1017",
      lastConfirmedAt: at(-2, 21, 0),
    },
    {
      id: "mem_time",
      userId: USER_ID,
      agentId: "ag_chief",
      type: "semantic",
      domain: "learning",
      content: "工作日每天可用学习时间约 90 分钟；午休 25 分钟最稳定。",
      confidence: 0.8,
      salience: 0.7,
      evidence: [
        { label: "日历统计", ref: "calendar", quote: "工作日 12:30–13:00 空闲" },
      ],
      sourceEventId: "calendar_analysis",
      lastConfirmedAt: at(-3, 10, 0),
    },
    {
      id: "mem_meeting",
      userId: USER_ID,
      agentId: "ag_chief",
      type: "semantic",
      domain: "calendar",
      content: "周三 19:30–21:00 有固定会议，不能安排学习或运动。",
      confidence: 0.95,
      salience: 0.8,
      evidence: [
        { label: "日历", ref: "calendar", quote: "每周三 19:30 团队同步" },
      ],
      sourceEventId: "calendar_sync",
      lastConfirmedAt: at(-7, 9, 0),
    },
    {
      id: "mem_rerank",
      userId: USER_ID,
      agentId: "ag_coach",
      type: "semantic",
      domain: "learning",
      content: "rerank 概念仍不熟，需要具体例子和对比实验。",
      confidence: 0.7,
      salience: 0.75,
      evidence: [
        { label: "练习结果", ref: "tsk_quiz", quote: "第 3 题未作答" },
      ],
      sourceEventId: "quiz_attempt_1",
      lastConfirmedAt: at(0, 16, 20),
    },
    {
      id: "mem_skip",
      userId: USER_ID,
      agentId: "ag_coach",
      type: "episodic",
      domain: "health",
      content: "昨天运动未完成，备注：晚上太累。",
      confidence: 0.95,
      salience: 0.6,
      evidence: [{ label: "昨日 check-in", ref: "chk_yesterday" }],
      sourceEventId: "chk_yesterday",
      lastConfirmedAt: at(-1, 22, 0),
    },
    {
      id: "mem_conflict",
      userId: USER_ID,
      agentId: "ag_chief",
      type: "semantic",
      domain: "learning",
      content: "你偏好晚上 20:00 后学习。",
      confidence: 0.42,
      salience: 0.4,
      evidence: [
        {
          label: "10/10 自述",
          ref: "chk_1010",
          quote: "晚上安静，适合学习",
        },
      ],
      sourceEventId: "chk_1010",
      lastConfirmedAt: at(-12, 22, 0),
      status: "conflicted",
    },
    {
      id: "mem_precedent_membership",
      userId: USER_ID,
      agentId: "ag_treasurer",
      type: "procedural",
      domain: "council",
      content:
        "判例（年包会员）：预算压力下的年包购买应被否决；先按月验证完课率。",
      factKey: "precedent:年包会员",
      value: "vindicated:52000",
      validFrom: at(-2, 9),
      confidence: 0.9,
      salience: 0.9,
      evidence: [
        {
          label: "判例",
          ref: "dissent:dis_seed_membership",
          quote: "预算执行超过阈值",
        },
      ],
      sourceEventId: "dis_seed_membership",
      lastConfirmedAt: at(-2, 9),
      status: "active",
    },
  ]);

  await db.insert(insights).values([
    {
      id: "ins_morning",
      userId: USER_ID,
      claim: "把运动从 20:00 移到午休 12:30，单次 25 分钟，依从性更高。",
      rationale:
        "连续 3 次晚间运动被跳过；午休时段的轻量任务完成率约 80%。这不是意志力问题，是时段问题。",
      confidence: 0.82,
      evidence: [
        { label: "3 次晚间跳过", ref: "mem_evening", quote: "20:00 后精力低" },
        { label: "午休完成率 80%", ref: "calendar_analysis", quote: "12:30–13:00 空闲" },
      ],
      proposedChange: {
        type: "reschedule",
        taskId: "tsk_exercise",
        from: "20:00",
        to: "12:30",
      },
      beforeState: { dueAt: at(0, 20, 0).toISOString() },
      afterState: { dueAt: at(0, 12, 30).toISOString() },
      status: "applied",
      decidedAt: at(-1, 22, 30),
    },
    {
      id: "ins_split",
      userId: USER_ID,
      claim: "把 45 分钟的 RAG 阅读拆成 25 分钟一段，先例子后定义。",
      rationale:
        "过去两周 45 分钟任务完成率 40%，25 分钟任务完成率 78%。任务粒度是主要变量。",
      confidence: 0.76,
      evidence: [
        { label: "45 分钟完成率", ref: "tasks_history", quote: "2/5" },
        { label: "25 分钟完成率", ref: "tasks_history", quote: "7/9" },
      ],
      proposedChange: { type: "split_task", taskId: "tsk_read", minutes: 25 },
      status: "proposed",
    },
    {
      id: "ins_rule",
      userId: USER_ID,
      claim: "讲解规则：先给一个具体例子，再给定义。",
      rationale: "你在 3 次反馈中都要求例子；例子型材料的完成率更高。",
      confidence: 0.88,
      evidence: [
        { label: "反馈 1", ref: "mem_examples", quote: "定义太抽象" },
        { label: "反馈 2", ref: "mem_examples", quote: "有例子好懂多了" },
      ],
      proposedChange: { type: "add_rule", rule: "讲解先给例子，再给定义" },
      beforeState: { rules: [] },
      afterState: { rules: ["讲解先给例子，再给定义"] },
      status: "applied",
      decidedAt: at(-2, 21, 30),
    },
  ]);

  await db.insert(reviews).values([
    {
      id: "rev_week",
      userId: USER_ID,
      period: weekLabel(now),
      type: "weekly",
      narrative: `# 第 2 周复盘

## 发生了什么
- 完成 5 个被接受的结果（AAO = 5），比上周多 2 个。
- 运动从晚上移到午休后，完成率明显上升。
- RAG 学习推进到「检索基础」，rerank 仍是薄弱点。

## 什么有效
- 25 分钟任务粒度。
- 先例子后定义。
- 运动放在午休，而不是晚上。

## 什么无效
- 周三晚上安排学习：固定会议后没有精力。
- 一次性给 5 道题：你只做了 3 道。

## 下周改什么
- 周三不排学习任务。
- 练习题拆成 2 次，每次 3 道。
- 给 rerank 补一个对比实验。`,
      metrics: {
        aao: 5,
        adherence: 63,
        managementMin: 2.8,
        costCents: WEEK_RUN_SPEND_CENTS,
        goalProgress: 38,
        auditRejectRate: 17,
      },
      decisions: [
        { action: "reschedule", target: "tsk_exercise", result: "12:30" },
        { action: "add_rule", target: "coach", result: "先例子后定义" },
      ],
      createdAt: at(-1, 21, 0),
    },
    {
      id: "rev_daily",
      userId: USER_ID,
      period: day(0),
      type: "daily",
      narrative:
        "今天 3 件事：检索练习、午休快走、RAG 阅读。另有 2 件在队列。1 个任务等你验收，1 个外部动作等你批准。",
      metrics: { tasks: 3, decisions: 2 },
      decisions: [],
      createdAt: at(0, 8, 30),
    },
  ]);
}

/** 审批、审计链、技能。审计事件按顺序算出 prev/hash，链式校验才有东西可验。 */
async function seedGovernance(): Promise<void> {
  await db.insert(approvals).values([
    {
      id: "appr_booking",
      userId: USER_ID,
      taskId: "tsk_booking",
      action: "book_session",
      payload: {
        provider: "italki",
        time: "周三 20:00",
        costCents: 18000,
        note: "外部动作：预约并支付，需要你批准",
      },
      status: "pending",
      expiresAt: at(1, 12, 0),
    },
  ]);

  const auditSeeds = [
    {
      id: "aud_seed_1",
      actor: "agent:ag_auditor",
      action: "audit.accept",
      target: "tsk_research",
      before: { status: "submitted" },
      after: {
        status: "accepted",
        reason: "来源齐全，定义、例子、链接完整。",
      },
      createdAt: at(-1, 12, 10),
    },
    {
      id: "aud_seed_2",
      actor: "agent:ag_chief",
      action: "task.dispatch",
      target: "tsk_research",
      before: { assignee: null },
      after: { assignee: "ag_research" },
      createdAt: at(-1, 11, 0),
    },
    {
      id: "aud_seed_4",
      actor: "agent:ag_coach",
      action: "task.submit",
      target: "tsk_quiz",
      before: { status: "running" },
      after: { status: "submitted" },
      createdAt: at(0, 16, 10),
    },
    {
      id: "aud_seed_5",
      actor: "agent:ag_auditor",
      action: "audit.accept",
      target: "tsk_plan",
      before: { status: "auditing" },
      after: { status: "accepted", reason: "路径完整，符合约束。" },
      createdAt: at(-1, 18, 10),
    },
    {
      id: "aud_seed_6",
      actor: "agent:ag_auditor",
      action: "audit.reject",
      target: "tsk_arch_2",
      before: { status: "submitted" },
      after: { status: "rejected", reason: "引用缺失。" },
      createdAt: at(-2, 17, 0),
    },
    {
      id: "aud_seed_7",
      actor: "agent:ag_auditor",
      action: "audit.accept",
      target: "tsk_arch_2",
      before: { status: "submitted" },
      after: { status: "accepted", reason: "引用已补齐。" },
      createdAt: at(-2, 18, 0),
    },
    {
      id: "aud_seed_8",
      actor: "agent:ag_auditor",
      action: "audit.accept",
      target: "tsk_arch_1",
      before: { status: "submitted" },
      after: { status: "accepted" },
      createdAt: at(-3, 19, 10),
    },
    {
      id: "aud_seed_9",
      actor: "agent:ag_auditor",
      action: "audit.accept",
      target: "tsk_arch_3",
      before: { status: "submitted" },
      after: { status: "accepted" },
      createdAt: at(-1, 19, 10),
    },
    {
      id: "aud_seed_3",
      actor: "user",
      action: "autonomy.approve",
      target: "ag_chief",
      before: { level: 1 },
      after: { level: 2 },
      createdAt: at(-2, 20, 0),
    },
  ];

  let prev: string | null = null;
  for (const e of auditSeeds) {
    const hash = sha256(
      [
        prev ?? "genesis",
        e.actor,
        e.action,
        e.target,
        canonicalJson(e.before),
        canonicalJson(e.after),
        e.createdAt.toISOString(),
      ].join("|"),
    );
    await db.insert(auditEvents).values({
      id: e.id,
      userId: USER_ID,
      actor: e.actor,
      action: e.action,
      target: e.target,
      before: e.before,
      after: e.after,
      hash,
      prevHash: prev,
      createdAt: e.createdAt,
    });
    prev = hash;
  }

  await db.insert(skills).values([
    {
      id: "sk_apprentice",
      agentId: "ag_apprentice",
      name: "检索评估练习设计",
      version: 1,
      steps: [
        "读取 mentor 的 5 次成功运行",
        "提取题目结构：定义题 / 对比题 / 场景题",
        "为每题生成参考答案",
        "生成评分标准（rubric）",
        "自检：是否覆盖 recall / precision / rerank",
      ],
      tools: ["read_runs", "sandbox_execute"],
      status: "draft",
      label: "draft",
      evalSet: [
        { type: "section", value: "步骤", required: true },
        { type: "section", value: "护栏", required: true },
        { type: "contains", value: "评分标准", required: true },
        { type: "contains", value: "recall", required: true },
        { type: "min_words", value: 20, required: true },
      ],
      successCount: 0,
      failCount: 0,
      eval: { status: "not_started", required: 5, passed: 0 },
    },
  ]);
}

/** 内阁：会议、各方立场、以及一条被验证的反对意见。 */
async function seedCouncil(): Promise<void> {
  await db.insert(councils).values([
    {
      id: "ccl_course",
      userId: USER_ID,
      topic: "要不要买 ¥599 的 RAG 实战课？",
      trigger: "单笔支出 > ¥200",
      status: "open",
      memo: `## 结论
先买 1 个月试学（¥199），不买年包。

## 理由
- 课程内容匹配当前阶段，但节奏偏快。
- 本月学习预算只剩 ¥320，年包会超支。
- 过去 3 次买课都没学完，先验证完课率。

## 异议
Critic 认为免费资料已足够，建议先完成现有材料。

## 需要你决定
批准 ¥199 试学 / 否决 / 改条件。`,
      matrix: {
        dimensions: {
          feasibility: 55,
          costEfficiency: 35,
          evidenceQuality: 60,
          robustness: 40,
        },
        overall: 48,
        support: 1,
        oppose: 2,
        neutral: 2,
        consensus: "oppose",
        dissentAgentIds: ["ag_treasurer", "ag_critic"],
      },
      createdAt: at(0, 9, 10),
    },
    {
      id: "ccl_membership",
      userId: USER_ID,
      topic: "要不要买 ¥899 年包会员？",
      trigger: "单笔支出 > ¥500",
      status: "decided",
      memo: `## 决定
否决年包，先按月购买。

## 理由
- 年包会占用三个月学习预算。
- 过去 3 次买课完课率为 0。
- 先验证一个月完课率，再决定是否升级。`,
      matrix: {
        dimensions: {
          feasibility: 45,
          costEfficiency: 20,
          evidenceQuality: 60,
          robustness: 35,
        },
        overall: 39,
        support: 1,
        oppose: 2,
        neutral: 2,
        consensus: "oppose",
        dissentAgentIds: ["ag_treasurer", "ag_critic"],
      },
      resolution: {
        decision: "reject",
        note: "年包会挤压预算，先验证完课率。",
        taskId: null,
        memoryId: "mem_precedent_membership",
        dissents: [
          {
            agentId: "ag_treasurer",
            claim: "年包会占用三个月学习预算。",
            risk: "超支会挤压后续实验。",
            recommendation: "先按月购买。",
          },
        ],
        decidedAt: at(-8, 10).toISOString(),
      },
      resolutionAppliedAt: at(-8, 10),
      createdAt: at(-9, 9),
      decidedAt: at(-8, 10),
    },
  ]);

  await db.insert(councilPositions).values([
    {
      id: "cps_research",
      councilId: "ccl_course",
      agentId: "ag_research",
      stance: "neutral",
      claim: "课程评价 4.6，但完课率只有 18%。",
      evidence: [
        { label: "课程页", ref: "web:course", quote: "4.6 / 5，1,204 评价" },
        { label: "完课率", ref: "web:course", quote: "18% completion" },
      ],
      risk: "评价高不代表适合你；完课率低是信号。",
      recommendation: "先买 1 个月试学。",
      scores: {
        feasibility: 60,
        costEfficiency: 55,
        evidenceQuality: 80,
        robustness: 55,
      },
      isDissent: false,
    },
    {
      id: "cps_coach",
      councilId: "ccl_course",
      agentId: "ag_coach",
      stance: "support",
      claim: "内容匹配你当前阶段，但节奏偏快。",
      evidence: [
        // 这里以前引的是「当前进度 38%」——那个数字是写死的，和种子目标按公式
        // 算出的进度对不上，等于让演示数据自己反驳自己。改成引真实存在的自测记录。
        { label: "昨天的自测", ref: "chk_yesterday", quote: "回忆分 0.4，rerank 还不熟" },
      ],
      risk: "直接上年包可能跟不上，反而打击信心。",
      recommendation: "试学 + 每周 2 次 25 分钟。",
      scores: {
        feasibility: 72,
        costEfficiency: 55,
        evidenceQuality: 55,
        robustness: 68,
      },
      isDissent: false,
    },
    {
      id: "cps_treasurer",
      councilId: "ccl_course",
      agentId: "ag_treasurer",
      stance: "oppose",
      claim: "本月学习预算只剩 ¥320，年包 ¥599 会超支。",
      evidence: [
        { label: "预算", ref: "profile", quote: "monthlyLearningBudgetCents: 60000" },
        { label: "已支出", ref: "ledger", quote: "¥280" },
      ],
      risk: "超支会挤压下个月的资料和工具预算。",
      recommendation: "只批准 ¥199 试学。",
      scores: {
        feasibility: 55,
        costEfficiency: 20,
        evidenceQuality: 70,
        robustness: 45,
      },
      isDissent: true,
      falsificationCondition: {
        metric: "budget_spend_cents",
        operator: ">=",
        threshold: 48000,
        windowDays: 7,
      },
    },
    {
      id: "cps_critic",
      councilId: "ccl_course",
      agentId: "ag_critic",
      stance: "oppose",
      claim: "你过去 3 次买课都没学完，先完成免费资料。",
      evidence: [
        { label: "历史", ref: "purchase_history", quote: "3 门课，完课 0" },
      ],
      risk: "买课是缓解焦虑，不是解决问题。",
      recommendation: "先完成现有材料 2 周，再决定。",
      scores: {
        feasibility: 38,
        costEfficiency: 45,
        evidenceQuality: 60,
        robustness: 35,
      },
      isDissent: true,
      falsificationCondition: {
        metric: "audit_reject_count",
        operator: ">=",
        threshold: 2,
        windowDays: 7,
      },
    },
    {
      id: "cps_auditor",
      councilId: "ccl_course",
      agentId: "ag_auditor",
      stance: "neutral",
      claim: "退款政策 7 天，需保留证据。",
      evidence: [
        { label: "退款政策", ref: "web:course", quote: "7-day refund" },
      ],
      risk: "超过 7 天无法退款。",
      recommendation: "若购买，设置第 6 天提醒。",
      scores: {
        feasibility: 60,
        costEfficiency: 60,
        evidenceQuality: 50,
        robustness: 50,
      },
      isDissent: false,
    },
  ]);

  await db.insert(dissents).values([
    {
      id: "dis_seed_membership",
      userId: USER_ID,
      councilId: "ccl_membership",
      taskId: null,
      agentId: "ag_treasurer",
      warning: "年包会占用三个月学习预算，且过去完课率低。",
      condition: {
        metric: "budget_spend_cents",
        operator: ">=",
        threshold: 48000,
        windowDays: 7,
      },
      status: "vindicated",
      evidence: [
        {
          label: "预算执行",
          ref: "agent:ag_treasurer",
          quote: "年包 ¥899 > 可用预算",
        },
        {
          label: "复盘测量",
          ref: "dissent:dis_seed_membership",
          quote: "budget_spend_cents = 52000",
        },
      ],
      evaluatedAt: at(-2, 9),
      createdAt: at(-9, 10),
    },
  ]);
}

/** 用户行为样本与打卡。有这些行管理时间才是测得而不是估算——只在跑了 seed 的工作区成立。 */
async function seedSamples(): Promise<void> {
  await db.insert(userActions).values([
    {
      id: "ua_seed_1",
      userId: USER_ID,
      action: "approval.decide",
      durationMs: 60000,
      createdAt: at(-1, 20, 0),
    },
    {
      id: "ua_seed_2",
      userId: USER_ID,
      action: "insight.accept",
      durationMs: 60000,
      createdAt: at(-1, 21, 0),
    },
    {
      id: "ua_seed_3",
      userId: USER_ID,
      action: "checkin",
      durationMs: 48000,
      createdAt: at(-1, 22, 0),
    },
  ]);

  await db.insert(checkins).values([
    {
      id: "chk_yesterday",
      userId: USER_ID,
      date: day(-1),
      energy: 3,
      mood: 4,
      completed: [
        { taskId: "tsk_read", done: true },
        { taskId: "tsk_exercise", done: false },
      ],
      note: "晚上太累，运动没做。",
      studyMinutes: 40,
      recallScore: 0.4,
      errorTags: ["rerank"],
      createdAt: at(-1, 22, 0),
    },
  ]);
}

/** 统一标记来源。demo 行不该被当成真实历史，导出与页面都靠这个字段区分。 */
async function markDemoFixtures(): Promise<void> {
  // Demo rows are explicit fixtures, never real user history.
  await db.execute(sql`
    UPDATE runs SET source_type = 'demo_fixture'
    WHERE task_id IN (SELECT id FROM tasks WHERE user_id = ${USER_ID})
  `);
  await db.execute(sql`
    UPDATE artifacts SET source_type = 'demo_fixture'
    WHERE task_id IN (SELECT id FROM tasks WHERE user_id = ${USER_ID})
  `);
  await db.execute(sql`
    UPDATE memories SET source_type = 'demo_fixture'
    WHERE user_id = ${USER_ID}
  `);
}
