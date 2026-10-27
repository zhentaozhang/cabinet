import type { tasks } from "@/lib/db/schema";
import { logEvent } from "@/lib/observability/log";
import type { Tx } from "@/server/services/shared/tx";
import { recordOutcome } from "../learning/mastery";

/** 验收结论的三值形态：通过 / 驳回 / 没人能判（needs_review）。 */
export type OutcomeVerdict = "pass" | "fail" | "needs_review";

/** 判定出自哪条链路，只用于日志定位，不参与任何判断。 */
export type OutcomeSource = "audit" | "audit.override";

export type MasteryTaskRow = Pick<
  (typeof tasks)["$inferSelect"],
  "id" | "template" | "topicKey" | "goalId"
>;

/**
 * 只有学习模板的验收才推进掌握度：其余任务即便有人手写了 topicKey 也与复习
 * 排期无关，把它的成败记成一次"答对/答错"会让间隔重复凭空跳级。
 */
export function isLearningTemplate(template: string | null): boolean {
  return template === "learning" || template === "learning_retest";
}

export type MasteryOutcomeResult =
  | "recorded"
  | "skipped_not_learning"
  | "skipped_no_topic"
  | "skipped_undetermined"
  | "failed";

/**
 * 把一次验收结论折进掌握度与复习排期（SM-2，见 lib/domain/mastery.ts）。
 *
 * 两条链路共用这一处实现：Auditor 的自动验收（audit.ts）和用户亲手判定
 * （override.ts）。分成两份是上一版的真实缺陷——人判通过的任务把状态推进到
 * accepted，却没有任何东西推进 due_at，题目永远停在"已到期"，同一主题被反复
 * 判为到期，间隔重复对不接模型的用户彻底失效。
 *
 * 人判该不该推掌握度、但不该推信任分：信任分记的是 Agent 自己干出来的成绩，
 * 人覆盖一次就能把它刷上去，它就不再是证据；掌握度记的是学习者的状态，人给出
 * 的结论恰恰是最可信的那份输入。
 *
 * 没有结论（needs_review）时既不加也不减：没有结论≠答错，记成错答会把间隔
 * 压回一天，记成答对又会凭空翻倍，比不记更失真。
 */
export async function recordMasteryOutcome({
  tx,
  userId,
  task,
  verdict,
  source,
}: {
  tx: Tx;
  userId: string;
  task: MasteryTaskRow;
  verdict: OutcomeVerdict;
  source: OutcomeSource;
}): Promise<MasteryOutcomeResult> {
  if (!isLearningTemplate(task.template)) return "skipped_not_learning";
  if (!task.topicKey) return "skipped_no_topic";
  if (verdict === "needs_review") {
    logEvent("info", "mastery.skipped_needs_review", {
      taskId: task.id,
      topicKey: task.topicKey,
      source,
    });
    return "skipped_undetermined";
  }

  // savepoint：验收结论已经确定，排期写失败只回滚这一小段，不会连带丢掉一次
  // 有效验收；反过来把掌握度放到事务外，一次报错就再没有东西会补上这次复习。
  try {
    await tx.transaction(async (savepoint) => {
      await recordOutcome({
        userId,
        topicKey: task.topicKey as string,
        goalId: task.goalId,
        correct: verdict === "pass",
        tx: savepoint,
      });
    });
    return "recorded";
  } catch (error) {
    logEvent("error", "mastery.record_failed", {
      taskId: task.id,
      topicKey: task.topicKey,
      source,
      message: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
