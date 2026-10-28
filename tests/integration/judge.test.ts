import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  artifacts,
  auditEvents,
  learningAttempts,
  runs,
  tasks,
} from "@/lib/db/schema";
import type { AcceptanceItem } from "@/lib/db/schema";
import { DEMO_USER_ID } from "@/lib/demo";
import { evaluateAcceptance } from "@/lib/domain/acceptance";
import { auditTask, createTask, runTask } from "@/server/services/engine";
import { getPolicyConfigFor } from "@/lib/policy/config";
import type { JudgeFn } from "@/server/services/commands/tasks/judge";
import { judgeSubmission } from "@/server/services/commands/tasks/judge";
import { resetDb } from "../helpers/db";

const CRITERION = "解释闭包为什么能捕获变量";

const savedKey = process.env.OPENAI_API_KEY;

beforeEach(async () => {
  // tests/setup.ts 本来就不配模型；这里再显式删一次，免得本机 .env 让人误判分支。
  delete process.env.OPENAI_API_KEY;
  await resetDb();
});

afterAll(() => {
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
});

async function setupJudgeTask(): Promise<{
  taskId: string;
  artifactId: string;
  checklist: AcceptanceItem[];
  answer: string;
}> {
  const task = await createTask(
    {
      title: "写一段闭包讲解",
      description: "用自己的话解释闭包，并给一个最小可运行的例子。",
      assigneeId: "ag_coach",
      auditorId: "ag_auditor",
      actionType: "internal",
      resource: "task",
      estimatedCostCents: 0,
      acceptanceCriteria: "讲清闭包能捕获变量的原因。",
      acceptanceChecklist: [
        { type: "judge", value: CRITERION, required: true },
      ],
      estimateMin: 30,
    },
    DEMO_USER_ID,
  );
  await runTask(task.id, DEMO_USER_ID);

  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, task.id))
    .orderBy(desc(artifacts.createdAt))
    .limit(1);

  return {
    taskId: task.id,
    artifactId: artifact.id,
    checklist: task.acceptanceChecklist ?? [],
    answer: artifact.content,
  };
}

function verdictReply(pass: boolean, reason: string): string {
  return JSON.stringify({
    verdicts: [{ criterion: CRITERION, pass, reason }],
  });
}

async function latestAuditEvent(
  taskId: string,
  action: "audit.accept" | "audit.needs_review" = "audit.accept",
) {
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.target, taskId)))
    .orderBy(desc(auditEvents.seq))
    .limit(1);
  return event?.after as
    | {
        status?: string;
        verdict?: string;
        artifactId?: string | null;
        judge?: {
          judgedBy: string | null;
          reason: string;
          model: string | null;
          score: number | null;
        } | null;
      }
    | null;
}

describe("no model configured", () => {
  it("judge 项保持 undetermined，learning_attempts 不写入，但审计行写明为什么", async () => {
    const { taskId, artifactId } = await setupJudgeTask();

    const result = await auditTask(taskId, DEMO_USER_ID);

    // 待判不是失败，但也绝不是通过：没有模型时任务停在 needs_review，
    // 等一个真正给出结论的人。旧断言是 accepted，那正是"没有结论=通过"。
    expect(result.decision).toBe("needs_review");
    expect(result.verdict).toBe("needs_review");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("needs_review");
    // 没有结论就没有"被接受的时间"。
    expect(row.acceptedAt).toBeNull();
    expect(row.acceptanceReport).toHaveLength(1);
    expect(row.acceptanceReport?.[0].item.type).toBe("judge");
    expect(row.acceptanceReport?.[0].passed).toBe(false);
    expect(row.acceptanceReport?.[0].undetermined).toBe(true);
    expect(row.acceptanceReport?.[0].reason).toBe("需要模型判定：" + CRITERION);

    expect(await db.select().from(learningAttempts)).toHaveLength(0);

    // 待判定不能写成 audit.accept：那会让审计日志读起来像"验收通过"。
    expect(await latestAuditEvent(taskId, "audit.accept")).toBeUndefined();
    const after = await latestAuditEvent(taskId, "audit.needs_review");
    expect(after?.verdict).toBe("needs_review");
    // 判卷没有发生，报告必须说清楚是"没有模型"而不是"判过了没通过"。
    expect(after?.judge?.judgedBy).toBeNull();
    expect(after?.judge?.reason).toBe("no_model");
    // 原有字段保持不变，报告仍能回溯到被描述的那份产物。
    expect(after?.artifactId).toBe(artifactId);
  });

  it("没有 judge 项时审计行不新增 judge 字段", async () => {
    const task = await createTask(
      {
        title: "整理本周会议要点",
        description: "把三次会议的要点整理成一页纸。",
        assigneeId: "ag_coach",
        auditorId: "ag_auditor",
        actionType: "internal",
        resource: "task",
        estimatedCostCents: 0,
        acceptanceCriteria: "三条会议要点。",
        acceptanceChecklist: [
          { type: "min_words", value: 5, required: true },
        ],
        estimateMin: 20,
      },
      DEMO_USER_ID,
    );
    await runTask(task.id, DEMO_USER_ID);
    await auditTask(task.id, DEMO_USER_ID);

    const after = await latestAuditEvent(task.id);
    expect(after?.artifactId).toBeTruthy();
    expect(after?.judge).toBeUndefined();
    expect(await db.select().from(learningAttempts)).toHaveLength(0);
  });
});

describe("judgeSubmission", () => {
  it("没有 judge 项时直接返回 no_judge_items", async () => {
    const { taskId, artifactId, answer } = await setupJudgeTask();
    const results = evaluateAcceptance(answer, [
      { type: "min_words", value: 1, required: true },
    ]);

    const outcome = await judgeSubmission({
      userId: DEMO_USER_ID,
      taskId,
      artifactId,
      question: "写一段闭包讲解",
      answer,
      checklist: [{ type: "min_words", value: 1, required: true }],
      results,
    });

    expect(outcome.judged).toBe(false);
    expect(outcome.reason).toBe("no_judge_items");
    expect(outcome.results).toBe(results);
    expect(await db.select().from(learningAttempts)).toHaveLength(0);
  });

  it("没有模型时返回 no_model 且不写库", async () => {
    const { taskId, artifactId, checklist, answer } = await setupJudgeTask();
    const results = evaluateAcceptance(answer, checklist);

    const outcome = await judgeSubmission({
      userId: DEMO_USER_ID,
      taskId,
      artifactId,
      question: "写一段闭包讲解",
      answer,
      checklist,
      results,
    });

    expect(outcome.judged).toBe(false);
    expect(outcome.reason).toBe("no_model");
    expect(outcome.results).toBe(results);
    expect(await db.select().from(learningAttempts)).toHaveLength(0);
  });

  it("注入判卷函数时回填结论并写一条 model 记录", async () => {
    const { taskId, artifactId, checklist, answer } = await setupJudgeTask();
    const results = evaluateAcceptance(answer, checklist);
    const prompts: string[] = [];
    const judge: JudgeFn = async (input) => {
      prompts.push(input.prompt);
      return {
        status: "success",
        text: verdictReply(true, "答案解释了词法环境"),
        model: "fake-judge",
        tokensIn: 120,
        tokensOut: 40,
      };
    };

    const outcome = await judgeSubmission({
      userId: DEMO_USER_ID,
      taskId,
      artifactId,
      question: "写一段闭包讲解",
      answer,
      checklist,
      results,
      judge,
    });

    expect(outcome.judged).toBe(true);
    expect(outcome.reason).toBe("judged");
    expect(outcome.judgeModel).toBe("fake-judge");
    expect(outcome.score).toBe(1);
    expect(outcome.results[0].passed).toBe(true);
    expect(outcome.results[0].undetermined).toBeFalsy();
    // 提示里必须带题目、答案和标准，否则模型是凭空判卷。
    expect(prompts[0]).toContain("写一段闭包讲解");
    expect(prompts[0]).toContain(CRITERION);

    const [attempt] = await db
      .select()
      .from(learningAttempts)
      .where(
        and(
          eq(learningAttempts.userId, DEMO_USER_ID),
          eq(learningAttempts.taskId, taskId),
        ),
      );
    expect(attempt.judgedBy).toBe("model");
    expect(attempt.judgeModel).toBe("fake-judge");
    expect(attempt.artifactId).toBe(artifactId);
    expect(attempt.rubric).toEqual([CRITERION]);
    expect(attempt.answer).toBe(answer);
    expect(attempt.prompt).toBe("写一段闭包讲解");
    expect(attempt.verdicts?.[0].criterion).toBe(CRITERION);
    expect(attempt.score).toBe(1);
    // 判卷本身不替调用方拍板：accepted 先落 false，由 audit 按验收结论更新。
    expect(attempt.accepted).toBe(false);
  });

  it("同一任务重复判卷只更新一行", async () => {
    const { taskId, artifactId, checklist, answer } = await setupJudgeTask();
    const results = evaluateAcceptance(answer, checklist);
    const base = {
      userId: DEMO_USER_ID,
      taskId,
      artifactId,
      answer,
      checklist,
      results,
    };

    await judgeSubmission({
      ...base,
      question: "第一版题目",
      judge: async () => ({
        status: "success",
        text: verdictReply(true, "对"),
        model: "fake-judge",
        tokensIn: 1,
        tokensOut: 1,
      }),
    });
    const second = await judgeSubmission({
      ...base,
      question: "第二版题目",
      judge: async () => ({
        status: "success",
        text: verdictReply(false, "答案没提到词法环境"),
        model: "fake-judge-2",
        tokensIn: 1,
        tokensOut: 1,
      }),
    });

    expect(second.score).toBe(0);
    const rows = await db
      .select()
      .from(learningAttempts)
      .where(eq(learningAttempts.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe("第二版题目");
    expect(rows[0].judgeModel).toBe("fake-judge-2");
    expect(rows[0].score).toBe(0);
  });

  it("模型超时时降级为 undetermined，不抛异常", async () => {
    const { taskId, artifactId, checklist, answer } = await setupJudgeTask();
    const results = evaluateAcceptance(answer, checklist);

    const outcome = await judgeSubmission({
      userId: DEMO_USER_ID,
      taskId,
      artifactId,
      question: "写一段闭包讲解",
      answer,
      checklist,
      results,
      judge: async () => ({
        status: "timeout",
        text: "",
        model: "fake-judge",
        tokensIn: 0,
        tokensOut: 0,
      }),
    });

    expect(outcome.judged).toBe(true);
    expect(outcome.reason).toBe("timeout");
    expect(outcome.results[0].passed).toBe(false);
    expect(outcome.results[0].undetermined).toBe(true);
    expect(outcome.results[0].reason).toContain("判卷未完成");
    // 判卷发生了（只是没结论），行仍记 model：事后能看出这次尝试存在。
    const [attempt] = await db
      .select()
      .from(learningAttempts)
      .where(eq(learningAttempts.taskId, taskId));
    expect(attempt.judgedBy).toBe("model");
    expect(attempt.score).toBe(0);
  });

  it("判卷函数抛异常也不让审计失败", async () => {
    const { taskId, artifactId, checklist, answer } = await setupJudgeTask();
    const results = evaluateAcceptance(answer, checklist);

    const outcome = await judgeSubmission({
      userId: DEMO_USER_ID,
      taskId,
      artifactId,
      question: "写一段闭包讲解",
      answer,
      checklist,
      results,
      judge: async () => {
        throw new Error("network down");
      },
    });

    expect(outcome.judged).toBe(true);
    expect(outcome.reason).toBe("provider_error");
    expect(outcome.results[0].undetermined).toBe(true);
  });
});

describe("audit + judge", () => {
  it("有模型时验收报告带着判卷结论，审计行记为 model", async () => {
    const { taskId, artifactId } = await setupJudgeTask();
    const judge: JudgeFn = async () => ({
      status: "success",
      text: verdictReply(true, "答案解释了词法环境"),
      model: "fake-judge",
      tokensIn: 120,
      tokensOut: 40,
    });

    const result = await auditTask(taskId, DEMO_USER_ID, { judge });

    expect(result.decision).toBe("accepted");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.acceptanceReport?.[0].passed).toBe(true);
    expect(row.acceptanceReport?.[0].undetermined).toBeFalsy();
    expect(row.acceptanceReport?.[0].reason).toContain("词法环境");

    const [attempt] = await db
      .select()
      .from(learningAttempts)
      .where(eq(learningAttempts.taskId, taskId));
    expect(attempt.judgedBy).toBe("model");
    expect(attempt.score).toBe(1);
    // 验收通过后回填，accepted 表示"这份答案被接受了"。
    expect(attempt.accepted).toBe(true);

    const after = await latestAuditEvent(taskId);
    expect(after?.judge?.judgedBy).toBe("model");
    expect(after?.judge?.reason).toBe("judged");
    expect(after?.judge?.model).toBe("fake-judge");
    expect(after?.judge?.score).toBe(1);
    expect(after?.artifactId).toBe(artifactId);
  });

  // 审计 run 原本无条件写「没有供应商参与、没有用量、没有花费」，而判卷那次
  // 调用是真的：用量被丢掉了，页面既印「演示模板」又印「用量未知 · ¥0.00」。
  it("记下判卷那次调用真正用掉的 token 与费用", async () => {
    const { taskId } = await setupJudgeTask();
    const judge: JudgeFn = async () => ({
      status: "success",
      text: verdictReply(true, "答案解释了词法环境"),
      model: "fake-judge",
      tokensIn: 1200,
      tokensOut: 300,
      attemptId: "att_judge",
    });

    await auditTask(taskId, DEMO_USER_ID, { judge });

    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.agentId, "ag_auditor")))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    expect(run.mode).toBe("live");
    expect(run.providerAttemptId).toBe("att_judge");
    expect(run.tokensIn).toBe(1200);
    expect(run.tokensOut).toBe(300);
    expect(run.costSource).toBe("actual");
    // 与生成产物同一条成本公式：两次调用都算钱。
    const config = await getPolicyConfigFor(DEMO_USER_ID);
    expect(run.costCents).toBeCloseTo(
      Number((((1200 + 300) / 1000) * config.cost.centsPer1kTokens).toFixed(2)),
      2,
    );
    expect(run.costCents).toBeGreaterThan(0);
  });

  it("调用过但供应商没报用量时写 unknown，不写 0", async () => {
    const { taskId } = await setupJudgeTask();
    const judge: JudgeFn = async () => ({
      status: "timeout",
      text: "",
      model: "fake-judge",
      tokensIn: 0,
      tokensOut: 0,
      attemptId: "att_judge_timeout",
    });

    await auditTask(taskId, DEMO_USER_ID, { judge });

    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.agentId, "ag_auditor")))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    expect(run.mode).toBe("live");
    // 超时也可能已经花掉钱：留 null + unknown，而不是 actual 0。
    expect(run.tokensIn).toBeNull();
    expect(run.tokensOut).toBeNull();
    expect(run.costSource).toBe("unknown");
    expect(run.costCents).toBe(0);
  });

  it("判卷失败时任务既不驳回也不通过，停在待你判定，但仍留下尝试记录", async () => {
    const { taskId } = await setupJudgeTask();
    const judge: JudgeFn = async () => ({
      status: "provider_error",
      text: "",
      model: "fake-judge",
      tokensIn: 0,
      tokensOut: 0,
    });

    const result = await auditTask(taskId, DEMO_USER_ID, { judge });

    expect(result.decision).toBe("needs_review");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("needs_review");
    expect(row.acceptanceReport?.[0].undetermined).toBe(true);
    expect(row.acceptanceReport?.[0].reason).toContain("判卷未完成");
    const [attempt] = await db
      .select()
      .from(learningAttempts)
      .where(eq(learningAttempts.taskId, taskId));
    expect(attempt.judgedBy).toBe("model");
    // 判卷没出结论，学习历史里也不能写着"这份答案被接受了"。
    expect(attempt.accepted).toBe(false);
    const after = await latestAuditEvent(taskId, "audit.needs_review");
    expect(after?.verdict).toBe("needs_review");
    expect(after?.judge?.reason).toBe("provider_error");
  });

  it("判卷在事务外跑，模型调用期间不占任务行锁", async () => {
    const { taskId } = await setupJudgeTask();

    // 判卷曾经在审计事务里调模型，整段时间任务行都被锁着：这期间用户提交、
    // 取消、改派都在排队等一个远程调用。这里用 NOWAIT 直接证明"调用模型时
    // 那一行是自由的"——如果判卷又搬回事务里，这条会以 55P03 变红。
    let lockFreeDuringJudge = false;
    let statusDuringJudge: string | null = null;
    const judge: JudgeFn = async () => {
      await db.execute(
        sql`select id from tasks where id = ${taskId} for update nowait`,
      );
      lockFreeDuringJudge = true;
      const [row] = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId));
      statusDuringJudge = row.status;
      return {
        status: "success",
        text: verdictReply(true, "答案解释了词法环境"),
        model: "fake-judge",
        tokensIn: 10,
        tokensOut: 5,
      };
    };

    const result = await auditTask(taskId, DEMO_USER_ID, { judge });

    expect(lockFreeDuringJudge).toBe(true);
    // 判卷时任务还没被改成 auditing：状态锁是事务里才拿的。
    expect(statusDuringJudge).toBe("submitted");
    expect(result.decision).toBe("accepted");
  });

  it("判卷期间产物被换掉时不复用结论，落回待你判定", async () => {
    const { taskId, artifactId } = await setupJudgeTask();

    // 读产物与拿行锁之间有窗口。这里在判卷时补交一份新产物，模拟那个窗口：
    // 事务外那份判卷说的是旧内容，不能拿来给新产物下结论。
    const judge: JudgeFn = async () => {
      await db.insert(artifacts).values({
        id: "art_swapped_midjudge",
        taskId,
        type: "draft",
        title: "换掉的产物",
        content: "这是判卷开始之后才提交的另一份答案，内容完全不同。",
        submittedBy: "user",
        sourceType: "user_submitted",
      });
      return {
        status: "success",
        text: verdictReply(true, "旧答案解释了词法环境"),
        model: "fake-judge",
        tokensIn: 10,
        tokensOut: 5,
      };
    };

    const result = await auditTask(taskId, DEMO_USER_ID, { judge });

    // 新产物有内容、清单里只有 judge 项，但那一项没有被判过（判的是旧产物）。
    expect(result.decision).toBe("needs_review");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row.status).toBe("needs_review");
    expect(row.acceptanceReport?.[0].undetermined).toBe(true);

    const after = await latestAuditEvent(taskId, "audit.needs_review");
    // 判过，但判的不是这份：judgedBy 必须为空，理由写明为什么没结论。
    expect(after?.judge?.judgedBy).toBeNull();
    expect(after?.judge?.reason).toBe("artifact_changed");
    // 判卷行记的是被真正判过的那份答案，且没有因此被标成"已接受"。
    const [attempt] = await db
      .select()
      .from(learningAttempts)
      .where(eq(learningAttempts.taskId, taskId));
    expect(attempt.artifactId).toBe(artifactId);
    expect(attempt.accepted).toBe(false);
  });
});
