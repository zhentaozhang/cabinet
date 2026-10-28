import { db } from "@/lib/db";
import { learningAttempts } from "@/lib/db/schema";
import type {
  AcceptanceItem,
  AcceptanceResult,
  JudgeVerdict,
} from "@/lib/db/schema";
import {
  buildJudgePrompt,
  judgeCriteria,
  judgeScore,
  mergeJudgeResults,
  parseJudgeVerdicts,
} from "@/lib/domain/judgement";
import { newId } from "@/lib/ids";
import {
  isModelConfigured,
  judgeAnswer,
  type JudgeAnswerInput,
  type JudgeAnswerResult,
} from "@/lib/llm";
import { logEvent } from "@/lib/observability/log";
import type { Tx } from "@/server/services/shared/tx";

/**
 * 判卷的编排层：这里才有 IO（模型调用 + learning_attempts 落库），
 * 提示构造、解析、合并、算分全在 domain/judgement.ts 里。
 *
 * 分开的理由：判卷最容易出错的是"模型返回了脏东西"，那部分必须能脱离网络
 * 单测；而"没模型/超时/解析失败时到底判不判"是产品决定，集中在这里一处，
 * audit 只负责调用它并如实记录。
 */

/** 可注入的判卷函数：集成测试用假的实现覆盖"有模型"分支，不靠真网络。 */
export type JudgeFn = (input: JudgeAnswerInput) => Promise<JudgeAnswerResult>;

export type JudgeReason =
  | "no_judge_items"
  | "no_model"
  | "empty_answer"
  | "judged"
  | "parse_failed"
  | "empty_response"
  | "timeout"
  | "provider_error";

export type JudgeOutcome = {
  results: AcceptanceResult[];
  /** 是否真的调用了模型（失败也算调用过，"没调"才算没判）。 */
  judged: boolean;
  reason: JudgeReason;
  verdicts?: JudgeVerdict[];
  /** 已判定项里通过的比例；判卷没发生时缺省。 */
  score?: number;
  judgeModel?: string | null;
  /**
   * 供应商回报的用量。没调用、没回报、或回报是 0/0（判卷提示非空，真实调用
   * 不可能 0 输入 token）时为 null——不能拿 0 冒充「没花钱」。
   */
  usage?: { tokensIn: number; tokensOut: number } | null;
  /** 这次判卷请求的尝试 id（模型真被调用时才非空），审计 run 用它记账。 */
  attemptId?: string | null;
};

export type JudgeSubmissionInput = {
  userId: string;
  taskId: string;
  /** 被判定的那份产物；learning_attempts.artifactId 记它，报告才能回溯。 */
  artifactId: string;
  /** 题面（标题 + 描述），同时写进 learning_attempts.prompt。 */
  question: string;
  answer: string;
  checklist: AcceptanceItem[];
  /** 确定性判定的结果，judge 项在这里是 undetermined，等待回填。 */
  results: AcceptanceResult[];
  signal?: AbortSignal;
  /** 测试注入；默认走 llm.judgeAnswer。 */
  judge?: JudgeFn;
  /** 事务句柄：audit 传入，让判卷结论与验收报告同生共死。 */
  tx?: Tx;
};

/** 把"没拿到可用回复"的几种情况收敛成三种降级原因（success 不该走到这里）。 */
function failureReasonOf(
  reply: JudgeAnswerResult | null,
): "empty_response" | "timeout" | "provider_error" {
  if (!reply || reply.status === "success") return "provider_error";
  return reply.status;
}

function undecidedVerdicts(criteria: string[], reason: string): JudgeVerdict[] {
  return criteria.map((criterion) => ({
    criterion,
    pass: false,
    undetermined: true,
    reason,
  }));
}

/**
 * 判一个任务的学习答案。
 *
 * 约定：这个函数永不抛异常。判卷只是验收链上的一步，模型挂了应该让该项
 * 变成 undetermined（由人接手），而不是让整次审计回滚。
 */
export async function judgeSubmission(
  input: JudgeSubmissionInput,
): Promise<JudgeOutcome> {
  const criteria = judgeCriteria(input.checklist);

  // 没有 judge 项时连提示都不构造：这条路径必须与引入判卷之前完全一致，
  // 否则每个普通任务的审计都会多出一次无意义的模型调用。
  if (criteria.length === 0) {
    return {
      results: input.results,
      judged: false,
      reason: "no_judge_items",
      usage: null,
      attemptId: null,
    };
  }

  // 空答案不可能通过判卷，调模型只是花钱让模型说"没内容"。
  if (!input.answer.trim()) {
    logEvent("warn", "judge.skipped", {
      taskId: input.taskId,
      reason: "empty_answer",
    });
    return {
      results: input.results,
      judged: false,
      reason: "empty_answer",
      usage: null,
      attemptId: null,
    };
  }

  const judge: JudgeFn | null =
    input.judge ?? (isModelConfigured() ? judgeAnswer : null);
  if (!judge) {
    // 没配置模型是"环境没这个能力"，不是"判过了没通过"：如实记 no_model，
    // 不能写一条 model 记录冒充判过（那会让学习历史凭空多出零分）。
    logEvent("warn", "judge.skipped", {
      taskId: input.taskId,
      reason: "no_model",
    });
    return {
      results: input.results,
      judged: false,
      reason: "no_model",
      usage: null,
      attemptId: null,
    };
  }

  const { system, prompt } = buildJudgePrompt({
    question: input.question,
    answer: input.answer,
    criteria,
  });

  let reply: JudgeAnswerResult | null = null;
  let failure: "provider_error" | null = null;
  try {
    reply = await judge({
      system,
      prompt,
      signal: input.signal,
    });
  } catch (error) {
    // 注入的实现或客户端都可能直接抛；这里统一折成 provider_error，
    // 原始信息只进日志（可能有请求体），不往验收报告里写。
    failure = "provider_error";
    logEvent("warn", "judge.degraded", {
      taskId: input.taskId,
      reason: "provider_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const judgeModel = reply?.model ?? null;

  let verdicts: JudgeVerdict[];
  let reason: JudgeReason;

  if (failure !== null) {
    verdicts = undecidedVerdicts(
      criteria,
      "判卷未完成：模型调用失败（provider_error），这一项需要你人工判定",
    );
    reason = "provider_error";
  } else if (reply === null || reply.status !== "success") {
    const status = failureReasonOf(reply);
    verdicts = undecidedVerdicts(
      criteria,
      `判卷未完成：模型调用失败（${status}），这一项需要你人工判定`,
    );
    reason = status;
    logEvent("warn", "judge.degraded", {
      taskId: input.taskId,
      reason: status,
      model: judgeModel,
    });
  } else {
    verdicts = parseJudgeVerdicts(reply.text, criteria);
    // 一条都没判出来就说明模型没按格式回复，这与"失败"不同但也别记成 judged。
    const decided = verdicts.some((verdict) => !verdict.undetermined);
    reason = decided ? "judged" : "parse_failed";
    if (!decided) {
      logEvent("warn", "judge.degraded", {
        taskId: input.taskId,
        reason: "parse_failed",
        model: judgeModel,
      });
    }
  }

  const merged = mergeJudgeResults(input.results, verdicts);
  const score = judgeScore(merged);

  // 落库包在自己的 savepoint 里：调用方（audit）是在事务内调过来的，一条语句
  // 失败会把整个事务置成 aborted，之后再 catch 也没用——后面每条语句都会以
  // 25P02 失败，连验收结论都写不进去。开 savepoint 才能"只回滚这一条写入"。
  const writeAttempt = async (client: Tx | typeof db) => {
    await client
      .insert(learningAttempts)
      .values({
        id: newId("la"),
        userId: input.userId,
        taskId: input.taskId,
        artifactId: input.artifactId,
        prompt: input.question,
        answer: input.answer,
        rubric: criteria,
        verdicts,
        score,
        judgedBy: "model",
        judgeModel,
        // 判卷只给结论，不替调用方决定"这份答案被不被接受"：
        // 那是 audit 依据整张清单的结论回填的。
        accepted: false,
      })
      .onConflictDoUpdate({
        target: [learningAttempts.userId, learningAttempts.taskId],
        set: {
          artifactId: input.artifactId,
          prompt: input.question,
          answer: input.answer,
          rubric: criteria,
          verdicts,
          score,
          judgeModel,
          // 唯一键上重复判卷时覆盖旧结论，但 accepted 留给调用方：
          // 覆盖它会把 audit 已经给出的结论抹掉。
        },
      });
  };

  try {
    if (input.tx) {
      await input.tx.transaction(writeAttempt);
    } else {
      await writeAttempt(db);
    }
  } catch (error) {
    // 落库失败不回滚判卷结论：报告仍然如实显示这次判了什么，
    // 但日志必须记下"这次尝试没有落库"，否则学习历史会静默缺行。
    logEvent("error", "judge.persist_failed", {
      taskId: input.taskId,
      artifactId: input.artifactId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 只有真拿到回复、且供应商报了非零用量时才记用量。判卷提示非空（题面 + 答案
  // + 清单），所以 0 输入 token 只可能是「没上报」，不是「真没花」。
  const usage =
    reply?.status === "success" &&
    (reply.tokensIn > 0 || reply.tokensOut > 0)
      ? { tokensIn: reply.tokensIn, tokensOut: reply.tokensOut }
      : null;

  return {
    results: merged,
    judged: true,
    reason,
    verdicts,
    score,
    judgeModel,
    usage,
    attemptId: reply?.attemptId ?? null,
  };
}
