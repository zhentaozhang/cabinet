/**
 * 哪些外部检索工具是按次计费的。
 *
 * `web_fetch` 是抓一个指名页面，本来就不按次收费：写入台账时 run.ts 与 tool-loop
 * 都传 billable: false，所以那一行的 unit_price_cents 恒为 0。于是台账里 0 有两种
 * 含义——「这个工具不收费」和「部署没配置单价」——统计方必须分开数，否则首页会在
 * 配了 SEARCH_COST_CENTS_PER_REQUEST 的部署里说「本周检索未计价」。
 *
 * 这份清单是唯一依据：写入方是 src/server/services/connectors/ledger.ts:32 的
 * `billable ? retrievalUnitPriceCents() : 0`，调用点见
 * src/server/services/commands/tasks/run.ts:556 与 tool-loop.ts:290-293。
 */
export const METERED_RETRIEVAL_TOOLS = ["web_search"] as const;

export function isMeteredRetrievalTool(tool: string): boolean {
  return (METERED_RETRIEVAL_TOOLS as readonly string[]).includes(tool);
}
