/**
 * Memory 页的制度文案。抽出来是为了让它能被测试钉住：这一栏每一句都
 * 必须对应一处真实实现，页面不许承诺运行时没有的闸门。
 *
 * 原来这里有两句是空的：页头徽章写「可编辑 / 可删除」，但记忆只有
 * DELETE /api/memories/[id] 一条写入面（没有 PATCH，也没有编辑表单，
 * 见 src/components/memory-actions.tsx）；治理卡写「健康、财务、关系等
 * 高影响记忆必须由你确认」，而代码里没有任何「按领域要求确认」的闸门——
 * 种子数据里那条 domain=health 的夜间精力记忆就是 Agent 写的、直接 active。
 */

/** 页头两个徽章：都是整库不变量，不随 tab 变化。 */
export const MEMORY_HEADER_BADGES = [
  "无来源不写入",
  "可删除 · 留审计",
] as const;

/**
 * 治理卡四句，顺序与页面上的图标一一对应（ShieldCheck / TriangleAlert /
 * Database / Brain）。每句的依据：
 *
 * 1. 所有写入面都带 sourceEventId（checkins.ts、memory/facts.ts、
 *    memory/task-lesson.ts、memory/insights.ts、council/decide.ts）。
 * 2. memory/facts.ts 的 canSupersede：authority 为 user，或置信度 ≥ 0.8
 *    且不低于现有版本；不满足时另存一条 status=conflicted 的历史版本。
 * 3. 同上：冲突行 validTo = now、永不参与检索，并给用户发一条通知。
 * 4. retrieval.ts 的排序权重里近因占 0.5、锚点是 lastConfirmedAt ??
 *    createdAt，且 SQL 会过滤掉 expiresAt 已过的行；置信度本身不参与排序。
 */
/**
 * 冲突计数在两处页面上出现（记忆页 Conflicts 一格、内阁页知识资产「记忆」格），
 * 原来分别写「待解决矛盾」与「待你裁定」——都没有对应的动作：冲突行在写入
 * 的那一刻就已经 validTo = now、status = conflicted，只落在「历史版本」栏，
 * 生效的那条一个字段都没动。能改变现状的只有删除（见 memory-actions.tsx）。
 * 所以这两句改成指路：数字在哪一栏能看到，而不是承诺一次不存在的裁定。
 */
export function conflictStatHint(conflicts: number): string {
  if (!Number.isFinite(conflicts) || conflicts <= 0) return "没有互相冲突的事实";
  return "都在「历史版本」里";
}

export function conflictCellDetail(conflicts: number): string {
  if (!Number.isFinite(conflicts) || conflicts <= 0) return "没有互相冲突的事实";
  return `${Math.trunc(conflicts)} 条自相矛盾，都在「历史版本」里`;
}

export const MEMORY_GOVERNANCE_LINES = [
  "没有来源事件的记忆不许写入，防止模型编造。",
  "Agent 想改写一条已有事实，必须比原版本更确定；达不到就另存一条「待确认」的冲突，而不是覆盖。",
  "冲突时不静默覆盖：标记「待确认」，保留双方证据。",
  "检索按相关度、显著性和近因加权：越久没被确认的排得越靠后，带到期时间的记忆一旦过期就不再参与检索。",
] as const;
