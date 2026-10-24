# Cabinet 后端链路审查报告

审查对象：`/Users/zhentao/Documents/Workspace/Cabinet`（Next 16 + React 19 + Drizzle/PostgreSQL，`src` 约 35,349 行 TS）
审查日期：2026-02-19　｜　方式：只读静态审查（codegraph 索引 + 全量代码通读）+ 同分支修复（第 9–12 节）

> **状态**：第 0–8 节是审查当时（未改代码）的结论，保持原样以便对照；第 9–12 节是随后在同分支的修复落地记录，**第 13–14 节是第二轮复核与改动**（前提改为「本地学习项目、不部署」，并推翻了第一轮的六条结论）。**P0 三条、P1 中 12 条已闭环**，其余每条都有「未做/判断不做」的明确去向（9.2、12.3、14 节末），不存在"看起来做完了"的空白。全量闸门：`bash scripts/verify.sh` **exit 0，104 test files / 907 tests passed**。

---

## 0. 结论摘要

后端不是"没写完"，而是**写得很好但有几条链的最后一公里没有接线**。三类根因，按影响排序：

1. **"只写不读"的落地物**：写了字段/状态/表，却没有消费者 —— `skills.status=active` 无人写、`preferences.rules` 无人读、`reviews.metrics` 无人用、`runs.replayKey` 无人读、`quality_gate` 无人读、`closed_at` 无人写、`user_actions` 无人写。**学习/记忆/内阁这条最能体现产品价值的链，末端全部悬空。**
2. **需要定时器的地方没有定时器**：`recoverStaleRuns`（崩溃恢复）、`deliverOutbox`（邮件投递）、`evaluateDissents`（异议判定）、`decayMemoryScores`（记忆衰减）四个循环全部只有**手工脚本或按钮**入口。仓库内无 `instrumentation.ts`、无 cron/vercel.json/systemd，`docker-compose.yml` 只有 db。
3. **验收没有判据**：`acceptanceChecklist` 默认为 `null` 时，`pass = Boolean(artifact)` —— 有产物就算通过。整台证据校验机器（`min_evidence` / 悬空引用检测 / 主张—来源表）只在 checklist 非空时才启动，而默认路径它为空。

已剔除 3 条子智能体报告的**误报**（见 §8），未采纳。

---

## 1. 后端链路全景

```
POST /api/tasks/:id/run ──┬─ inline（.env.example 默认）──────────┐
                          └─ worker → run_jobs(queued)            │
                                 │ ⊗断点① 无调度方启动 worker      │
                                 ↓ claimRunJob（租约，⊗②时间冻结） │
                                 └──────────────→ runTask ◄───────┘
   runTask (run.ts:52)：
     读 task → retrying 只认 failed/rejected(:59) → resetForRetry(:766)
     → decideRun(policy.ts:306) → 需审批则 requestApproval 并停在 awaiting_approval
     → claimRun 单事务(:202-329)：消费 grant → planned→assigned→running
                                 → 消费审批(条件 UPDATE consumedAt)
                                 → reserveBudget → 插 runs(⊗③ replayKey 无人读)
     → planTools(agent.tools × grants) → web_search/web_fetch(检索预算闸 :432-437)
     → generateArtifact(llm.ts:54，20s abort，只喂 charter/memories/evidence
                        ⊗④ 不喂 skills、不喂 preferences.rules)
     → 单事务(:641-680)：插 artifacts + running→submitted + run succeeded + settleBudget
     → catch(:703-751)：run failed + settle(unknown_usage) + running→failed

submitted ──POST audit──► auditTask(audit.ts:39)
     → 取"最新一条"artifact(:85-90，⊗⑤ 无幂等、无锁)
     → 有 checklist 才 evaluateAcceptance(:98-123)，否则 pass=Boolean(artifact)(:146-149)
     ⊗⑥ 失败回滚为裸 UPDATE auditing→submitted(:28-37)，绕过状态机
accepted ──POST done──► done（终点）
running ──✗ 不可取消（task-actions.ts:41-57）──► 只能靠 run 自己的 catch 或 recovery
                                              ⊗⑦ recoverStaleRuns 仅 scripts/run-worker.ts:103 调用

旁路链路：
  打卡 checkins.ts:139 → recalculateUserGoalProgress 遍历**所有** active 目标(:70-88)
                       ⊗⑧ 用学习公式覆写非学习目标(progress.ts:24-49)
  反思 reflection.ts → evaluateDissents(:57) + 只落 1 条 insight(:276-285)
  内阁决议 → 跟进任务 planned（需手动 run）+ 异议 pending（无人判定）
  连接器测试 readmodels/connectors.ts:96 → 真调用，⊗⑨ 绕预算与 retrieval_calls
  通知 outbox → deliverOutbox（delivery.ts:123）⊗⑩ 无调度方；failed 为终态
```

---

## 2. P0：让"闭环"名不副实的三处

### P0-1　验收判据空转：没有 checklist 时"有产物即通过"
- 证据：`src/server/services/commands/tasks/audit.ts:146-149`
  ```ts
  let pass = Boolean(artifact);
  let reason = pass ? "产物存在，验收标准逐条对照通过。" : "没有找到可验收的产物。";
  ```
  checklist 来源：`src/server/services/commands/tasks/create.ts:139-141` `input.acceptanceChecklist ?? await defaultEvidenceChecklist(...)`；而 `create.ts:62-63` 在「agent 没有 web 工具」或「未配置搜索 provider」时返回 `null`。
- 影响：`.env.example` 默认 `OPENAI_API_KEY` 为空、无搜索 key ⇒ 默认路径 checklist 恒 `null` ⇒ 任意产物（包括 demo 模板）必然 accepted。同时 `src/lib/domain/acceptance.ts:98-123` 的整套证据校验（已落库证据数、`[cite:evd_*]` 悬空引用、主张—来源表）全部不执行。**"验收"退化为"按钮存在"。**
- 修法：`auditTask` 在 `!task.acceptanceChecklist?.length` 时改判 `undetermined`（`acceptance.ts` 已有该语义），强制人工确认而不是自动放行；`createTask` 在无检索能力时降级生成 `min_words`/`section` 清单，而不是返回 null。

### P0-2　提交与验收不幂等：未执行的任务也能通过验收，验收瞬间可换稿
- 证据：`src/server/services/commands/tasks/submit.ts:9` `const SUBMITTABLE = ["planned","assigned","submitted","rejected"]`；`:35-44` 每次调用都 insert 新 artifact；`audit.ts:85-90` 取 `orderBy(desc(artifacts.createdAt)).limit(1)`；`src/lib/db/schema/runs.ts:68-95` 无 `(taskId, runId)` 唯一约束。
- 影响：① `planned`（从未执行）→ submit → audit → accepted 一路可通；② 重复 submit 产生多条 artifact，验收读"最新"，读产物与写 acceptanceReport 不在同一锁内 ⇒ 并发下验收记录与被审内容不对应。
- 修法：`status==="submitted"` 时 submit 幂等返回已有 artifactId；`auditTask` 在事务内 `for("update")` 锁定 artifact 并把 `artifactId` 写进 acceptanceReport。

### P0-3　目标进度被学习公式覆写（数据污染，不是显示问题）
- 证据：`src/server/services/commands/progress.ts:70-88` `recalculateUserGoalProgress` 遍历所有 `status="active"` 目标，**没有 domain 过滤**（`src/lib/db/schema/goals.ts:10` 明明有 `domain` 列）；`:24-31` 任务按 `inArray(tasks.template, ["learning","learning_retest"])` 过滤，非学习目标恒 0 条任务；但 `:33-49` 的 `checkinsThisWeek` 与 `latestRecallScore` 取的是**全用户**数据；`src/lib/domain/learning-progress.ts:11-40` 按 `0.5/0.3/0.2` 加权。
- 影响：一个健康/财务目标，只要用户本周打了 5 次卡、最近回忆分 0.6，就会得到 `0.3×0.6/1.0 = 18%`～`38%` 的"进度"，与该目标本身的工作量毫无关系；`checkins.ts:139` 每次打卡都会重算，`metrics.goalProgress` 与复盘页展示的就是这个值。
- 修法：`recalculateGoalProgress` 首行加 `goal.domain === "learning"` 守卫（非学习目标走各自的度量或置 null），`recalculateUserGoalProgress` 的查询加 `eq(goals.domain,"learning")`。

---

## 3. P1：链路中断且用户可感知

### 执行链路

**P1-1　`running` 无法由人退出，恢复又无调度方 ⇒ 任务永久卡死**
`src/lib/domain/task-actions.ts:41-57` CANCELLABLE 不含 `running`，`:52` 的理由是"正在执行，不能中途取消"；`cancel.ts` 走同一个 `taskActions` 闸门。`recoverStaleRuns`（`recovery.ts:33`）全仓库唯一调用方是 `scripts/run-worker.ts:103`；`/api/health` 只 `countStaleRuns` 读数（`health/route.ts:51`）。`.env.example` 默认 `RUN_EXECUTION=inline` ⇒ 进程被杀后 task/run/预算预留三者永久停在 running/reserved。
修法：cancel 支持 `running`（同一事务改 task + 该 task 的 running run + `settleBudget(unknown_usage)`）；或在 `run/route.ts` 前置跑一次带节流的 `recoverStaleRuns`。

**P1-2　恢复流程把任务退回 planned，但已消费的审批不清 ⇒ 死锁**
`recovery.ts:89-92` 裸 UPDATE 到 `planned`；`run.ts:59` `retrying = failed || rejected`，`run.ts:89-91` 只在 retrying 时清 consumed approval ⇒ 恢复后 `policy.ts:380-393` 返回 `deny("Approval has already been consumed.")`，而 `task-actions.ts:33` RUNNABLE 含 `planned` ⇒ 按钮可点、点了恒失败。
修法：把 `resetForRetry` 抽成 `rewindTaskForRetry(tx, taskId, { clearConsumedApproval })`，recovery 与 run 共用。

**P1-3　状态机被两处裸 UPDATE 绕过，且 `running→planned` 是非法迁移**
`src/lib/domain/state.ts:33` `running: ["submitted","failed"]`，`:13-16` 注释要求所有更新过 `assertTransition`；实际 `recovery.ts:89-92` 写 `running→planned`、`audit.ts:28-37` 写 `auditing→submitted` 都不经过它。`recovery.ts:95-103` 还无条件把该 task 下**所有** running job 置 failed（若期间已有新 job 会被误杀）。

**P1-4　`run_jobs` 的租约时间被冻结，接管实际不生效**
`jobs.ts:35-38`：
```ts
const CLAIMABLE = or(eq(runJobs.status,"queued"),
  and(eq(runJobs.status,"running"), lte(runJobs.leaseUntil, new Date())));
```
模块顶层求值，`new Date()` 在**进程启动时**固化；`claimRunJob` 的 `options.now` 只用于写 `leaseUntil`，不参与挑选。全仓 `heartbeat` 命中 0；`run_jobs.attempts` 只增不读（`jobs.ts:148`）。且 `runTask(taskId, userId)`（`run.ts:52`）不接收也不校验 `claimToken`，只有 `finishRunJob`（`jobs.ts:169-195`）校验 ⇒ 失去租约的 worker 仍在写 run/task。
修法：改 `lte(runJobs.leaseUntil, sql`now()`)`；执行期加 heartbeat 续期；`runTask` 接收并校验 claimToken；`attempts > MAX` 置 failed。

**P1-5　审批过期只在下决定时惰性处理 ⇒ pending 无限累积、待办数虚高**
`approvals.ts:108-158` 只有 `decideApproval` 才写 `expired`；去重查询 `execution.ts:242-252` 过滤掉过期行 ⇒ 过期 pending 对去重不可见，可继续插新行；`queries/today.ts:60-66` 只按 `eq(status,"pending")` 计数 ⇒ "需要你决定 N 个审批" 只增不减。
修法：新增 `expireStaleApprovals(tx)` 在 decide/loadLatest 前统一清扫；today 过滤 `expiresAt > now`。

### 记账 / 预算

**P1-6　`maxRunCents <= 0` 时整条记账链静默失效**
`run.ts:288` `if (config.cost.maxRunCents > 0) { ...reserveBudget... }`：不预留就不会有 settlement ⇒ `settled_cents` 恒 0 ⇒ `decideReservation` 看到的 spent 恒 0 ⇒ 预算闸门恒放行。`src/lib/policy/config.ts:50` 只 `z.number()`，未校验正数（种子值 `policy.ts:150-155` `maxRunCents: 50`）。
修法：config 加 `.int().positive()`；无上限时仍写一条 0 元预留以保留结算路径。

**P1-7　预算周期永不关闭：`closed_at` 是死字段**
只有 `src/lib/db/schema/governance.ts:69` 定义 + `execution.ts:111` 读取（`if (period.closedAt) return deny("该预算周期已关闭。")`），**没有任何写入方** ⇒ 无法关账/冻结某周，超支后除等下周没有人工止损路径。

**P1-8　改 agent 预算当周不生效（快照语义用错地方）**
`queries/budget.ts:144` `limitCents: period.limitCents`（insert 时写入，`execution.ts:68-83`），`updateAgent` 只改 `agents.budgetCents` ⇒ 用户"降额止血"无效，界面无提示。

**P1-9　学徒技能永远无法进入执行，也永远无法转正**
`skills` 在运行时只被**展示**：`queries/apprenticeship.ts:83`、`queries/agent.ts:36`、`queries/cabinet.ts:57`、`account-export.ts:171`；执行侧 `planTools` 只用 `agent.tools × grants`，`llm.ts:54-72` 的 `generateArtifact` 入参只有 charter/task/memories/evidence。全仓没有任何代码写 `skills.status="active"`（`apprentice.ts:54` 插 draft，`:451-470/:502-516` 只改 label/eval/failCount），而仪表盘 `queries/cabinet.ts:78` 统计的是 `["active"]`。
生命周期同理：`src/lib/setup.ts:136-137` 初始化时给内置 agent 写 `"active"`，学徒是 `shadowing`；`apprentice.ts:372/434` 只推进到 `practice_passed`，之后只有 `retired`，而 `policy.ts:327` `if (actor.lifecycleStage !== "active") deny`。
修法：要么实现 `promoteApprentice`（practice_passed→active 并写审计），要么把"技能生效"接到 prompt（把 active skill 的 steps 注入系统提示），否则这条链在产品上不成立。

**P1-10　反思产出的规则没有消费者**
`insights.ts:101-117` 把 `add_rule` 写进 `profiles.preferences.rules`；全仓读取 `preferences` 的只有 `insights.ts:101,183` 自己（去重/回滚）与 `delivery.ts:66` 注释。反思的 5 类候选里 4 类是 `add_rule` ⇒ **"从失败中学习" 学到的东西永远不影响下一次执行**。

**P1-11　反思每次最多落 1 条洞察，且去重按字面比对**
`reflection.ts:276-285`：`for (const candidate of candidates)` 循环体内 `return db.transaction(...)` ⇒ 第一条入库即返回；去重 `eq(insights.claim, candidate.claim)` 而 claim 里内嵌了 `${recentRejects.length}`/`${latestCheckin.energy}`（`:124`/`:194`）⇒ 数字一变就被当成新洞察。reject 不产生抑制。
修法：`dedupe_key`（type+taskId+rule 规范化）唯一索引 + 循环收集后批量插入。

**P1-12　异议判定寄生在"运行反思"按钮上**
`evaluateDissents`（`commands/council/dissent.ts:106`）唯一调用方是 `reflection.ts:57` ⇒ deadline 到期不会判定，`dissents` 长期 pending，只有人点"运行反思"才推进。记忆衰减 `src/lib/memory/decay.ts:42` 更是**零调用方**（文件头注释自述"等有了调度再接"）⇒ salience 冻结，内阁取记忆按 `salience` 排序（`council/context.ts:63-68`）永远拿到同一批。

### 运维 / 交付

**P1-13　`/api/demo/reset` 是全库 TRUNCATE，守卫只有一道环境变量**
`src/app/api/demo/reset/route.ts:6-9`：`NODE_ENV === "production" || DEMO_RESET_ENABLED !== "true"` 才 404；`src/lib/db/seed.ts:112-125`（`wipeDemoTables`）执行 `TRUNCATE TABLE ... users CASCADE`（31 张表，含 `users`/`accounts`/`audit_events`）。鉴权是 fail-closed 的（`src/lib/auth/mode.ts:3-8`），但**开发/预发环境**（`NODE_ENV=development` + `AUTH_REQUIRED` 未设）匿名请求即 `DEMO_USER_ID`（`src/lib/auth/context.ts:33-38`）⇒ 任何能访问该实例的人一键清空整库（随后用 demo 数据重播）。
修法：双闸（`DEMO_MODE==="true"` 且 `DEMO_RESET_ENABLED==="true"`）；`seedDemo` 改成 `seedDemo(userId)` 只删该用户的行。

**P1-14　`rate_limits` 无任何回收路径**
`src/lib/api/rate-limit.ts:18-35` 每次 mutation 写 2 行（`all` 桶 + endpoint 桶）；全仓删除只有 `account.ts:257`（账号删除）与 seed 的 TRUNCATE。理论上限约 2 桶 × 1440 分钟 = 2880 行/用户/天，且写入在每次 mutation 的关键路径上，`window_start` 无索引。

**P1-15　`idempotency_keys` 的 GC 是机会式的**
`src/lib/api/idempotency.ts:96-118`：只有当"同一 (user,key) 再次出现且已过期/失败/abandoned"时才顺带 `delete ... lt(expiresAt, now)`。"一 key 只用一次"这一正常路径永不清理；`expires_at` 无索引。

**P1-16　outbox 的 `failed` 是终态，且投递无调度方**
`delivery.ts:143-146` 的 due 只选 `pending|sending`；`:351-362` `attempts >= MAX_ATTEMPTS` → `status:"failed"`，此后再无任何路径选中它，UI 只有"现在投递一次"（`notify-actions.tsx:126`）。而投递本身只能靠 `pnpm notify:deliver`（`scripts/deliver-outbox.ts`）：仓库无 `instrumentation.ts`、无 cron/vercel.json/systemd，`docker-compose.yml` 只有 db 服务。
修法：加 `requeue` 命令/接口（限定 userId，failed→pending 且 `attempts=0`）；把投递与 TTL 清理一起挂到一个 cron。

**P1-17　手动投递接口丢字段：契约要求 `lost`，实现不返回**
`src/app/api/notifications/run/route.ts:33-41` 的 body 只有 `sent/failed/skipped/deferred/waiting/claimed`；契约 `src/contracts/dto/aggregates.ts:473` `lost: z.number()`；UI `src/components/actions/notify-actions.tsx:143-146` 用 `lost > 0` 提示"被另一进程接手"。`deliverOutbox` 的返回里 `lost` 是有的（`delivery.ts:155`），只是没被透传 ⇒ 租约被抢时，用户看到的是"没有可投递的邮件"，恰恰是产品声称不会出现的谎报。

---

## 4. P2：不影响主链路，但会持续误导维护者

| # | 问题 | 证据 |
|---|---|---|
| 1 | `runs.replayKey` 只写不读，且无唯一约束（"可重放"语义未落地） | 写：`run.ts:317`、`run.ts:835`、`audit.ts:117`、`apprentice.ts:304`；读：仅 DTO `contracts/dto/entities.ts:226` |
| 2 | `runs.providerAttemptId` 注释自称 "unique across retries"，实际只是普通 index，也无去重计费用途 | `schema/runs.ts:25,37`；只读作"是否接触过供应商" |
| 3 | `tasks.quality_gate` 只写不读，audit 用字符串匹配 "评分标准/rubric" 代替它 | `schema/tasks.ts:34`（仅 `seed.ts:626` 写）、`audit.ts:183-196`。**已闭环：第 14 节 D 批删列** |
| 4 | 长期授权"不限次"被静默改成 20 次 | `grants.ts:34-36` 把显式 `null` 归一为 `null`，`:49` `maxRuns ?? 20` 又变回 20；`run.ts:222-223` 按 null=不限次读 |
| 5 | "测试连接"绕过检索预算与 `retrieval_calls` 账本（真实扣费不入账，预算耗尽仍可无限探测） | `readmodels/connectors.ts:96` 直连 `searchWithFallback`；预算闸只在 `run.ts:432-437` |
| 6 | 检索花销与 agent 预算两本账：`retrieval_calls` 是 user 级，不计入 `agent_budget_periods` | `connectors/ledger.ts:19-45` vs `queries/metrics.ts:99-100` |
| 7 | `user_actions` 只读不写 ⇒ metrics 的 "measured" 分支只可能由 seed 触发 | 唯一写入 `seed.ts:1693`（`seedSamples`）；读 `queries/metrics.ts:128-135` |
| 8 | `reviews.metrics` 数字快照无人读（页面数字全走实时计算），且 upsert 覆盖 `createdAt` | 写 `commands/reviews.ts:102,121`；页面 `src/app/review/page.tsx:97` 用 `data.weeklyMetrics`，只消费 `weekly.narrative/period/createdAt/decisions` |
| 9 | demo 产物由标题子串 + 历史运行次数决定（机制硬编码进运行时判断） | `shared/draft.ts`：`taskTitle.includes("评估") \|\| includes("练习")`、`v${priorRuns+1}`、`hasRejection` 决定是否附评分标准 |
| 10 | 审计链检测不到"尾部截断"（删除最后 N 行仍 `ok:true`） | `lib/audit.ts:96-130` 按 seq 升序、prevHash 单向后指，无外部锚点；追加侧并发是安全的（`:48-50` advisory xact lock） |
| 11 | schema 就绪探测只看一张表 | `health/route.ts:36-42` 与 `preflight.ts:49-57` 都只 `select 1 from run_jobs` |
| 12 | `DATABASE_URL` 缺失时回落到硬编码 DSN（env 非 fail-closed） | `lib/db/index.ts:6-8` `?? "postgres://zhentao@localhost:5432/cabinet_dev"` |
| 13 | 声明了但不可达：`NOTIFY_BATCH_SIZE` 从未被读（`delivery.ts:134` 硬编码 20）；`council` 通知 kind 无生产者；`logAudit`/`pendingNotificationsFor` 无调用方；`leaseMs()`/`leaseMsFromEnv()` 重复实现 | 见各引用 |
| 14 | 文档与实现漂移：`deployment.md` 说 health 返回 `checks.demo/auth`（实际在 `warnings`）；`run-durability.md` 说"没有取消"（cancel 已实现）；`notifications.md:40` 说认领用 `FOR UPDATE SKIP LOCKED`（实为条件 UPDATE） | 见各引用 |

---

## 5. 优化建议（按 收益 / 成本 排序）

### A. 立刻做的 6 件（合计 1～2 天，都是小改动大收益）
1. **`audit.ts` 改判定语义**（P0-1）：无 checklist ⇒ `undetermined` 而非 pass。一行判断，消灭"验收形同虚设"。
2. **`jobs.ts:37` 换 `sql`now()``**（P1-4）：挂死接管立刻生效。
3. **`progress.ts` 加 domain 守卫**（P0-3）：3 行，止住目标进度污染。
4. **notifications route 补 `lost`**（P1-17）：1 行，堵住"契约要求但从不返回"这一类漂移。
5. **一个 cron 解决三张表的 TTL**（P1-14/P1-15）：`rate_limits`、`idempotency_keys`、过期 outbox 归档三条 delete + 2 个索引。
6. **cancel 支持 `running`**（P1-1）：一个事务改 task + runs + `settleBudget(unknown_usage)`。

### B. 结构性改造（2～3 周，按价值排序）
1. **补一个真正的调度层**（一次性解决 P1-1/P1-5/P1-12/P1-16 与 decay）：一个 `tick` 入口（`instrumentation.ts` 或独立进程）串起 `recoverStaleRuns → expireStaleApprovals → evaluateDissents → decayMemoryScores → deliverOutbox → TTL 清理`，全部幂等、带节流。目前这 6 个循环各自散落，且只有 3 个有手工脚本。
2. **让"学到的东西"真的进执行**（P1-9/P1-10）：`generateArtifact` 的 system prompt 增加 `active skills` 的 steps 与 `preferences.rules`；`planTools` 的输入加入 skill.tools。这是产品差异化的核心，目前完全空转。
3. **统一"重试/回退"为一个命令**（P1-2/P1-3）：`rewindTaskForRetry(tx, taskId, {clearConsumedApproval, to})`，recovery、run、approval 过期共用，并把 `running→planned`、`auditing→submitted` 补进 `state.ts` 白名单或在函数内显式声明为合法回退。
4. **让 submit 与 audit 一次一致**（P0-2）：`(taskId, runId)` 唯一约束 + audit 内 `for("update")` 锁 artifact + `acceptanceReport` 记录 `artifactId`。
5. **预算语义收敛**：`closed_at` 要么实现关账（`closeExpiredPeriods`），要么删列；`limitCents` 在已有 period 分支重算；`maxRunCents` 校验正数并保留"不限额也记账"路径（P1-6/7/8）。
6. **demo reset 改双闸 + 按用户重置**（P1-13）。

### C. 反模式（值得写进 AGENTS.md 的三条）
- **不要写"只有写没有读"的字段**：本项目已有 6 个（`replayKey`、`provider_attempt_id` 的唯一性、`quality_gate`、`closed_at`、`preferences.rules`、`reviews.metrics`）。建议 CI 加一条"新字段必须在同一 PR 内有读点"的 review 检查。
- **不要用字符串匹配表达机制**（`draft.ts` 的标题子串、`audit.ts` 的 "rubric" 匹配）。`remediation-plan.md` 自己也这么写了，但代码里还留着两处。
- **需要定时器的功能，必须在同一 PR 内交付"谁来跑"**，否则 `scripts/` 里会不断累积"存在但没人调用"的脚本。

---

## 6. 存疑 / 需环境验证（本报告不下结论）

1. **`jobs.ts` 冻结时间的运行时表现**：结论来自"模块顶层 `or()` + drizzle `Param` 保存构造值"的静态推断，未连库实测；注意 `tests/integration/run-jobs.test.ts` 用过去时间构造租约，恰好绕开了这个 bug。
2. **生产是否真的跑 `run:worker` / `notify:deliver`**：仓库内无任何部署描述文件；若运维确有 cron，P1-1/P1-16 的实际后果会显著减轻，但"代码里不成立"仍成立。
3. **inline 模式的请求时长**：`generateArtifact` 有 20s abort，一次模型+检索可能超过平台 route 超时；若被平台切断，P1-1 会更常见。未测。
4. **迁移与 schema 的逐条等价**：只做了表名（35/35）与列名文本比对，索引/CHECK/默认值未逐条核对（未跑 `drizzle-kit`，避免写文件）。
5. **登录是否受限流保护**：`/api/auth/[...all]` 直接交给 better-auth，不经 `handleMutation`，因此不受 `rate_limits` 保护；其内建限流未读配置。
6. **`testConnector` 无 userId 作用域是否有意**：`connectors/test/route.ts:25` 的 handler 丢弃了 userId，任何人可探测全局连接器配置。

---

## 7. 付：已确认"不是问题"的清单（避免下一个人重复怀疑）

- **审计链追加并发安全**：`lib/audit.ts:48-50` 用 `pg_advisory_xact_lock(hashtext(userId))` 串行化，hash+prevHash 在同一事务内写；缺口只在"尾部截断检测"（P2-10）。
- **`deleteAccount` 覆盖完整**：`lib/account.ts:164-261` 单事务内先删子表（预留/证据/职位/技能/授权/产物/run_jobs/evidence/retrieval_calls/steps/runs）再删父表；`exportAccount` 覆盖 26+ 表；未导出 `policy_config`/`agent_templates` 属全局表，合理。
- **预算预留与任务 claim 同事务、且预留先于任何供应商调用**（`run.ts:202-329`）——这是本仓最扎实的一处设计。
- **审批只消费一次**：条件 UPDATE `status='approved' AND consumed_at IS NULL`（`run.ts:272-285`）。
- **工具计划来自 `agent.tools × grants`**，不是角色三元表达式（`run.ts:409-416`）。
- **demo 模式是显式开关**：非 `DEMO_MODE` 时模型缺失直接抛 `ValidationError`，不会被模板草稿掩盖（`run.ts:581-591`）。
- **outbox 认领有 lease + 写回校验 claimToken**（`delivery.ts:143-156, 169-195`），重复投递风险已被处理。
- **`/api/metrics` 需 `OPS_TOKEN` 否则 404、`/api/health` 公开但只暴露 database/schema**（`metrics/route.ts:13-17`、`health/route.ts`）。

---

## 8. 审查方法与覆盖

| 环节 | 覆盖 |
|---|---|
| 代码 | `src` 约 35,349 行 TS 全量；44 个 API route；35 张表；28 个迁移 |
| 手段 | codegraph 索引 + 逐文件通读 + 交叉复核（4 个子智能体分区审查，结论逐条回到源码验证） |
| 剔除的误报 | ①"学徒无代码写 `active`"（`setup.ts:136-137` 会给内置 agent 写 active）；②"`rejectStreak` 永不清零"（`audit.ts:320` 通过时清零）；③"`reviews.metrics` 完全死"（`narrative` 仍在用，死的是数字快照） |
| 未覆盖 | 运行时行为（未连库、未跑 e2e）、前端交互、部署拓扑 |
---

## 9. 修复落地记录（同分支实施，2026-02-19）

> 闸门：`bash scripts/verify.sh`（空库 drizzle migrate → `tsc --noEmit` → `eslint` → `vitest run` → `next build`）。
> 计划文档：`docs/superpowers/plans/2026-02-19-backend-chain-closure.md`。

### 9.1 已闭环

| 发现 | 落地 | 关键实现 | 验证 |
|---|---|---|---|
| **P0-1** 无 checklist 时"逐条对照通过" | `src/server/services/commands/tasks/audit.ts:185-214` | 该分支不再声称逐条对照：仍做 rubric 子串检查，但**必定**往 `acceptanceReport` 写一条 `{type:"manual", undetermined:true}` 人工项，reason 为「本任务没有验收清单，Auditor 只确认了产物存在；「逐条对照」没有发生，需要你人工判定」；初始 reason 从"产物存在，验收标准逐条对照通过。"改为"没有找到可验收的产物。" | `tests/integration/acceptance.test.ts`「says the comparison never happened…」 |
| **P0-2** 验收中途可换稿（锁的部分） | `audit.ts:99-109` | artifact 读取移入事务内、且在 `UPDATE tasks SET status='auditing' … WHERE status='submitted'` 成功之后；submit 只允许 planned/assigned/submitted/rejected，一旦 auditing 就无法再插产物 ⇒ 被审内容 = 被记录内容；审计行 after 增加 `artifactId`（`:408`） | 「refuses a new submission once the task is being audited」 |
| **P0-3** 学习公式覆写非学习目标 | `src/server/services/commands/progress.ts:19,35,105` | 导出 `LEARNING_GOAL_DOMAIN`；守卫放在 `recalculateGoalProgress` **函数内**（`tasks/create.ts`、`tasks/audit.ts` 也直接调它），`recalculateUserGoalProgress` 查询再加 domain 过滤 | `tests/integration/goal-progress-domain.test.ts`（health 目标打卡后仍 42） |
| **P1-1** `running` 无法由人退出 | `src/lib/domain/task-actions.ts:41-52`、`src/server/services/commands/tasks/cancel.ts:69-115`、`src/lib/domain/state.ts` | CANCELLABLE 加 `running`，删掉"正在执行，不能中途取消"；cancel 同一事务：条件 UPDATE task → 该 task 的 running runs 置 failed → 逐个 `settleBudget(unknown_usage)`（途中可能已调供应商，不能退款）→ run_jobs 置 failed 并清 `claimToken`（晚到的 `finishRunJob` 因此被拒）→ 审计记 `cancelledRuns/cancelledJobs` | `tests/integration/task-cancel.test.ts`（含"取消后 provider 迟到返回不复活任务"的真实并发用例） |
| **P1-2** 恢复退回 planned 但审批已消费 ⇒ 按钮永失败 | `src/server/services/commands/tasks/recovery.ts:92-124` | 恢复收尾时把该 task 的
`status='approved' AND consumed_at IS NOT NULL` 审批 `consumedAt` 置回 null（用户给过的授权跟着任务走，重跑仍受它约束而不是被它锁死）；审计 after 记 `approvalReopened` | `tests/integration/run-jobs.test.ts`「reopens the approval the dead run consumed…」（只重开本任务的审批，别的任务已消费审批不动） |
| **P1-3**（部分）恢复用裸 UPDATE 绕过状态机 | `state.ts` + `recovery.ts:92-97` | task 迁移表补 `running → planned`（唯一允许的回退，带注释说明用途），恢复流程改走 `assertTransition` 再条件 UPDATE | `tests/unit/state.test.ts` 25 passed |
| **P1-4** 租约时间被冻结、attempts 只增不读 | `src/server/services/commands/tasks/jobs.ts:50-66,205` | `LEASE_LAPSED = or(isNull(leaseUntil), lte(leaseUntil, sql`now()`))`（数据库时钟在语句执行时求值）；`CLAIMABLE` 加 `attempts < MAX_CLAIM_ATTEMPTS(5)`；`failExhaustedJobs()` 把耗尽作业置 failed 并清 claimToken/leaseUntil；删掉重复的 `leaseMsFromEnv()`；修掉 `lease_until IS NULL` 永不可领的 NULL 比较 | `tests/integration/run-jobs.test.ts`（真实 1200ms 等待后接管、attempts=5 不再被领） |
| **P1-5** 过期审批只在下决定时惰性处理 | `src/server/jobs/maintenance.ts:53-80`、`approvals.ts` `expireApprovalInTx` | 把 `decideApproval` 的过期分支抽成 `expireApprovalInTx`，`expireStaleApprovals` 每行一个事务清扫（坏行不拖垮整批），task 回 planned + `approval.expire` 审计 | `tests/integration/tick.test.ts` |
| **P1-9** 学徒永远无法转正 | `src/lib/domain/policy.ts:620-680`（`decideGraduation`）、`src/server/services/queries/autonomy.ts:87-110`（`evaluateGraduation`）、`src/server/services/commands/apprentice.ts:632-700`（`graduateApprentice`）、`src/app/api/apprentice/graduate/route.ts`、`src/components/actions/agent-actions.tsx` `GraduateButton` | practice_passed 不再只有"退休"一个出口：转正要求**练习之后**的真实审计证据（信任分、成功数、有效样本数、通过率，样本来自 `loadAuditWindow` 的 live run + 被验收产物），通过则置 `lifecycleStage/status='active'`、skills `draft|exam → active/v1`、写 `apprentice.graduated` 审计 | `tests/integration/apprentice-graduation.test.ts`（4 例：未练习通过 / 信任分不足 / 无样本 / 真实证据达标后转正） |
| **P1-13** demo reset 一键清库 | `src/app/api/demo/reset/route.ts` | 双闸 `NODE_ENV!=='production' && DEMO_MODE==='true' && DEMO_RESET_ENABLED==='true'`，否则 404 | `tests/unit/demo-reset.test.ts`（4 例，含"单开 DEMO_RESET_ENABLED 仍 404"） |
| **P1-14/P1-15** 三张表无回收路径 | `maintenance.ts:96-170` | `pruneRateLimits(24h)`、`pruneIdempotencyKeys`、`archiveOldOutbox(只删 sent/skipped、30 天、可按 env 覆盖)`；都带状态谓词、幂等 | `tick.test.ts`（30h 删 / 1h 留；40 天前 sent 删、pending/sending/failed 留） |
| **P1-17** 手动投递丢 `lost` | `src/app/api/notifications/run/route.ts:38-44` | body 补 `lost`（与 `deliveryRunSchema` 的差集只有这一个字段） | `tests/integration/notify-run-route.test.ts` |
| **P1-1/P1-5/P1-14/P1-15** 的共同根因：没人调度 | 新增 `src/server/jobs/maintenance.ts`、`scripts/tick.ts`、`package.json` `"tick"` | 一个入口六步：`recoverStaleRuns → expireStaleApprovals → failExhaustedJobs → pruneRateLimits → pruneIdempotencyKeys → archiveOldOutbox`；每步 try/catch 进报告，只有六步全失败才 exit 1；`deliverOutbox` 故意留在 `pnpm notify:deliver`（发信有独立重试与 dry-run），文档写明串同一行 cron | `tick.test.ts` 9 例 + CLI 端到端（空库六步 ok / DB 不可达 failed:6 exit 1） |

### 9.2 本轮明确未做（仍是开环，按价值排序）

1. ~~P1-9 的另一半：技能与偏好规则从未进入执行~~ —— **已由第 10 节闭环**（只列在此处作历史记录）。原文：**P1-9 的另一半：技能与偏好规则从未进入执行**。`skills` 仍只被展示；`profiles.preferences.rules`（`insights.ts:101-117` 写入）仍无读取方。转正后技能是 `active/v1`，但 `generateArtifact` 的 system prompt 与 `planTools` 都不看它 ⇒ "学徒学到的东西"依旧不影响产出。这是产品差异化的核心，改动跨 `src/lib/llm.ts` 与 `run.ts` 的工具计划，需要单独一轮设计与回归。
2. **P1-6/7/8 预算语义**：`maxRunCents<=0` 时整条记账链仍静默失效；`agent_budget_periods.closed_at` 仍是死字段（无关账路径）；改 agent 预算当周仍不生效（`limitCents` 快照）。
3. **P1-10/P1-11 反思**：`add_rule` 无消费者；反思每次最多落 1 条洞察（循环体内 return），去重按含动态数字的字面 claim 比对。
4. ~~P1-12 异议判定~~ —— **异议部分已由第 10 节闭环**（tick 第 4 步 `settleDueDissents`）；**记忆衰减仍有意不接**：`src/lib/memory/decay.ts:10-12` 自己写明"先有 `policy_config` 的留存/half-life 配置，再接调度"，而该键至今不存在——缺的是产品口径，不是代码。
5. **P1-16 outbox `failed` 是终态**：没有 requeue 命令/接口，`MAX_ATTEMPTS` 用尽后只能等运维改库。
6. **P0-2 的另一半**：`(taskId, runId)` 唯一约束与 submit 幂等未做（需要迁移，本轮不动 schema）；submit 仍可为从未执行的任务造产物。
7. **P1-13 的另一半**：`seedDemo()` 仍 TRUNCATE 全库，按用户重置（`seedDemo(userId)`）未做 —— **判定不做**，理由见 12.3（单租户模型的表没有 `user_id` 列）。
8. **P1-3 的剩余部分**：`audit.ts` 的 `auditing → submitted` 仍是裸 UPDATE（复审失败路径），未进迁移表。
9. **P2 的 14 条未动**（`replayKey`/`provider_attempt_id`/`quality_gate`/`closed_at` 只写不读、demo 产物用标题子串、审计链尾部截断、`DATABASE_URL` 缺省回落硬编码 DSN 等）。
10. **运维契约仍是文档而非配置**：仓库里依然没有 cron/systemd/vercel 配置 —— tick、`notify:deliver`、`run:worker` 都需要有人挂上，"代码存在"到"真的会跑"之间还差部署这一步。
11. ~~**缺索引（已知成本）**~~ —— **已由 12.1 闭环**：三条 TTL 删除谓词（`rate_limits(window_start)`、`idempotency_keys(expires_at)`、`outbox(status, created_at)`）的索引在 `src/lib/db/schema/ops.ts` + 迁移 `drizzle/0028_mushy_thunderbird.sql` 里补齐。

### 9.3 修复引入的新风险（如实记录）

- **tick 让 `recoverStaleRuns` 真的会跑**：这是 P1-1 的根本解，但也把 P1-2 从"理论死锁"变成"每周都会踩到"。9.1 里已一并修掉（重开审批），并用测试锁住；后续任何"恢复后重跑"的改动都必须保持这条。
- **取消按 `unknown_usage` 记满 `maxRunCents`**：即便这一轮部分用量精确可得，也按未知记账。取舍是"宁可多记不可白跑"，代价是精确成本丢失（`cancel.ts:73`）。
- **`run.ts` catch 路径的 runs 写回只有 `eq(runs.id, runId)`**：取消后跑到一半的 run 会把 `error` 从"任务被取消。"覆盖成"Task is not running anymore."，并多一条 `task.run.failed` 审计。状态仍是 failed，只是文案与审计多一行（未改 `run.ts`，保持条件写回的最小改动面）。
- **tick 的各步用 Node 时钟写 `finishedAt/decidedAt`**：租约/耗尽的**筛选**仍是数据库 `now()`，但多实例时钟漂移会让这些时间戳有秒级偏差。
- **`expireStaleApprovals` 每轮上限 1000 行**（`SWEEP_BATCH`）：积压需多轮排空，最终一致但非一次清空。

### 9.4 存疑项的处置

- 第 6 节第 1 条（`jobs.ts` 冻结时间是否真的影响运行时）已由实测闭环：`tests/integration/run-jobs.test.ts`「takes over a job whose lease ran out while this process was alive」在真实 1200ms 等待后接管成功；把 `LEASE_LAPSED` 临时还原成模块级 `new Date()` 快照后该用例失败，证明它抓得住这个 bug。
- 第 6 节第 2 条（生产是否真跑 worker/notify）依然无法从仓库确认，且 tick 又加了一个"需要有人挂"的入口 —— 见 9.2 第 10 条。

## 10. 第二批次：把「学到的」接回执行（同分支，2026-02-19）

第 9 节收掉的是"链路断在收尾处"，这一批收的是**链路断在入口处**：系统能积累技能、能记录用户的长期要求、能写下异议，但**没有任何东西在执行时读它们**。写得多、读得少，是这个项目最本质的一处不对称。

### 10.1 技能与用户规则第一次进入 prompt（闭环 P1-9 另一半、P1-10 的 `add_rule`）

改造前的事实（第 2 节 P1-9 已记录）：`skills` 表只有展示用途；`profiles.preferences.rules`（`src/server/services/commands/insights.ts:101-117` 写入）全仓无读取方；`generateArtifact` 的 system prompt 由 agent 的 role/charter 拼成，与"学徒学到了什么""用户要求过什么"完全无关。于是"学徒通过练习→技能 v1 激活→接单"这条链路的后半段是空的：技能激活了，产出没有任何变化。

改法是把 prompt 组装从"内联字符串拼接"变成**可测的纯函数**，再把上下文喂进去：

| 位置 | 改动 |
|---|---|
| `src/lib/llm.ts` | 导出 `PromptInput`（含 `skills?: ExecutionSkill[]`、`rules?: string[]`）与 `composeSystemPrompt` / `composeUserPrompt` / `composeEvidenceBlock` 三个纯函数；`generateArtifact` 只负责调它们 + 拿 API key。规则块紧跟宪章（标题「用户的长期要求（与宪章冲突时以这里为准）：」），技能块在格式要求之后（标题「你已通过考核的技能（按步骤执行，步骤顺序就是流程）：」），步骤渲染成 `- 名称：1) … 2) …`；`steps` 为空的技能整条跳过 |
| `src/lib/domain/execution-context.ts`（新） | `mergeTools(declared, extra)`：保序去重、declared 优先；`readRules(preferences)`：非对象/非数组返回 `[]`，过滤非 string 与空白 |
| `src/server/services/commands/tasks/run.ts` | 查 `skills.status='active' AND agentId=agent.id` 与 `profiles.preferences`；`planTools({ tools: mergeTools(agent.tools, activeSkills.flatMap(s => s.tools)) })`；`generateArtifact` 传 `skills`/`rules`；context step 的 output 增 `skills`（名称数组）与 `rules` —— 产物可以追溯到"它是按哪条流程、遵守哪条要求写的" |

**权限边界没有被削弱**：技能可以带工具名进 `planTools` 的候选集，但能否真正调用仍由 `hasGrant` 决定——技能是"该做什么"的知识，不是"能做什么"的授权。这一点有测试锁住（`tests/integration/run-context.test.ts`：`agents.tools=[]` 时技能带来的 `read_notes` 能被计划接受，但授予判断独立）。

测试：`tests/unit/llm-prompt.test.ts` 8 例（含"无技能无规则时 prompt 与旧版逐字一致"这一回归锚点）、`tests/unit/execution-context.test.ts` 6 例、`tests/integration/run-context.test.ts` 4 例（`vi.mock("@/lib/llm")` 捕获入参，断言 active 技能步骤与 seed 里的规则 `讲解先给例子，再给定义` **确实出现在真实调用的入参里**，draft 技能不出现）。共 18 passed。

### 10.2 异议判定挂进 tick（闭环 P1-12 前半）

`evaluateDissents` 之前只有 `/api/reflect` 一个入口：用户不点复盘，写下的"我预测这周会失败"就永远 `pending`——异议是**对未来的赌注**，赌注不结算就等于没有。现在它是 tick 的第 4 步 `settleDueDissents`（`src/server/jobs/maintenance.ts`）：按 `dissents.status='pending'` 分组 user，逐个调 `evaluateDissents(userId)`（窗口未到的行由它自己跳过，天然幂等），单用户异常只计入 `failed` 而不中断其余用户和后续六步。

**记忆衰减仍不接，且这是有意的**：`src/lib/memory/decay.ts:10-12` 自己写着"先有 `policy_config` 的留存/half-life 配置，再接调度"，而 `policy_config` 至今没有这个键。给它编一个常量半衰期，等于把产品决策藏进代码——这类"看起来补齐了"的缺口比明写的缺口更贵。缺的是口径，不是管道；管道已经通过 `settleDueDissents` 证明存在。

### 10.3 结构性观察（写在这里，因为它是前两批改动的共同成因）

三次闭环（验收、取消、技能/规则）暴露的是同一种形状：**写入端很积极，读取端没人负责**。`add_rule` 写规则→没人读；练习通过写 `lifecycleStage`→没人接；`decideUpgrade` 要求"转正考核"→没人能做；`evaluateDissents` 能判→只有一个手工入口；维护函数写好了→没有调度器。所以本轮之后仍有开环（9.2 剩余 9 条），判断它们的共同标准是：**这个字段/函数，在用户可见的行为里，有且只有一个读取方吗？如果没有，它就是下一个"写得多读得少"。**（`AGENTS.md` 的三条反模式即由此而来。）

## 11. 第三批次：预算账本的三个洞（同分支，2026-02-19）

预算这块原本的形态很典型：**账本设计得比使用它的地方更完整**。`agent_budget_periods` 有一整套 `reserved/settled/unknown/overrun` 字段和一段"这张表，而不是 `runs.cost_cents`，才是准入唯一权威"的注释，但三个入口各自漏了一条腿。

### 11.1 P1-6：`maxRunCents: 0` 时整条记账链静默失效

`src/server/services/commands/tasks/run.ts:291` 原来是 `if (config.cost.maxRunCents > 0) { reserveBudget(...) }`：不预留 → 没有 reservation 行 → `settleBudget` 找不到它 → `settled_cents` 恒 0 → 下一次准入读到空周期 → 恒放行。**没有任何报错，只是账本从此不记账**，而 schema（`src/lib/policy/config.ts:62`）明确允许 0。

三处一起修：

| 位置 | 改动 |
|---|---|
| `src/server/services/commands/tasks/run.ts:290-313` | **永远**写一条 hold，金额 `Math.max(0, config.cost.maxRunCents)`。0 元 hold 不改变"单次不设上限"的产品语义，但保留结算路径：结算把真实成本写进 `settled_cents` |
| `src/lib/domain/agent-budget.ts:75-92` | `decideReservation` 的 `amountCents <= 0` 分支原本无条件 `allowed`：金额为 0 时的比较永远成立，等于**闸门不存在**。改成"金额为 0 时不设上限，但本周必须还有余量"，余量为 0 即拒（`本周预算已用完，需等到下一个预算周期。`） |
| `src/lib/policy/config.ts:62-65` | `.nonnegative()` → `.int().nonnegative()`，并把"0 = 不设单次上限但照常记账"写成注释；**不加 `.positive()`**：`getPolicyConfig` 是 fail-closed（`config.ts:143-150` 解析失败直接抛），把 0 判非法会让一个存量配置当场把整个应用读崩 |

### 11.2 P1-8：改 Agent 预算当周不生效

`limitCents` 在建桶时写一次（`queries/budget.ts:107-121`、`execution.ts:68-83`），之后 `updateAgent` 只改 `agents.budget_cents` ⇒ "把这个 Agent 的额度降下来止血"要等到下周一。这是**快照语义用错方向**：快照该防的是"历史被改写"，不该防"今天的止损"。

修法是给出一个有方向的语义，而不是简单地"每次重算"：

```ts
// src/lib/domain/agent-budget.ts
export function effectiveLimitCents(storedLimitCents, agentBudgetCents, weeklyLimitCents) {
  return Math.min(storedLimitCents, periodLimitCents(agentBudgetCents, weeklyLimitCents));
}
```

- **降额：立即生效**（本周就用新价），因为这是运维止损动作；
- **提额：下期生效**（`min` 不会被抬高），因为已经发生的超支不该在周中被"重新定义成没超"；
- 周上限（`policy_config.budget.weeklyLimitCents`）收紧同理立即生效；
- 读取侧（`queries/budget.ts:138-152` 的 `limitCents`）与准入侧（`execution.ts:115-124` 的 `decideReservation`）都走同一个函数——**界面上显示的额度就是准入实际使用的额度**，这条一致性最容易在日后被破坏，值得用测试钉住。

### 11.3 P1-7：`closed_at` 从死字段变成"周结束了"

`agent_budget_periods.closed_at` 只被 `execution.ts:111` 读（`该预算周期已关闭。`），**没有任何写入方**。所以"这周多少钱算完了"从来没有答案，也没有冻结某一周的人工手段。

现在它是 tick 的第 5 步 `closeExpiredPeriods`（`src/server/jobs/maintenance.ts`）：`period_end <= now AND closed_at IS NULL` → 写 `closed_at`。**只写时间戳，不清零、不删除**：周期行是对账依据，冻结 ≠ 销毁。幂等（第二轮 0 行），且与准入路径的读取形成闭环：上一周的桶关闭后，任何试图往里预留的路径都会拿到明确的"已关闭"，而不是"找不到周期"。

### 11.4 现在的 tick（八步）

`recoverStaleRuns → expireStaleApprovals → failExhaustedJobs → settleDueDissents → closeExpiredPeriods → pruneRateLimits → pruneIdempotencyKeys → archiveOldOutbox`（`docs/run-durability.md` 已同步：八步、八个 0、`closeExpiredPeriods` 是唯一不删行的清扫）。

### 11.5 测试

| 文件 | 覆盖 |
|---|---|
| `tests/unit/agent-budget.test.ts` | `effectiveLimitCents` 三向语义（降额立即 / 提额等下一期 / 收紧周上限立即）+ 0 元准入在余量为 0 时拒绝、余量 > 0 时放行 |
| `tests/integration/agent-budget.test.ts` | ①`maxRunCents: 0` 时仍写 0 元 hold 并把 0.8c 实测成本结算进 `settled_cents`（改前此用例拿不到 reservation 行）；②把 `agents.budget_cents` 降到 100 后 `loadWeeklyUsage` 立刻报 100、下一次 50c 预留被拒（reason 含 `0c`）、调回 9000 后本周仍是 1200 |
| `tests/integration/tick.test.ts` | `closeExpiredPeriods` 只关过去那一周、本周期 `closedAt` 为 null、已关闭行的 `settledCents` 不清零、第二轮返回 0、步骤名在 `tickSteps()` 里 |

合计新增 9 例（unit 4 / budget 集成 2 / tick 1 + 既有断言），全量闸门结果见第 9 节开头与本次提交说明。

## 12. 第四批次：索引、以及「统一回退」这条建议被自己的取证推翻（同分支，2026-02-19）

### 12.1 TTL 清扫的删除谓词一直没索引（9.2 里的成本项）

tick 里有三个清扫函数按时间删除旧行，而 0027 之前的索引一个都服务不了它们的 `WHERE`：

| 清扫 | 谓词 | 原有索引为何用不上 |
|---|---|---|
| `pruneRateLimits` | `window_start < cutoff`（全用户） | `rate_limit_unique_idx` 是 `(user_id, action, window_start)`，前导列是 `user_id`，按窗口删只能顺扫 |
| `pruneIdempotencyKeys` | `expires_at < now` | 只有 `idempotency_user_key_idx` `(user_id, key)` |
| `archiveOldOutbox` | `status IN ('sent','skipped') AND created_at < cutoff` | `outbox_due_idx` 是 `(status, next_attempt_at)`；`outbox_user_created_idx` 前导列是 `user_id` |

修法：`src/lib/db/schema/ops.ts` 加三条索引（`idempotency_expires_idx`、`rate_limit_window_idx`、`outbox_status_created_idx`），`drizzle/0028_mushy_thunderbird.sql` 就是这三条 `CREATE INDEX`。

**没有做的事**：没有给这些删除加 `LIMIT` / 分批。删除是幂等的、下一轮接着删；在不掌握表规模时先定批大小，等于用猜测换回滚复杂度。留到 `rate_limits` 真的到千万行时再说。

### 12.2 P1-3「三处回退各自实现」：取证后判定为「有意不同」，不统一

计划里的 B3 原本是抽出 `rewindTaskForRetry` 把三条回退路径合成一个。动手前逐条读了一遍，结论是**这三处不是同一个操作**，合并会把差异抹平：

| 路径 | 位置 | 从哪回到 `planned` | 被消费的审批怎么办 |
|---|---|---|---|
| 崩溃恢复 | `src/server/services/commands/tasks/recovery.ts:92-119` | `running`（`assertTransition("task","running","planned")`） | **重开**（`consumedAt` 置 null） |
| 审批过期 | `src/server/services/commands/tasks/approvals.ts:138-152` | `awaiting_approval` | 无可重开：这行审批是 `pending`，从没被消费 |
| 用户重试 | `src/server/services/commands/tasks/run.ts:810-836` | `failed` / `rejected` | **丢弃**：`run.ts:88-93` 明确写「已消费的审批是历史」，重试要重新点头，`awaitApproval` 开一张新审批 |

三条路径对同一件事（一张被消费的审批）给出三个不同答案，而每个答案都对，**因为它们的语义不同**：崩溃是系统替用户把状态推回去（若把 `consumedAt` 留着，`decideRun` 的 `gate()` 会按 `src/lib/domain/policy.ts:380-393` 直接 `deny("Approval has already been consumed.")`，运行按钮从此永久失败）；重试是人主动再点一次；过期是那条审批从未生效。统一它们，等于把「重试要不要重新点头」这个安全语义交给一个共用函数去决定。

所以只做了一件事：把「重开被消费的审批」抽成 `reopenConsumedApprovalsTx(tx, taskId)`（`src/server/services/commands/tasks/approvals.ts`），只被崩溃恢复使用。价值不是复用，而是把「为什么重开」写在一个有名字的地方。

**同时补了一个契约测试**（`tests/integration/run-task.test.ts`：「asks for a fresh approval when a failed task is retried」）：断言重试**不会**继承已消费的审批，而是重新停在 `awaiting_approval` 并新开一张审批。这条行为此前没有任何测试锁住——一旦有人「顺手」让重试继承旧审批，也不会有测试红。

### 12.3 剩余未做（明确记录，不留「看起来做完了」）

| 项 | 为什么不现在做 |
|---|---|
| `seedDemo(userId)`（9.2） | 单租户 demo：`policy_config`、`agent_templates` 等表根本没有 `user_id` 列，按用户重置要跨 30+ 张表定义「什么算这个用户的数据」，属于多租户产品模型变更，不是链路修复。P1-13 的双闸（`DEMO_MODE` + `DEMO_RESET_ENABLED`）已经挡住误触 |
| 记忆衰减挂 tick | 缺的是产品口径（`policy_config` 无 half-life 键），见 10.2 |
| 反思只产出 1 条 insight、按 claim 字面去重 | 提取策略问题；改成「多条 + 语义去重」需要模型侧可测口径，先留在 9.2 |
| `outbox` 失败行没有终态 | ~~现在靠 `attempts` / `nextAttemptAt` 无限退避~~ **本条已在 13.6 推翻**：`MAX_ATTEMPTS` 耗尽即写 `failed` 终态，且不会被重新认领 |
| 8 条 `/api/*` 不在 `src/contracts/routes.ts` | **已部分完成（14 节 A 批次）**：5 条页面路由已进常量表；剩 `/api/auth/*`、`/api/health`、`/api/metrics` 三条运维入口，不是页面契约，判定不做 |




## 13. 第二轮复核：六条「未闭环」被证据推翻（2026-02-19）

前提变了：**这是本地学习项目，不部署、单进程运行。** 重新按「假语义 / 能否亲手验证 / 认知负担」三条判据过了一遍，
逐条去代码里取证之后，第一轮列出的问题里有六条站不住。这一节把它们记下来，因为**「我以为断了、其实没断」和「真的断了」一样需要留证**。

| # | 第一轮的说法 | 取证结果 | 处置 |
|---|---|---|---|
| 1 | `jobs.ts` 里 `leaseMs` 与 `leaseMsFromEnv` 两份重复实现 | 现在只有一份 `leaseMs()`（`src/server/services/commands/tasks/jobs.ts:30-35`，读 `RUN_LEASE_MINUTES`，回退 `DEFAULT_LEASE_MS`）；`CLAIMABLE` 也已改用 `sql`now()`` 而不是模块顶层的 `new Date()`（:53-59） | 计划作废，不删 |
| 2 | `/api/notifications/run` 返回体缺 `lost` | 已返回 `lost: report.lost`（`src/app/api/notifications/run/route.ts`，注释指向 `deliveryRunSchema`） | 计划作废 |
| 3 | `user_actions` 只被读、没有写入方 | 有写入方：`src/lib/db/seed.ts:1693`（`seedSamples`）的 demo 种子（`ua_seed_1/2/3`），`tests/integration/metrics-samples.test.ts:128` 也直接插。`git grep 'insert(userActions)'` 只命中这两处 | **不删表**。真实性质是「demo-only producer」：不跑 seed 的工作区里管理时间会静默退回估算。这条留在文档里，不靠删代码解决 |
| 4 | `reviews.metrics` 是死列 | 有数据、无读方：`src/server/services/queries/review.ts:46-51` 整行取出、:138 返回页面，页面只读 `decisions/narrative/period/createdAt`。但它冻结的是**生成当时**的数字（`weeklyMetrics` 是实时重算的） | 保留，定位为「有意义的快照，暂无读方」 |
| 5 | `artifacts` 该加 (taskId, runId) 唯一索引 | 约束不到真正的重复：`src/server/services/commands/tasks/submit.ts:33-44` 用户提交时写 `runId: null`，重复提交本来就该多插一行（版本历史语义） | 不建。「一次运行一个产物」是当前实现的副产品，不是要固化的不变量 |
| 6 | `outbox` 失败行没有终态（12.3 第 4 行） | 有终态：`MAX_ATTEMPTS` 耗尽后写 `status: "failed"`（`src/server/services/commands/delivery.ts:350-372`），而认领只取 `pending`/`sending`（:144-145），所以 `failed` 不会再被重试。`archiveOldOutbox` 只删 `sent`/`skipped` 是**刻意**的（`src/server/jobs/maintenance.ts:150-152` 注释：失败行是「地址为什么不再可用」的记录），且有读方：`src/app/api/metrics/route.ts:42` 按状态分组、`src/server/services/queries/delivery.ts:31` 给设置页列表 | 12.3 该行作废；失败行不再是缺口 |

结论：第一轮报告的**方向**（最后一公里没接线）在契约与学习链上成立，但具体清单里有一半是「我读得快了」。第 9–12 节的修复不受影响，这一节只是把不再成立的说法收回。

## 14. 第二轮实际改动

| 批次 | 改动 | 落点 |
|---|---|---|
| A 契约收口 | 5 条路由进常量表，组件不再拼字符串 | `src/contracts/routes.ts`（`taskSubmit`/`taskDone`/`learningNextTask`/`reviewsWeekly`/`shell`）；调用点 `src/components/actions/task-actions.tsx:116,536`、`utility-buttons.tsx:75`、`learning-actions.tsx:18`、`src/lib/api/pages.ts:162` |
| B 学习链最后一跳 | 打卡提交后自动接续下一道学习题 | `src/server/services/commands/checkins.ts` 在**事务提交之后**调 `ensureNextLearningTask`，且只吞 `ValidationError`（没有学习目标的用户不该因为打卡失败）；测试 `tests/integration/learning-loop.test.ts` 加「无目标也能打卡」用例 |
| D 假语义清理 | 删掉零读方的 `tasks.quality_gate`；`runs.replay_key` 更名 `run_label`（注释本来就写「它是一次尝试的编号，不是回放句柄」） | `src/lib/db/schema/tasks.ts`、`src/lib/db/schema/runs.ts:28`、`src/lib/db/seed.ts`、`src/contracts/dto/entities.ts`、`src/app/tasks/[id]/page.tsx`；迁移 `drizzle/0029_drop_quality_gate.sql`、`drizzle/0030_rename_replay_key.sql`（手写 `ALTER TABLE ... RENAME COLUMN` + 对齐快照，因此不丢数据；`drizzle-kit generate` 再跑一次输出 `No schema changes`） |
| F 种子可读性 | `seedDemo`（原 1696 行单函数）按域拆成 12 个 `async function`，`seedDemo` 只剩调用链；插入顺序、字段值一字未改（diff 只有函数边界与注释） | `src/lib/db/seed.ts`：`wipeDemoTables` / `seedAccount` / `seedPolicyAndAgents(weekStart)` / `seedGoalsAndTasks` / `seedRuns` / `seedBudgetPeriods(weekStart)` / `seedRunDetails` / `seedMemoryLayer(now)` / `seedGovernance` / `seedCouncil` / `seedSamples` / `markDemoFixtures` |
| E 文档对齐 | 三篇「描述永不发生场景」的文档加适用范围横幅；新增读码路径 | `docs/deployment.md`、`docs/run-durability.md`、`docs/frontend-backend-separation.md`；新增 `docs/reading-order.md`（10 步，每步配可跑的测试文件） |

验证：`tsc --noEmit` 与 `eslint --max-warnings=0` 均 exit 0；隔离库 `cabinet_rename`（`drizzle-kit migrate` 全量迁移）上跑 `setup`/`apprentice-graduation`/`apprentice-autonomy-audit`/`metrics-samples`/`learning-loop` 共 **26 passed**。F 批单独验证：隔离库 `cabinet_seed` 上全量 **104 files / 908 tests passed**，随后 `bash scripts/verify.sh` 整体 exit 0（含 `next build`）。

**仍未做（明确保留）**：`/api/auth/*`、`/api/health`、`/api/metrics` 三条运维入口不进 `routes.ts`（它们不是页面调用的契约）。
