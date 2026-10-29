/**
 * Council 页「会议规则」那五条。抽出来是为了能被测试钉住：这一栏是
 * 对用户的行为承诺，每一句都必须对应一处真实实现。
 *
 * 原来有两句是空的：
 * - 「只在高风险决策时召开，不替代日常执行」：没有任何自动召集——
 *   `createCouncil` 只在用户点「发起会议」时被调用（`/api/councils`），
 *   同一个页面的空状态也写着「自动触发（支出、时间冲突、目标变更）尚未接入」。
 * - 「Critic 必须唱反调，否则会议无效」：Critic 的立场确实固定为 oppose
 *   （`council/positions.ts`），但没有任何地方判「会议无效」——唯一的门槛是
 *   `config.council.minPositions`（默认 3）的参与人数，少了 Critic 的会议
 *   照样能决议。
 */
export const COUNCIL_RULES = [
  "会议由你发起，系统不自动召集：支出、时间冲突、目标变更的自动触发尚未接入。",
  "每个 Agent 必须给证据，不允许只给观点。",
  "Critic 的立场固定为反对——它的职责是挑战，不是表态支持。",
  "Auditor 不参加内阁：它只做验收，验收时独立判断。",
  "你有一票否决权，但必须留下理由；要约「有条件批准」，条件本身就是那段理由。",
] as const;

/**
 * 决议卡上那句异议说明。原来无条件写「N 条正式异议已归档」，可是
 * `decideCouncil` 只在 `decision !== "reject"` 的分支里插 `dissents` 行——否决
 * 没有跟进任务可观察，也就没有可判定的证伪条件。于是被否决的会议：决议卡
 * 说「2 条正式异议已归档」，复盘页的异议栏、内阁页「共 N 条异议」都是 0。
 *
 * `resolution.dissents` 在两种决议下都记着「当时谁反对」（它来自 positions），
 * 所以这个函数问的不是「有没有人反对」，而是「有没有真的登记成可判定的异议」。
 */
export function resolutionDissentLine(
  decision: "approve" | "reject" | "conditions",
  count: number,
): string | null {
  if (count <= 0) return null;
  if (decision === "reject") {
    return `${count} 位 Agent 当时持反对意见；这次是否决，没有跟进任务可观察，所以没有登记证伪条件——复盘页的异议栏里不会有这几条。`;
  }
  return `${count} 条正式异议已登记，观察窗口到期后会按各自的证伪条件自动判定。`;
}
