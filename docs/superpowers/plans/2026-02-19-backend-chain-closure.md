# 后端链路闭环修复计划（Phase A/B/C）

> 依据：`docs/backend-chain-review.md`（17 条 P1 / 3 条 P0 / 14 条 P2）
> 原则：每项修复必须能被一条测试或一个可复现命令验证；未验证不进 Phase A。

**Goal:** 把审查报告里「链路断在最后一公里」的问题真正接上——先止血（正确性/资损/可恢复），再补结构（调度层、学习闭环），全程不破坏既有语义。

**Architecture:** 不改状态机主干，只在既有事务边界内补齐缺失的一侧（读点、调度方、幂等、锁）。所有新增调度入口收敛到**一个** `tick`，避免再造 6 个无人调用的脚本。

**Tech Stack:** Next 16 / Drizzle / PostgreSQL / Vitest / tsx

---

## Phase A：止血（本次执行）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| A1 | 验收不再谎报「逐条对照通过」：无 checklist 时产出一条 `undetermined` 人工项，reason 明确写"没有验收清单可对照" | `src/server/services/commands/tasks/audit.ts:146-196` | `tests/integration/acceptance.test.ts` 新增用例：checklist 为 null ⇒ acceptanceReport 含 undetermined 且 reason 不含"逐条对照通过" |
| A2 | 验收与提交的竞争：artifact 读取移入事务内、状态翻到 `auditing` 之后；`artifactId` 写入 step 与审计行 | `audit.ts:80-90, 140-205, 376-384` | 审核中 submit 被拒（ConflictError）；审计行 after 含 artifactId |
| A3 | 非学习目标不再被学习公式覆写进度 | `src/server/services/commands/progress.ts:70-88` | `tests/unit/learning.test.ts` 或新增：非 learning domain 目标 progress 不被打卡改变 |
| A4 | 租约时间不再冻结：`CLAIMABLE` 用 `sql`now()``；`attempts` 有上限，超限作业失效而不是无限重试 | `src/server/services/commands/tasks/jobs.ts:35-38,124-160` | `tests/integration/run-jobs.test.ts`：过期租约（真实时钟）可被接管；attempts 超限不再被 claim |
| A5 | 手动投递返回 `lost`，与契约 `lost: z.number()` 一致 | `src/app/api/notifications/run/route.ts:31-41` | route 返回体含 lost；UI 分支可达 |
| A6 | `running` 可取消：cancel 在同一事务里把该任务的活跃 run 结算为 unknown_usage、job 置 failed | `src/lib/domain/task-actions.ts:41-58`、`cancel.ts`、`src/lib/domain/state.ts` | `tests/integration/task-cancel.test.ts`：running 任务可取消；预算预留被结算为 unknown_charged；并发 run 写回不复活 cancelled |
| A7 | **一个 tick 入口**：recoverStaleRuns → expireStaleApprovals → failExhaustedJobs → TTL(rate_limits/idempotency_keys/outbox 归档) → deliverOutbox | 新增 `scripts/tick.ts`、`src/server/jobs/maintenance.ts`；`approvals.ts` 增 `expireStaleApprovals`；`rate-limit.ts`/`idempotency.ts` 增 prune | `pnpm tick` 可重复执行且幂等；过期审批被写 expired；三张表 TTL 生效 |
| A8 | `/api/demo/reset` 双闸（`DEMO_MODE==="true"` 且 `DEMO_RESET_ENABLED==="true"`） | `src/app/api/demo/reset/route.ts:5-14` | `tests/unit/demo-reset.test.ts` 新增用例：DEMO_MODE 未开 ⇒ 404 |

## Phase B：结构性（六项全部结案：5 项落地，1 项取证后判定不做）
1. ✅ **技能与规则进执行**（P1-9/P1-10）：已完成。`src/lib/llm.ts` 拆出纯函数 `composeSystemPrompt/composeUserPrompt/composeEvidenceBlock` 并接受 `skills`/`rules`；`src/lib/domain/execution-context.ts` 提供 `mergeTools/readRules`；`run.ts` 查 `skills.status='active'` 与 `profiles.preferences` 后注入，并把名称+规则记进 context step。工具仍由 `hasGrant` 授权，技能只进候选集。测试 18 passed（`tests/unit/llm-prompt.test.ts`、`tests/unit/execution-context.test.ts`、`tests/integration/run-context.test.ts`）。
2. ✅ **学徒转正**（P1-9）：已完成，落地为 `graduateApprentice`（不是 `promoteApprentice`）：`decideGraduation`+`evaluateGraduation`+`apprentice.practice_passed → active` 边+`/api/apprentice/graduate`+`GraduateButton`，与考试判分区分开（考试只给实践结论，转正另需真实审计样本）。`tests/integration/apprentice-graduation.test.ts` 4 passed。
3. ✅ **重试/回退**（P1-2/P1-3）：已闭环，但**不抽 `rewindTaskForRetry`**（取证后改判）。三条回退语义不同：崩溃恢复要重开被消费的审批（否则 `decideRun` 的 `gate()` 按 `policy.ts:380-393` 直接 deny，运行按钮永久失败）；审批过期无可重开（那行审批是 pending）；用户重试要丢弃已消费的审批（`run.ts:88-93` 显式如此，重试必须重新点头）。合并等于把「重试要不要重新点头」交给共用函数。落地：`approvals.ts` 的 `reopenConsumedApprovalsTx(tx, taskId)` 只服务崩溃恢复；新增契约测试 `tests/integration/run-task.test.ts`「asks for a fresh approval when a failed task is retried」。详见 `docs/backend-chain-review.md` 12.2。
4. ✅ **叙事接调度**（P1-12）：异议判定已完成（tick 第 4 步 `settleDueDissents`，`maintenance.ts`，窗口未到的行自动跳过，单用户失败不影响其余）；**memory decay 仍有意不接** —— `src/lib/memory/decay.ts:10-12` 要求先有 `policy_config` 的 half-life 键，该键不存在，缺的是产品口径。
5. ✅ **预算语义**（P1-6/7/8）：已完成。`maxRunCents` 永远写 hold（0 元 hold 也保留结算路径）；`effectiveLimitCents` 让降额当周生效、提额等下期；`closeExpiredPeriods` 成为 tick 第 5 步（只写 `closedAt`，不清零不删行）。测试 27 passed + tick 12 passed，详见 `docs/backend-chain-review.md` 第 11 节。
6. **demo reset 按用户**（P1-13）：**决定不做**（不是排期）。单租户 demo：`policy_config`、`agent_templates` 等表没有 `user_id` 列，按用户重置要跨 30+ 张表定义「什么算这个用户的数据」，属多租户产品模型变更。P1-13 的双闸（`DEMO_MODE` + `DEMO_RESET_ENABLED`）已挡住误触。理由记录在 `docs/backend-chain-review.md` 12.3。

## Phase C：反模式防回归

- `AGENTS.md` 增三条：不写只读不写的字段；不用字符串匹配表达机制；需要定时器的功能必须同 PR 交付调度方。

---

## 验证

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # 等价 scripts/verify.sh
pnpm tick --once                                          # A7 手动跑一遍
```
