# Cabinet

> 自我学习与生活的多 Agent 管理台。
> 7 个角色、任务状态机、审批、独立验收、哈希链审计。

![Cabinet Today](public/today.png)

> 截图来自 seed 演示数据。

## 当前状态

可本地运行的 MVP。已经实现的部分集中在任务执行、审批、验收、审计链、记忆和复盘；模型调用可选，外部服务尚未接入。

## 这是什么

Cabinet 把「目标 → 任务 → 执行 → 验收 → 复盘 → 记忆」放进同一套状态机：

- 每个任务有一个执行者和一个验收者；执行者不能验收自己的任务。
- 执行前检查 Agent 状态、自主等级、资源授权、周预算和审批状态；周预算以台账预留的方式在调用模型之前发生。
- 验收使用确定性清单（章节、字数、来源数、关键词，或人工非空项），结果写入任务和运行记录。
- 关键状态变化写入 SHA-256 哈希链，可在 Review 页验证。
- 每日 Check-in 记录精力、情绪、学习时长、回忆正确率和错题标签；每周生成复盘和规则洞察。
- 模型调用可选：每次运行最多一次文本生成；不调用模型时可以使用显式演示模板。

设计假设：个人 Agent 的难点不只是生成内容，还有授权、验收、记忆和复盘。Cabinet 主要处理后者。

## 这不是什么

- **不是多 Agent 自治协作系统。** 一个任务只有一个执行者；Agent 之间没有消息传递、辩论或互相调用。内阁会议的五个立场由规则函数生成，不是五个模型各自研究。
- **不是模型训练系统。** 这里的“学习”指记忆、复盘、技能状态和任务结果，不更新模型权重。
- **不是外部执行器。** 没有网页搜索、日历、邮件、预订或支付连接器；运行记录会写出 `not_connected`。
- **不是语义检索。** 记忆排序使用词面匹配、时间衰减和显著性，不是向量检索。
- **不是面向生产的 SaaS。** 没有计费、团队协作、配额运营或后台任务队列。

## 多 Agent 在这里指什么

不是七个独立进程，而是七个角色记录：

| 组成 | 说明 |
|---|---|
| 角色 | chief / researcher / coach / treasurer / auditor / apprentice / critic |
| 职责 | 写在 `agents.charter` 和 `objective` 里，用于界面展示和模型提示 |
| 权限 | `agent_grants` 决定能读写哪些资源 |
| 记忆范围 | `memory_scope` 决定能检索哪些领域的记忆 |
| 预算 | `budget_cents` 是每周模型用量的上限快照；实际账目在 `agent_budget_periods` / `agent_budget_reservations` |
| 自主等级 | L1–L3，由 `policy_config` 和 `agents.autonomy_level` 决定 |

需要区分“文案”和“运行时”：

- `charter`、`objective`、`tools` 是文本/展示字段。`charter` 会进入模型系统提示，但不是可执行约束。
- 真正生效的是 `status`、`lifecycle_stage`、`autonomy_level`、`agent_grants`、`budget_cents`、`memory_scope`，以及任务的 `assignee_id` / `auditor_id`。
- 相对明确的角色分支是 Coach（下一道学习任务）、Auditor（验收）、Apprentice（考试/转正）；Chief 还会接收内阁决议的跟进任务。其余角色的行为主要出现在内阁规则和界面文案中，没有自动拆解、联网研究、记账或独立批评的运行时逻辑。

## 一次任务怎么走

```
创建任务（用户或 Coach 的学习任务）
  → 指定 assignee + auditor
  → 策略检查：状态 / 等级 / 授权 / 预算 / 审批
  → 运行（可选模型一次生成；或 DEMO_MODE 模板）
  → 产物 + 运行步骤
  → 提交
  → Auditor 按清单验收
  → accepted / rejected
  → done（用户确认或 Check-in 勾选）
```

- 外部动作和花钱：`external_action` / `spend` 会进入审批；批准后仍只执行同一套产物生成，不会真的预订或支付。
- 驳回：执行者的 `reject_streak` 加一；达到阈值（默认 2）自动暂停，恢复由用户操作。
- 通过：Agent 执行者的信任分 +1；驳回 -2。用户自己提交的验收不改变信任分，只有“真实模型运行 + Agent 产物 + 任务已验收”同时成立才计入晋升证据。
- 关键写操作在事务里完成；写请求支持 `Idempotency-Key` 去重。

## 学习循环

```
每日 Check-in
  精力 / 情绪 / 学习分钟 / 回忆正确率 / 错题标签
        ↓
Coach 生成下一道学习任务
  （已有进行中的学习任务时直接复用）
        ↓
用户作答或 Agent 生成 → 提交
        ↓
Auditor 按清单验收（章节 / 字数 / 关键词）
        ↓
目标进度 + 周复盘
        ↓
规则洞察 → 采纳 / 回滚 → 写入记忆
```

- 学习目标进度（默认权重）= 学习任务验收比例 × 0.5 + 最近回忆分 × 0.3 + min(本周打卡次数 / 5, 1) × 0.2；权重和目标打卡数在 `policy_config.learning`。
- 重测：上次学习任务验收通过 ≥ 3 天，且最近 Check-in 有错题标签时，下一题标记为 `learning_retest`。
- 早报和周复盘是确定性模板，不调用模型。
- 反思从审计驳回、晚间完成率、低精力、预算压力和暂停 Agent 中找信号；一次生成一条洞察，可采纳或回滚。

## 机制清单

| 机制 | 当前实现 | 边界 |
|---|---|---|
| 任务状态机 | planned → assigned → running → submitted → auditing → accepted / rejected → done；外部动作走 awaiting_approval | 条件更新 + 409 冲突 |
| 策略门禁 | 状态、生命周期、自主等级、grant、周预算台账、审批 | 阈值来自 `policy_config`，缺失时 fail-closed |
| 审批 | 外部动作 / 超预算进入审批；批准后消费一次 | 不执行真实外部动作 |
| 验收 | 确定性清单：section / min_words / min_sources / contains / manual | 不是模型判断 |
| 分离职责 | 只有 auditor 角色、且不是 assignee，才能验收 | 没有“用户覆盖 Auditor”的入口 |
| 审计链 | 每个用户一条 SHA-256 前向哈希链 | Review 页可验证 |
| 记忆 | 证据、scope、冲突、删除、历史 | 词面匹配，不是向量检索 |
| 学习任务 | 规则生成；重测条件 | 依赖学习目标和 Check-in |
| 反思 | 规则候选 → 洞察 → 采纳/回滚 | 不调用模型 |
| 内阁 | 用户发起；规则生成 5 个立场；批准/有条件批准生成跟进任务，决议写入程序记忆 | 不自动召集 |
| 学徒 | 5 条观摩证据 → 确定性考试 → 练习通过 → 常规审计 | 考试是模板产物；练习通过不等于转正 |
| 模型 | 每次运行一次 `generateText` | 不调用工具；失败不静默回退 |
| 外部工具 | 未接入 | 运行步骤固定 `not_connected` |

## 七个角色

| 角色 | 默认职责（文案） | 当前实际行为 | 边界 |
|---|---|---|---|
| **Atlas** / chief | 计划、派活、早报、主持内阁 | 内阁决议后跟进任务默认分配给它；早报是模板 | 没有自动拆解/派活 |
| **Iris** / researcher | 找资料、验证来源、给反例 | 运行时会按角色选择 `web_search` 工具标签 | 没有联网；标签步骤 `not_connected` |
| **Mira** / coach | 出题、陪练、调难度 | 生成下一道学习任务；读取 Check-in | 出题内容是模型/模板，难度规则来自配置 |
| **Vault** / treasurer | 预算、时间、成本 | 内阁里生成预算立场；反思里报告预算压力 | 没有个人账本/日历；预算是 Agent 运行成本 |
| **Justus** / auditor | 独立验收、周审计 | 按验收清单判定；执行者不能自审 | 不是 LLM 评审 |
| **Pip** / apprentice | 影子学习 → 观摩 → 练习考试 | 需要先记录 5 条 mentor 真实运行作为观摩；考试走常规审计；两次失败退休 | 考试是模拟产物；练习通过不改变信任分与等级 |
| **Cass** / critic | 红队、挑战假设 | 只在内阁里生成反对立场 | 规则驱动，不是独立模型 |

## 页面

| 页面 | 路径 | 回答的问题 |
|---|---|---|
| Today | `/` | 今天有什么事、需要我决定什么 |
| Cabinet | `/cabinet` | 有哪些 Agent、状态/预算/授权如何 |
| Agent 详情 | `/cabinet/[id]` | 这个 Agent 的宪章、绩效、运行、技能、记忆 |
| Task 详情 | `/tasks/[id]` | 验收标准、运行轨迹、产物、审批、审计 |
| Review | `/review` | 本周指标、复盘、洞察、异议、审计日志 |
| Memory | `/memory` | 记住了什么、证据在哪、是否冲突、能否删除 |
| Council | `/council` | 这次高风险决策各方怎么说、怎么定 |
| Review / 审计 | `/review/audit` | 完整审计链，可按动作类型筛选、分页 |
| Settings | `/settings` | 连接器、通知、账号与数据导出/删除（导出为 NDJSON 流） |
| Settings | `/settings` | 部署层开关：连接器、通知 |
| 通知 | `/settings/notifications` | 哪个事件发了邮件、发没发出去、为什么没发 |
| 连接器 | `/settings/connectors` | 检索/模型/邮件配好了没，能否连通 |
| Login | `/login` | 登录 |

## 快速开始

前置：Node 22、pnpm 11、Postgres 18。

```bash
# 1. Postgres
docker compose up -d          # 端口 5433
# DATABASE_URL=postgres://cabinet:cabinet@localhost:5433/cabinet_dev
# 或
brew services start postgresql@18 && createdb cabinet_dev
# DATABASE_URL=postgres://<你的用户名>@localhost:5432/cabinet_dev

# 2. 安装
cp .env.example .env.local
pnpm install
openssl rand -base64 32       # 填入 BETTER_AUTH_SECRET

# 3. 建表 + 演示数据
pnpm db:migrate
ALLOW_DESTRUCTIVE_SEED=true pnpm db:seed

# 或本地迭代：ALLOW_DESTRUCTIVE_SEED=true pnpm db:setup

# 4. 启动
pnpm dev
```

`db:seed` 会清空所有表，只用于本地演示。

### 升级一个已存在的工作区

`policy_config` 里新增的设置项不会单独出一个 migration，而 `getPolicyConfig()` 对缺失的键是 fail-closed：少一个键，Today / Review / Cabinet 全部 500。升级已有数据库（尤其是用 `db:push` 建出来的）后跑一次：

```bash
pnpm db:sync-policy          # 补齐缺失的分组与嵌套设置项
pnpm db:sync-policy --check   # 只检查不改，有 drift 时退出码 1（适合放进部署前置检查）
```

命令只做加法：已存在的值（包括你手改过的）永远保留，因此可以重复执行、也可以对生产执行。

### 模型与演示模式

二选一：

```bash
# A. 不调用模型：使用确定性模板
DEMO_MODE=true
DEMO_LOGIN_ENABLED=true

# B. 调用真实模型
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
DEMO_MODE=false
```

- `DEMO_MODE=true` 时，未配置 Key 或调用失败会退回模板。
- `DEMO_MODE=false` 时，未配置 Key 或调用失败会让任务失败，不会生成模板产物。
- `AUTH_REQUIRED=false` 只用于本地；生产环境会自动要求登录（`NODE_ENV=production`），并应设置 `DEMO_MODE=false`、关闭演示登录和 reset。
- 演示账号：`demo@cabinet.local` / `cabinet-demo`。

## 演示路径

1. **Today**：生成早报，查看目标、任务和待审批。
2. 打开已提交的「设计检索评估练习」→ 运行验收 → 因缺少评分标准被驳回。
3. 执行任务（`DEMO_MODE=true` 时生成模板产物）→ 再次验收 → 通过。
4. **Review**：运行反思 → 采纳或回滚一条洞察。
5. **Council**：打开已有会议，查看 5 个规则立场 → 做出决议。
6. **Cabinet**：暂停/恢复 Agent、修改预算或宪章、调整自主等级（需满足阈值）。
7. **学徒考试**：需要先在学徒详情页记录 5 条 mentor 观摩（seed 只有 1 次可记录），再点“参加考试”。

## 架构

```
RSC 页面 / 客户端组件
  → @/contracts + @/lib/api
  → HTTP（同源；可配 API_BASE_URL）
app/api/**（route handler；当前 45 个，`find src/app -name route.ts | wc -l`）
  → server/readmodels · server/services（queries / commands）
  → domain（纯函数：policy / state / acceptance）
  → Postgres（Drizzle）
```

- 页面和组件不能 import `server/`、`lib/db`；ESLint + `tests/unit/boundary.test.ts` 强制。
- `src/lib` 也不能 import `@/server/*`，**没有豁免**。曾经的唯一例外 `src/lib/engine.ts`（@deprecated 垫片）已删除，调用方直接指向 `@/server/services/engine`；留一个具名豁免等于让「再加一条」成为破坏边界最省事的方式。
- `server/services/engine.ts` 只是 re-export barrel，业务在 `queries/` 和 `commands/`。
- 默认在请求内同步执行；`RUN_EXECUTION=worker` 时改为 `run_jobs` 队列 + `scripts/run-worker.ts` 消费。异步环节还有邮件投递（`outbox` + `pnpm notify:deliver`）和 `pnpm tick` 维护循环；三者都靠部署层调度，不是 web 进程里的定时器。
- 没有使用 LangGraph / CrewAI；状态机和审计是应用代码。
- 连接器与证据的规则见 `docs/evidence-and-connectors.md`，通知见 `docs/notifications.md`。

技术栈：Next.js 16、React 19、TypeScript、Tailwind 4、Postgres + Drizzle、better-auth、Vercel AI SDK（可选）。

## 数据模型（35 张表）

- 账号：`users` `sessions` `accounts` `verifications`
- 工作区：`profiles` `agents` `agent_templates` `agent_grants` `goals` `policy_config`
- 执行：`tasks` `runs` `steps` `artifacts` `approvals` `evidence` `retrieval_calls`
- 记忆：`memories` `insights` `skills` `apprentice_observations` `apprentice_exam_snapshots`
- 治理：`councils` `council_positions` `dissents` `audit_events` `reviews` `checkins`
- 运维：`idempotency_keys` `user_actions` `rate_limits` `outbox` `run_jobs`
- 记账：`agent_budget_periods` `agent_budget_reservations`

状态机：

- Task：`planned → assigned → running → submitted → auditing → accepted / rejected → done`（正常执行路径；外部动作先走 `awaiting_approval`）
- Run：`running → succeeded / failed`（状态机也定义了 `queued`，当前任务运行直接从 `running` 开始）
- Agent：`probation → active → paused → retired`
- Apprentice：`shadowing → drafting → examining → active`；失败一次回 `drafting`，失败两次 `retired`
- Insight：`proposed → applied / rejected`；`applied → rolled_back`
- Approval：`pending → approved / rejected / expired`
- Council：`open → decided`
- Dissent：`pending → vindicated / invalidated`

## 验证

本地门禁和 CI 是同一组步骤，跑一份即可：

```bash
pnpm verify            # 等价于 bash scripts/verify.sh
```

它依次跑 `drizzle-kit migrate`、`tsc --noEmit`、`eslint`、`vitest run --maxWorkers=1 --no-file-parallelism`、`next build`。migrate 这一步在**临时新建的库**上跑，因为长期存在的本地库通常是 `pnpm db:push` 建的、`drizzle.__drizzle_migrations` 是空的，直接 migrate 会在 0000 上撞已存在的对象。

2026-10-25 在当前分支实测：`find tests -name '*.test.ts' | wc -l` = 104 个测试文件，`vitest run` 报 908 passed / 0 failed（76s），typecheck / lint / build 均通过。没有调用真实模型，也没有做浏览器 E2E。数字随提交变化，以命令输出为准，不要照抄。

### GitHub Actions 现在需要手动触发

`.github/workflows/ci.yml` 配了 `push`（`main`、`fix/**`、`feat/**`、`refactor/**`）和 `pull_request`，但**这个仓库的 push 事件从未产生过 workflow run**：从建 workflow 到 2026-10-24 的 `actions/runs` 累计 0 条；推一个空提交（`f818051`）和新建一个 `feat/ci-probe-*` 分支分别推送后仍是 0 条；同一份 workflow 用 `gh workflow run` 手动触发却能跑完 8 个步骤。仓库不是 fork、未归档、未禁用，`actions/permissions` 是 enabled/all，所以问题在触发侧而不是配置侧。

推完要显式触发，否则等于没有门禁：

```bash
gh workflow run ci.yml --ref "$(git branch --show-current)"
gh run watch
```

2026-10-24 手动触发的 run 40052577312 全绿（install / migrate / typecheck / lint / test / build）。

## 已知边界

- **只有检索是真的**：`web_search` 接了 Brave（Tavily 作为可重试的兜底），命中的来源落库为 `evidence` 行，产物必须用 `[cite:evd_x]` 引用它们。日历、预订、支付仍然没有连接器，这些工具步骤会记 `not_connected` 或 `unauthorized`。
- **不是自治多 Agent**：没有 Agent 间消息、协商或自动委派；内阁由用户发起，立场由规则生成。
- **没有用户覆盖 Auditor 的入口**：只有重新提交或按清单重跑；UI/charter 里的“用户可覆盖”目前只是文案。
- **学徒考试是模拟**：考试产物由确定性模板生成；5 条验收项必须全部通过；考试前需要 5 条显式记录的观摩证据（只有 mentor 的真实模型运行、且任务已验收才算）。练习通过只把阶段推进到 `practice_passed`，不授予生产技能、不加信任分、不提等级。
- **反思、早报、周复盘是规则/模板**：不调用模型。
- **记忆检索是词面匹配**：没有 embedding / 向量库。
- **管理时长没有埋点**：`user_actions` 只有 seed 写入；真实工作区会显示估算或空值。
- **成本是估算**：按供应商返回的 token 数和配置单价计算，不是供应商账单；没有返回 usage 的运行记为“用量未知”并保留全额预留。预算是 Agent 的每周模型用量，不是个人财务。
- **台账是唯一账目**：周预算由 `agent_budget_periods` / `agent_budget_reservations` 记账，`runs.cost_cents` 只是逐次运行的遥测，`agents.spent_cents` / `agents.budget_period_start` 已冻结，不再读写。
- **同步执行是默认值**：`RUN_EXECUTION=worker` 才把请求交给 `run_jobs` 队列（`scripts/run-worker.ts` 消费；`FOR UPDATE SKIP LOCKED` 领取、10 分钟租约、最多领取 5 次，见 `src/server/services/commands/tasks/jobs.ts`）。**没有通用重试调度**：重新领取只发生在“租约过期”这一种情况；也没有流式输出，响应是完整 JSON。
- **Agent Card 未签名**：只读 JSON，不是 A2A 实现。

## License

Private MVP。未选择开源许可证。
