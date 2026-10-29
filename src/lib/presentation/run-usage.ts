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

/**
 * 一行 step 上的耗时与 token。
 *
 * 步骤行记的是这次运行的轨迹，不是账单：`run.ts` 的 context / plan / submit
 * 三步写的是估算（`ti: 220`、`latency: 90`），`audit.ts` 与 `apprentice.ts`
 * 的确定性步骤写的是固定常数（80/40 tok、100ms），连没调模型的 `suggest`
 * 路径也写了 120/240。这个分层是有意为之——
 * `tests/integration/model-usage-accounting.test.ts` 明写「估算只留在 step
 * 行上，不能污染 run 的实测值」。问题在任务页把两层印成了同一种样子：演示
 * 运行的横幅写着「用量未知 · ¥0.00」，下面每个步骤却写着「100ms · 120 tok」，
 * 同一张卡片上两份说法互相打脸。这里把步骤口径写出来：没调用模型就说没调用，
 * 有数字就标明是估算。
 */
export function stepTraceLabel(input: {
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}): string {
  const latency = Number.isFinite(input.latencyMs)
    ? Math.max(0, Math.round(input.latencyMs))
    : 0;
  const tokens =
    (Number.isFinite(input.tokensIn) ? Math.max(0, input.tokensIn) : 0) +
    (Number.isFinite(input.tokensOut) ? Math.max(0, input.tokensOut) : 0);
  if (tokens <= 0) return `${latency}ms · 未调用模型`;
  return `${latency}ms · 约 ${tokens} tok`;
}

/** 步骤行的悬停说明：真实用量与费用只看上面那一行的 measured / 未知口径。 */
export const STEP_TRACE_TITLE =
  "步骤行是运行的轨迹：耗时与 token 是步骤级记录（确定性步骤是估算，不是供应商回报），真实用量与费用只看上面那一行的 measured / 未知口径。";
