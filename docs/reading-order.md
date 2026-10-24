# 读码顺序（10 步，每步都能自己验一次）

> 这份文档只解决一个问题：**接手这个仓库时，按什么顺序读，才不会读到一半就迷路。**
> 每一步都给「读什么」和「怎么证明你读懂了」。证明方式是跑一个已经存在的测试文件，
> 不是看一遍点头——这些测试就是那部分代码的说明书。

前置：`pnpm db:seed` 造演示数据；`pnpm dev` 起本地；命令统一用 `./node_modules/.bin/<tool>`（pnpm 之外的裸工具）。

## 1. 数据长什么样（不要先读业务）

- `src/lib/db/schema/` —— 35 张表按域分文件：`tasks.ts`、`runs.ts`、`agents.ts`、`learning.ts`、`ops.ts` 等；`index.ts` 负责汇总导出。
- 先只看三类列：状态列（`status`）、账本列（`cost_cents`/`tokens_in`）、以及带 `check()` 约束的列。
- 验证：`./node_modules/.bin/psql -d cabinet_dev -c '\d+ tasks'`，能看到 CHECK 约束就说明映射没走形。

## 2. 状态机是唯一真相

- `src/lib/domain/state.ts:17` `TRANSITIONS`、`:98` `canTransition`、`:106` `assertTransition`。
- 关键点：页面能展示什么（`src/lib/domain/task-actions.ts`）与服务端放行什么是两套判断，前者只许更严。
- 验证：`./node_modules/.bin/vitest run tests/unit/state.test.ts tests/unit/task-actions.test.ts`。

## 3. 一次请求怎么进来（横切面）

- `src/app/api/**/route.ts` → `src/lib/api/mutation.ts:76` `handleMutation`（同源、CSRF、限流、幂等、审计、错误兜底全在这条链上）。
- 读它的时候记住一件事：**业务函数不负责这些**，所以每个 route 都只有十几行。
- 验证：`./node_modules/.bin/vitest run tests/integration/csrf.test.ts tests/integration/idempotency.test.ts tests/integration/rate-limit.test.ts`。

## 4. 一条任务的完整生命周期

- `src/app/api/tasks/[id]/run/route.ts` → `src/server/services/commands/tasks/run.ts`（934 行，最长的业务函数，先看 `runTask` 的分支再往里钻）→ `src/server/services/commands/tasks/audit.ts`（审计/验收）→ `src/server/services/commands/tasks/submit.ts`（用户提交）→ `src/server/services/commands/tasks/cancel.ts`（取消）。
- 验证：`./node_modules/.bin/vitest run tests/integration/task-lifecycle.test.ts tests/integration/run-task.test.ts tests/integration/task-cancel.test.ts`。

## 5. 策略闸门：为什么这次运行被拦了

- `src/lib/domain/policy.ts`（608 行）`gate()` 返回 `allow`/`deny`/`approval`；审批消费在 `src/server/services/commands/tasks/approvals.ts`。
- 一个必读细节：**已消费的审批是历史**（`run.ts:88-93` 的注释），失败重试必须重新点头，所以重试会再开一张审批。
- 验证：`./node_modules/.bin/vitest run tests/unit/policy.test.ts tests/unit/policy-approval.test.ts tests/integration/standing-policy.test.ts`。

## 6. 钱和用量怎么记账

- 权威是账本：`agent_budget_periods` / `agent_budget_reservations`（`src/lib/domain/agent-budget.ts` + `src/server/services/commands/tasks/run.ts` 里的预留/结算）；`runs.cost_cents` 只是遥测。
- 读到 `tokens_in = NULL` 不要当成 0：`src/lib/db/schema/runs.ts:19` 写明 `NULL = 用量未知`。
- 验证：`./node_modules/.bin/vitest run tests/integration/agent-budget.test.ts tests/integration/model-usage-accounting.test.ts tests/integration/retrieval-budget.test.ts`。

## 7. 学习闭环（这个仓库最想证明的东西）

- 打卡 `src/server/services/commands/checkins.ts` → 复盘 `src/server/services/commands/reviews.ts` → 下一题 `src/server/services/commands/learning.ts:12` `ensureNextLearningTask`（打卡提交后自动接续，见 `checkins.ts` 事务之后的调用）。
- 记忆与遗忘：`src/server/services/commands/memory/`，进度换算在 `src/lib/domain/learning-progress.ts`、`src/server/services/commands/progress.ts`。
- 验证：`./node_modules/.bin/vitest run tests/integration/learning-loop.test.ts tests/integration/checkin.test.ts tests/integration/reflection.test.ts`。

## 8. 治理：审计链、内阁、学徒

- 审计事件与哈希链：`audit_events` + `src/server/services/commands/tasks/audit.ts`；内阁 `src/server/services/commands/council/`；学徒 `src/server/services/commands/apprentice.ts`（607 行）。
- 验证：`./node_modules/.bin/vitest run tests/integration/autonomy-evidence.test.ts tests/integration/council.test.ts tests/integration/apprentice-graduation.test.ts`。

## 9. 异步面：队列、租约、投递

- `src/server/services/commands/tasks/jobs.ts`（`enqueueRun`/`claimRunJob`/`finishRunJob`，租约 10 分钟）→ `src/server/services/commands/tasks/recovery.ts`（崩溃收尾）→ `scripts/run-worker.ts`（手动跑一轮）。
- 通知投递是**至少一次**：`src/server/services/commands/delivery.ts`，租约过期会重投，写回失败记 `lost`。
- 验证：`./node_modules/.bin/vitest run tests/integration/run-jobs.test.ts tests/integration/run-claim.test.ts tests/integration/outbox.test.ts`。

## 10. 前端怎么只通过契约拿数据

- 路由常量 `src/contracts/routes.ts`，DTO `src/contracts/dto/`，取数 `src/lib/api/pages.ts` / `read.ts`，页面里不出现裸 URL 字符串。
- 验证：`./node_modules/.bin/vitest run tests/integration/page-contracts.test.ts tests/unit/service-boundaries.test.ts tests/unit/page-fetch.test.ts`。

---

## 读完之后该能回答的三件事

1. 一次运行被拦下时，是 `policy.ts` 的哪一条 `deny`，谁消费了审批？
2. 一个 `running` 的任务卡住不动，最终是谁把它收尾的，钱怎么算？
3. 用户打卡之后，下一道学习题是哪段代码建的，为什么会话里不会出现重复题？

三个都答得出，剩下的都是这张图上的叶子。
