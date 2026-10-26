# 三梯队优化实施计划（2026-10-26）

依据：docs/competitive-analysis.md 与整体调研结论。目标是把「学习管理平台」从
"记录 + 规则模板" 推到 "有判卷、有掌握度、能自改策略"，并把已存在但只躺在
API 里的能力接到界面上。零新增运行时依赖是硬约束。

## 已落地（本计划的前置）

- schema：`src/lib/db/schema/learning.ts`（learning_topics / learning_mastery /
  learning_attempts）、`src/lib/db/schema/governance.ts` 新增 `policy_overrides`
  （partial unique：每个用户每个 key 只有一条 active）。
- 类型：`AcceptanceItem` 新增 `judge` 变体；`JudgeVerdict`、`PolicyOverrideStatus`。
- 迁移：`drizzle/0032_learning_topics_mastery_attempts_policy_overrides.sql`，已在
  tests/global-setup 的克隆库上验证可 migrate。

## T1-a 结构化答题 + LLM 判卷

- `src/lib/domain/acceptance.ts`：judge 项在确定性 pass 里返回 undetermined
  （reason 说明需要读者判定），与 manual 同构，不假判。
- `src/lib/domain/judgement.ts`（纯函数）：构造判卷 prompt、解析模型 JSON
  （容忍代码围栏/前后废话）、把 verdict 合并回 AcceptanceResult。
- `src/lib/llm.ts`：新增 `judgeAnswer()`，与 `generateText` 共用 span/超时/状态映射，
  但**不改** `generateText` 的签名与行为。
- `src/server/services/commands/tasks/judge.ts`：`judgeSubmission()` —— 仅当 checklist
  含 judge 项且配置了模型时运行；写 learning_attempts（upsert by (userId, taskId)）；
  未配置则返回 undetermined 列表。
- `src/server/services/commands/tasks/audit.ts`：确定性判定后调用 judge，合并结果，
  审计行记 artifactId；离线时日志明说"未判卷"。

## T1-b 知识点掌握度 + 间隔重复

- `src/lib/domain/mastery.ts`（纯）：SM-2 变体。`nextSchedule({ease, interval, correct})`
  → {ease, intervalDays, dueAt}；`masteryFrom(attempts, correct)` 用
  `(correct + 1) / (attempts + 2)`（拉普拉斯）避免 1/1=100%。
- `src/server/services/commands/learning/mastery.ts`：`recordOutcome()` 按 topicKey
  upsert topic + mastery 行（条件更新 + returning 检查）；`dueTopics()` 取到期主题。
- `src/lib/domain/learning.ts`：出题优先选到期主题（due），其次 latest errorTags。
- `src/server/services/commands/learning.ts`：`ensureNextLearningTask` 使用到期主题，
  checklist 追加一条 judge 项（有 rubric 时）。
- `src/lib/domain/learning-progress.ts`：progressWeights 之外增加 mastery 项？——不加，
  保持口径稳定；掌握度通过 /learning 页面与出题体现。

## T1-c 反思 → 真实策略变更

- `src/lib/policy/overrides.ts`：白名单（reflection.eveningHour、reflection.budgetPressureRatio、
  learning.nextTask.minWords、learning.nextTask.retestAfterDays、audit.sampleRate 等），
  `applyOverrides(base, rows)` 用 zod 重新校验，非法值抛 ValidationError。
- `src/lib/policy/config.ts`：新增 `getPolicyConfigFor(userId)`。
- `src/server/services/commands/policy.ts`：apply / rollback / list，全部走 logAuditTx，
  action `policy.override.apply` / `policy.override.rollback`，before/after 完整。
- `reflection.ts` 的候选洞察增加 `set_policy` 提议；`insights.ts` 采纳时应用 override，
  回滚时撤销。

## T2-a 目标生命周期

- `goals.status`：active → paused → active，active/paused → completed，completed → archived。
  `src/lib/domain/state.ts` 增加 goal 迁移表；服务层条件写回 + 影响行数检查；
  路由 `POST /api/goals/[id]`；审计 `goal.status`。

## T2-b 记忆混合检索

- `src/lib/memory/retrieval.ts`：词面 token 命中 + 字符 trigram 相似度（`src/lib/memory/rerank.ts`，
  JS 实现，不依赖 pg_trgm）+ 近因/重要性/长期性加权；`retrieveMemories` 接受可选的
  `rerank` 钩子（`(query, items) => Promise<string[]>`），**不内置模型重排**——没有 key 时
  调用方不传钩子，路径与旧版一致。

## T2-c 模型可选工具

- `src/lib/llm.ts`：`generateText` **签名未改**，另加 `generateWithTools()`，内部用
  `stopWhen: stepCountIs(maxSteps)`（v7 没有 `maxSteps` 形参）。
- `src/server/services/commands/tasks/tool-loop.ts`：`runModelToolLoop()`，每步走
  `planTools` 的授权判定 + 检索预算检查，失败一律写真实 step 状态，不写 ok。
- 开关：`MODEL_TOOL_SELECTION=on`，默认关闭；关闭时逐字走旧路径。

## T3 UI 铺设

- 任务页：manifest 下载、验收契约导出、审计链校验结果。
- 审核页：一键验链 + 失败定位。
- 目标生命周期：首页主目标取进行中项、状态徽章、暂停/完成/归档按钮。
- **未做**：学习页的到期主题与掌握度视图。掌握度只在排期里生效
  （`learning_mastery` 决定下次复习时间），服务层 `listMastery()` 已就绪但没有 API 与页面，
  README 已知边界里写明。

## 实施结果（2026-10-26 收尾）

全部通过 `bash scripts/verify.sh`：132 个测试文件 / 1245 passed，tsc + eslint + next build 全绿。

计划外但必须做的三件事（都是实施中撞出来的真问题）：

1. `learning_mastery.ease_factor` 是 float4，`CHECK (ease_factor >= 1.3)` 会把 SM-2 的下界
   本身拒掉（1.3 落库成 1.29999995）→ 迁移 `0034_ease_floor_real.sql` 改成
   `>= 1.3::real`。
2. `getPolicyConfigFor(userId)` 写完后只有 `reflection.ts` 在读，采纳一条洞察运行时毫无
   变化 → 把 `learning.ts`/`checkins.ts`/`tasks/audit.ts`/`tasks/create.ts`/
   `queries/{autonomy,review,metrics}.ts` 共 8 处改为按用户读配置，
   `tests/integration/policy-in-effect.test.ts` 证明阈值真的换掉了。
3. 目标状态表原本放在 `src/lib/domain/state.ts`，客户端组件 import 它会经
   `errors.ts` → `observability/log.ts` 拉进 `node:async_hooks`，Turbopack 直接编译失败 →
   状态表整体搬到 `src/contracts/goals.ts`（契约模块出度仍为 0）。

## 独立审查后补的修复（2026-10-26）

审查 agent 复核了 30 项，22 项判为正确、1 个 blocker + 4 个 major 判为必修。已全部处理：

1. **blocker 删号被新外键卡死**：`src/lib/account.ts` 的删除顺序补
   `policy_overrides → learning_attempts → learning_mastery → learning_topics`
   （位置在 artifacts/insights/tasks/goals 之前）；`src/lib/account-export.ts` 的
   NDJSON 导出补齐同样的四张表——能删就得能带走。
   `tests/integration/account-delete.test.ts`（3 例）在改代码前是红的
   （`learning_attempts_artifact_id_artifacts_id_fk` 冲突）。
2. **未判定被写成「逐项通过」**：`tasks/audit.ts` 的结论改三分支，
   有未判定项时写「另有 N 项未判定（模型判卷/人工判定），未计入本次结论」；
   掌握度改到同事务的 savepoint 里写，且 `judge` 项未判定时**不推进**
   （既不记对也不记错）。`tests/integration/audit-mastery.test.ts` 加了两例。
3. **掌握度回写不再静默丢失**：从"事务外 catch 一行日志"改成事务内 savepoint，
   写失败只回滚这一小段，验收结论不受影响。
4. **模型自选工具那次计费调用没记账**：`generateWithTools` 的 usage 落到 run 的
   `tokensIn/tokensOut/costCents`，不再谎报 `costSource:"actual"`。
5. **预算闸门非原子**：改为先原子预留再调用，拒单写 `budget_exceeded`
   （`tool-plan.ts` 早已声明这个状态、`task-view.tsx` 也有文案）。
6. 其余 minor：`judge.ts` 的落库改在自己的 savepoint 里（原 catch 在 aborted 事务上
   是假的）、`learning.ts` 回写 `topic_key` 失败不再让打卡接口报错、
   `learning_attempts.verdicts` 加 `jsonb_typeof = 'array'` 约束（迁移 0035）、
   文档三处与行为对齐（判卷未判定不推进掌握度、策略回滚只回默认值、MCP 与模型
   自选两条路径互斥）。

**仍然存在的已知限制（不是 bug，写进 README）**：策略覆盖同一 (用户, 键) 只保留一条
active 行，所以回滚只能回默认值，历次值只在审计链里；`rerank` 钩子有实现但没有
生产调用方（接真模型时在 `run.ts` 传一行）；掌握度没有独立页面。

## 明确延迟

组织/团队 RBAC、流式输出、真实计费：需要多租户数据模型、SSE 传输层、供应商账单
对账，均超出「单用户自我管理」定位，本轮不做，README 写明理由。
