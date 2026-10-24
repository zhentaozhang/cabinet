# Cabinet 修复批次实施计划（Batch A + B + C-安全）

> **For agentic workers:** 每个 Task 由独立 subagent 执行，文件所有权互斥，禁止跨范围修改。

**Goal:** 按 2026-10-24 复核结论，修掉 9 条已证实（A/B 级证据）的缺陷，每条约一个可失败的断言。

**Architecture:** 四路并行，按文件所有权切分互不重叠：格式化层 / 服务端事务与 worker / schema 与迁移 / 出站 SSRF。全部完成后由主控统一跑全量测试并提交。

**Tech Stack:** Next.js 16、React 19、TypeScript、Drizzle ORM（drizzle-kit generate）、vitest、Postgres 18。

---

## 文件所有权矩阵（硬边界）

| 执行者 | 独占文件 |
|---|---|
| SA1 格式化 | `src/lib/format.ts`、`tests/unit/format.test.ts`(新建) |
| SA2 事务/worker | `src/server/services/commands/tasks/execution.ts`、`src/server/services/commands/tasks/approvals.ts`、`scripts/run-worker.ts`、`tests/unit/agent-budget-unit.test.ts`(新建)、`tests/unit/run-worker.test.ts`(新建) |
| SA3 schema | `src/lib/db/schema.ts`、`src/server/services/commands/tasks/jobs.ts`、`drizzle/*`(新迁移)、`scripts/cleanup-orphans.ts`(新建)、`tests/integration/constraints.test.ts`、`tests/integration/run-jobs.test.ts` |
| SA4 SSRF | `src/lib/connectors/page.ts`、`tests/unit/url-safety.test.ts`(新建) |

---

## Task 1 (SA1) — #10 Intl 实例缓存

**Files:** `src/lib/format.ts:96-135`

- [ ] 写失败测试 `tests/unit/format.test.ts`：断言 `shortDate(d,"Asia/Shanghai")` 与 `shortDate(d,"UTC")` 交替调用结果各自正确（防止缓存 key 漏 timeZone 串味）；断言同参数 100 次调用只构造一次 formatter。
- [ ] 加进程级 `Map` 缓存，key 必须含 `style + timeZone`。
- [ ] `vitest run tests/unit/format.test.ts` 通过。

## Task 2 (SA2) — #21 预算周期缺失不得 500

**Files:** `src/server/services/commands/tasks/execution.ts:86-113`

- [ ] 写失败测试：模拟 period 查询返回空 → 断言返回 `{allowed:false, reason:"..."}` 而非抛 TypeError。
- [ ] 在 `.for("update")` 之后加空值守卫，返回明确的 `{allowed:false}`；把 `closedAt` 判断移到使用 period 之前。
- [ ] 不吞掉"本应存在却缺失"的信号：reason 文案要能区分"周期已关闭"与"周期缺失"。

## Task 3 (SA2) — #22 advisory lock 强制事务

**Files:** `src/server/services/commands/tasks/approvals.ts:27-34` + 全部调用点

- [ ] `grep -rn "requestApproval(" src tests` 列出调用点。
- [ ] 把签名改为 `tx: Tx`（必传），删掉 `const client = tx ?? db`。
- [ ] 修复所有调用点；若某调用点确实无事务，为其包一层 `db.transaction`。
- [ ] 写测试：并发两次 requestApproval 只产生一条 pending。

## Task 4 (SA2) — #27 worker 退避与 finish 结果

**Files:** `scripts/run-worker.ts:32-103`

- [ ] `execute()` 检查 `finishRunJob` 返回值；回写 0 行（租约已被回收）时记 `lost-lease` 并返回 `failed`，不得谎报 `executed`。
- [ ] `main()` 改为 catch-and-continue：异常记日志 + 指数退避（1s→上限 30s），连续成功则重置；不再 `process.exit(1)`。
- [ ] `--once` 行为保持：跑干队列后 exit 0。

## Task 5 (SA3) — #12/#14/#20/#5 约束与索引

**Files:** `src/lib/db/schema.ts`、`jobs.ts`、新迁移

- [ ] `checkins.userId` 补 `.references(() => users.id, { onDelete: "cascade" })`。
- [ ] `steps` 加 `uniqueIndex("steps_run_seq_idx").on(t.runId, t.idx)`（名字别用 _idx_idx）。
- [ ] `run_jobs` 加**部分唯一索引**：`(task_id) where status in ('queued','running')`（drizzle 用 `.where(sql\`...\`)`）。
- [ ] `runs` 加 `index("runs_task_created_idx").on(t.taskId, t.createdAt)`。
- [ ] 迁移必须先清历史重复行（DELETE 保留最新一条）再建唯一索引，保证在脏 dev 库上也能 migrate 成功。
- [ ] `jobs.ts:64-73` 的 `onConflictDoNothing()` 改成带 target 的形式。
- [ ] 测试：重复入队只留一行；重复 (runId, idx) 插入被拒。

## Task 6 (SA4) — #1/#2 SSRF

**Files:** `src/lib/connectors/page.ts`

- [ ] 只允许 `http:`/`https:`。
- [ ] 字面量 IP 必须按规范解析后再判私网，覆盖：`0x7f.0.0.1`、`2130706433`、`0177.0.0.1`、`::ffff:127.0.0.1`、`[::1]`、`127.1`、`127.0.0.1.nip.io`（末者走 DNS，应被拒）。
- [ ] DNS 查询加 3s 超时 + 一次重试；**超时仍拒绝**（不得为了消除误杀而 fail open），但要把"解析超时"与"解析到私网"区分成不同错误码。
- [ ] 保留原有 SSRF 防护与注释中的 DNS rebinding 残余风险说明。
- [ ] 测试：8 种 IP 变形全部拒绝；公网域名通过。

---

## 验收（主控统一执行）

```
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint
DATABASE_URL_TEST=postgres://zhentao@localhost:5432/cabinet_test ./node_modules/.bin/vitest run
```

三项全绿才允许提交。任何一条修复若使既有 405 个测试变红，回退该条而不是改测试。

## 不在本轮（Phase 2，需设计）

#3 CLAIMABLE、#4 recovery 心跳、#7 RSC 直调 service、#18 拆 engine 垫片。
否决：#26（判断错误）、#13 索引部分（已满足）、#24（非缺陷）、#8（showReset 过滤已存在）。
