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

/**
 * 「模型」那一行在未配置时说什么。
 *
 * 原来写的是「所有 Agent 步骤无法真实执行，任务会停在生成草稿前」。两条都不准：
 * - DEMO_MODE=true 时 run.ts 走 else-if (demoMode) 分支，用 draftFor 的模板稿照常
 *   提交（那条 run 记 mode: "demo"，产物标为演示模板），任务不会停在草稿前；
 * - 非演示模式下没配模型是 throw ValidationError，任务落 failed 并记一条
 *   task.run.failed 审计，不是「停在草稿前」这种不疼不痒的状态。
 */
export function modelMissingHint(demoMode: boolean, envVar: string): string {
  const need = `需要设置 ${envVar} 才能真实执行。`;
  return demoMode
    ? `未配置模型：当前是演示模式，Agent 会用模板稿走完流程、照常提交，但产物标为「演示模板」，不是真实推理。${need}`
    : `未配置模型：执行会直接失败并写明原因（任务落到「执行失败」），不会有产物。${need}`;
}
