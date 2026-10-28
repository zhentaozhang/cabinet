import { money } from "@/lib/format";

/**
 * 一条 run 上的「用量」与「费用」，两处（任务页的运行横幅、Agent 页的最近
 * 运行列表）共用同一份判定。
 *
 * 原来两处都写成：token 为 null 就印「用量未知」，但后面紧跟 `money(run.
 * costCents)`——而失败/超时的 run 从来不给 costCents 赋值（默认 0），于是同一
 * 行读作「用量未知 · ¥0.00」，把一次可能真花掉钱、只是没报用量的调用记成了零。
 * `src/lib/llm.ts` 的注释明说这几种结果「may have reached the provider, so
 * usage is unknown」，`src/lib/db/schema/runs.ts` 也写着 null「is not the same
 * as a measured zero」；台账（`settleBudget`）更已经把它记成 unknownCents，
 * Agent 页的「本周用量」算进了这份敞口——行里再印 ¥0.00 就自相矛盾。
 */
export function runTokensLabel(input: {
  tokensIn: number | null;
  tokensOut: number | null;
}): string {
  if (input.tokensIn === null || input.tokensOut === null) return "用量未知";
  return `${input.tokensIn + input.tokensOut} tokens`;
}

/**
 * costSource === "unknown" 是唯一的「可能花了钱但没报」信号；null 表示这次 run
 * 根本没调模型（demo / 规则稿 / 未配置），0 元是真值，照常印金额。
 */
export function runCostLabel(input: {
  costCents: number;
  costSource: string | null;
}): string {
  if (input.costSource === "unknown") return "费用未知";
  return money(Number.isFinite(input.costCents) ? input.costCents : 0);
}
