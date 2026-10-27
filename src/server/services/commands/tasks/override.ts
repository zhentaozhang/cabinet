import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { artifacts, tasks } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { assertTransition } from "@/lib/domain/state";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/domain/errors";
import { logEvent } from "@/lib/observability/log";
import { recordTaskLesson } from "../memory/task-lesson";
import { recordMasteryOutcome } from "./mastery-outcome";

/** 判定理由的长度约束：太短等于没写，太长是没人会读完的流水账。 */
const REASON_MIN = 5;
const REASON_MAX = 500;

export type OverrideDecision = "accepted" | "rejected";

/**
 * 人亲手给"没有结论"的任务下结论。
 *
 * Auditor 说"没人能判"时任务停在 needs_review（见 lib/domain/state.ts）。
 * 这是唯一能把任务带出这个状态的地方，也是唯一一次人的判断直接决定任务
 * 成败的地方。因此这里刻意做了三件在其他命令里不必做的事：
 *
 * 1. 理由必填。一条没有理由的通过，事后既无法复核，也无法向当时那个决定
 *    解释；审计行里留着理由，是把它当记录而不只是当按钮。
 * 2. 按 reads 到的状态条件写回，零行就冲突。同一个人在两台设备上同时点
 *    "通过"和"驳回"，不能变成"后点的那个生效"——那会把一条互相矛盾的
 *    判定悄悄写进历史。
 * 3. 不碰 agents 的 successCount / failCount / trustScore，但要推掌握度。
 *    两个数字记的不是同一件事：信任分是 Agent 自己干出来的成绩，人的覆盖
 *    不是它的证据（通过不能证明它做对了，驳回也不能证明它做错了），一旦联动，
 *    用户随手覆盖几次就能把任意 Agent 的信任分刷上去；掌握度是学习者的状态，
 *    人的结论恰恰是它最可信的那份输入。不推进掌握度的后果很具体：到期复习题
 *    必带模型判卷项，没接模型时必然停在 needs_review，人判通过后 due_at 却
 *    留在过去，同一主题每天都会被判为"到期"，间隔重复对离线用户彻底失效。
 *
 * 判定的记录落在 audit_events（action "audit.override"），不落 approvals：
 * approvals 里的 pending/approved 行是运行时的执行授权（execution.ts 取最新
 * 一条决定这次运行能不能调工具，policy 看到 approved 就放行），在那种表里
 * 写一行"人也判过了"，下次运行会被当成"用户已批准"而跳过本该有的审批。
 */
export async function overrideAudit({
  taskId,
  userId,
  decision,
  reason,
  now,
}: {
  taskId: string;
  userId: string;
  decision: OverrideDecision;
  reason: string;
  /** 只在回放/测试时给；生产路径的时间一律来自数据库时钟。 */
  now?: Date;
}) {
  const note = reason.trim();
  if (note.length < REASON_MIN) {
    throw new ValidationError(
      `判定理由至少 ${REASON_MIN} 个字：请说明你依据什么下这个结论。`,
    );
  }
  if (note.length > REASON_MAX) {
    throw new ValidationError(`判定理由最多 ${REASON_MAX} 个字。`);
  }

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) throw new NotFoundError("Task not found");

  // 两道检查各管一件事：这里先确认"现在确实在等人判"，下面的 assertTransition
  // 再确认"人判的结果是状态图允许的边"，两个都为真才允许往下走。
  if (task.status !== "needs_review") {
    throw new ConflictError("任务不在待判定状态，可能已被处理。");
  }
  assertTransition("task", "needs_review", decision);

  const stamp = now ?? sql`now()`;

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasks)
      .set({
        status: decision,
        updatedAt: stamp,
        // 通过才留验收时间；驳回还写着"验收于某时"会让驳回单看起来像通过过。
        ...(decision === "accepted" ? { acceptedAt: stamp } : {}),
      })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.userId, userId),
          eq(tasks.status, "needs_review"),
        ),
      )
      .returning();
    if (!updated) {
      throw new ConflictError("任务不在待判定状态，可能已被处理。");
    }

    // 判定描述的是"最后提交的那份内容"，指错产物等于指错证据。
    const [artifact] = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.taskId, taskId))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);

    // 人判的结果对该主题的复习排期同样有效（理由见函数头第 3 条）。
    await recordMasteryOutcome({
      tx,
      userId,
      task: updated,
      verdict: decision === "accepted" ? "pass" : "fail",
      source: "audit.override",
    });

    // 人给的结论同样是这个任务留下的"经验"，要让之后的检索看得见。
    // 仍然放在 savepoint 里：判定已经写进任务行，一条记忆写失败不该把
    // 用户刚做的决定回滚掉。
    try {
      await tx.transaction(async (savepoint) => {
        await recordTaskLesson({
          userId,
          taskId,
          artifactId: artifact?.id ?? null,
          accepted: decision === "accepted",
          reason: note,
          tx: savepoint,
        });
      });
    } catch (error) {
      logEvent("error", "task_lesson.record_failed", {
        taskId,
        source: "audit.override",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const auditHash = await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "audit.override",
      target: taskId,
      before: { status: "needs_review" },
      after: {
        status: decision,
        reason: note,
        // 没有产物就是 null：不指向上一条别人的产物，也不漏掉"被判的是哪一份"。
        artifactId: artifact?.id ?? null,
      },
    });

    return { task: updated, auditHash };
  });
}
