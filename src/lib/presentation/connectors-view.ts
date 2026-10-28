/**
 * 连接器页「模型」那一行的说明。
 *
 * 原来写的是「用量与费用记在每周预算台账里」。生成产物（generateArtifact）和
 * MODEL_TOOL_SELECTION=on 时的模型选工具确实走 reserveBudget / settleBudget
 * （agent_budget_periods）；但清单里的 judge 项是 audit 的事务外一次独立调用
 * （audit.ts 的 prepareJudgement -> judgeSubmission -> llm.judgeAnswer），它只把用量
 * 记在那条审计 run 上，从不预留也从不结算，所以判卷花掉的钱不占你自己的周预算上限。
 * 那句「用量与费用记在每周预算台账里」因此是假话：用户会以为把周上限调低就能挡住
 * 判卷的开销。真实口径见 README「审计运行的用量」那一行。
 */
export function modelBillingHint(provider: string): string {
  return `通过 ${provider} 调用；生成产物与模型选工具用掉的 token 记在每周预算台账里，判卷那次调用的 token 只记在那条审计运行上，不进周预算。`;
}
