import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Evidence } from "@/lib/db/schema";
import { goals, tasks } from "@/lib/db/schema";
import { NotFoundError } from "@/lib/domain/errors";
import { sha256 } from "@/lib/ids";
import type { Tx } from "@/server/services/shared/tx";
import { writeMemoryFact } from "./facts";

/**
 * 一次验收的结论，写成一条可检索的任务记忆。
 *
 * 为什么必须幂等：验收会被重跑（点两次、审计重算、并发 worker）。没有幂等，
 * 同一个任务就会在记忆里堆积多条互相矛盾的"结论"，之后谁引用它都不对。
 * 这里用 factKey = `task:<taskId>:lesson` 把同一任务的所有结论收敛成
 * 一条当前版本：内容不变只刷新确认时间，结论变了走 writeMemoryFact 的
 * supersede（旧行留作历史，当前行仍然只有一条）。
 *
 * 为什么不带 agentId：这句话的出处是验收器对产物的判定，不是某个 Agent 的
 * 自述。挂到具体 Agent 名下会让"谁说的"看起来像证据，而证据其实是产物。
 */
const LESSON_TYPE = "procedural" as const;

/**
 * 0.9：验收结论是规则判定（对照验收清单 + 产物），不是模型的推测，所以比
 * 一般洞察更可信；不到 1，是因为它仍然可能是"产物存在但内容不合要求"的
 * 那次误判，留出被后续结论覆盖的空间（writeMemoryFact 要求 >= 0.8 才会覆盖）。
 */
const LESSON_CONFIDENCE = 0.9;

/** 与 insights.ts 里"用户可采纳的结论"同级：重要，但不至于挤掉用户的原话。 */
const LESSON_SALIENCE = 0.8;

/** 任务没有目标（临时任务）时的领域兜底值，沿用 seed 里既有取值，不自创枚举。 */
const FALLBACK_DOMAIN = "learning";

export type TaskLesson = {
  memoryId: string;
  factKey: string;
  domain: string;
};

export async function recordTaskLesson(input: {
  userId: string;
  taskId: string;
  /** 被验收的那份产物；"没有找到可验收的产物"时传 null，这本身就是结论的一部分。 */
  artifactId: string | null;
  accepted: boolean;
  reason: string;
  /** 传进来就写在调用方的事务里（验收路径要的是"验收与记忆同生共死"）。 */
  tx?: Tx;
}): Promise<TaskLesson> {
  const run = async (tx: Tx): Promise<TaskLesson> => {
    // 归属校验：taskId 来自调用方，记忆却按 userId 归档。不校验就会允许
    // "用我的账本记住别人任务的结论"，跨租户读一条 title 也算越权。
    const [task] = await tx
      .select({
        id: tasks.id,
        title: tasks.title,
        topicKey: tasks.topicKey,
        goalDomain: goals.domain,
      })
      .from(tasks)
      .leftJoin(goals, eq(goals.id, tasks.goalId))
      .where(and(eq(tasks.id, input.taskId), eq(tasks.userId, input.userId)));
    if (!task) {
      throw new NotFoundError("任务不存在。");
    }

    const reason = input.reason.trim();
    const artifactRef = input.artifactId
      ? `产物 ${input.artifactId}`
      : "本次没有可验收的产物";
    const topicSuffix = task.topicKey ? `，学习主题「${task.topicKey}」` : "";

    // "怎么做成的"只能是产物本身：验收器看得见的就是产物和理由，再往过程上
    // 写一句（"先查资料再动笔"）就是没有证据的猜测，而这条记忆会被之后的任务
    // 当成先例引用。
    const content = input.accepted
      ? `任务「${task.title}」通过验收。做法：产出 ${artifactRef}${topicSuffix}；验收结论：${reason}`
      : `任务「${task.title}」被驳回。不合格之处：${reason}；要重做的是 ${artifactRef}${topicSuffix}`;

    const evidence: Evidence[] = [
      {
        label: input.accepted ? "验收通过" : "验收驳回",
        ref: `task:${input.taskId}`,
        quote: reason,
      },
    ];
    if (input.artifactId) {
      evidence.push({ label: "验收产物", ref: `artifact:${input.artifactId}` });
    }

    // value 是"这一版结论"的指纹，不是给人看的：同样的判定写两次得到同一个值，
    // writeMemoryFact 于是只刷新 lastConfirmedAt；理由或产物变了值就变，
    // 那次会被当成新版本覆盖旧行。理由可能很长，取哈希避免 value 无界膨胀。
    const value = [
      input.accepted ? "accepted" : "rejected",
      input.artifactId ?? "no-artifact",
      sha256(reason).slice(0, 16),
    ].join("|");

    const factKey = `task:${input.taskId}:lesson`;
    const domain = task.goalDomain ?? FALLBACK_DOMAIN;

    const memoryId = await writeMemoryFact(tx, {
      userId: input.userId,
      agentId: null,
      type: LESSON_TYPE,
      domain,
      content,
      confidence: LESSON_CONFIDENCE,
      salience: LESSON_SALIENCE,
      evidence,
      // 记忆的来源实体就是这个任务；回滚按 sourceEventId 反查时能整组撤回。
      sourceEventId: `task:${input.taskId}`,
      factKey,
      value,
    });

    return { memoryId, factKey, domain };
  };

  return input.tx ? run(input.tx) : db.transaction(run);
}
