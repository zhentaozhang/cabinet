import { notifyKindLabel } from "@/contracts/labels";

/**
 * 通知到底会发哪几类——一处口径，两个页面共用。
 *
 * 设置页开关旁边原来写的是「只会发需要你动手的事：验收未通过、等你批准、预算拦截、
 * 记忆冲突。」——四个名字，而真正 enqueue 的地方有五个：
 *
 *  - audit.ts:556  rejection（验收不通过）
 *  - audit.ts:575  review（Auditor 给不出结论、任务停在待你判定）
 *  - approvals.ts:76  approval（等你批准）
 *  - run.ts:145    budget（预算拦截）
 *  - memory/facts.ts:134  conflict（记忆冲突）
 *
 * 漏掉的 review 恰好是最静默的一类：任务停在 needs_review 不会自己动，
 * 用户读到的清单里没有它，就不会知道邮件该来。
 *
 * NOTIFY_KIND_LABEL（src/contracts/labels.ts:333-342）里还有一个 council 键，
 * 但全仓没有任何 enqueue 调用点会写它——清单只列真的会发的，不替未来多承诺。
 */
export const NOTIFIED_KINDS = [
  "rejection",
  "approval",
  "budget",
  "review",
  "conflict",
] as const;

/** 开关旁那句「只会发…」：名字全部来自 NOTIFIED_KINDS，不在页面里手写。 */
export function notifyScopeLine(): string {
  const names = NOTIFIED_KINDS.map((kind) => notifyKindLabel(kind)).join("、");
  return `只会发需要你动手的事：${names}。正常的一天不会收到邮件。`;
}

/** 投递记录为空时的说明：空的那一天意味着哪些事都没发生，五类都要点到。 */
export const NOTIFY_EMPTY_HINT =
  "验收通过、预算正常、没有记忆冲突、也没有停在待你判定的任务时，这里会一直是空的。";
