# Cabinet

> **一个可管理的自学习个人 Agent 组织。**
> 用每天 3 分钟，管理一支会学习、可审计、能逐步获得授权的 Agent 团队。

![Cabinet Today](public/today.png)

---

## 为什么做这个

2023–2025，大家竞争的是「Agent 能不能做」。
2026 之后，竞争的是「人敢不敢让 Agent 做」。

后者不是模型问题，是**管理、信任和授权**问题。

市面上的个人 AI 大多是一个更聪明的对话框；Cabinet 做的是另一件事：

> 不是替你聊得更好，而是让你像管理者一样，给目标、看证据、做审批、复盘、逐步放权。

---

## 三个核心机制

### 1. 自主阶梯（Autonomy Ladder）

| 级别 | Agent 能做什么 | 用户做什么 | 解锁条件 |
|---|---|---|---|
| L1 | 提计划 / 草稿 | 每个动作确认 | 默认 |
| L2 | 内部动作自动，外部动作要批 | 审批 | 基础权限 + 3 次验收通过 |
| L3 | 宪章内自主，事后报告 | 看早报 + 例外 | 信任分 ≥70 + 审计通过率 ≥90% |
| L4 | 主动发现目标、提案、执行 | 设边界 | 不在 MVP |

升级必须由用户确认；连续驳回达到阈值会自动暂停，需重新评估后才能恢复。

### 2. 分权验收（Separation of Duties）

- 执行者提交产物 + 自评
- Auditor 按验收标准独立检查，可以**驳回**
- Chief 不能推翻 Auditor；只有用户能覆盖，且必须留理由
- 连续驳回达到阈值（`policy_config`，默认 2）→ 自动暂停并进入评估
- 关键状态迁移进入哈希链审计日志，可在 Review 页一键验证

> 「我凭什么信它？」——因为执行者不能自己盖章。

### 3. 内阁会议（Council）

高 stakes 决策（支出、时间冲突、目标变更）触发：

```
Researcher 出证据 → Coach 评估可行性 → Treasurer 算账
→ Critic 唱反调 → Auditor 旁听 → Chief 汇总 → 用户决定
```

输出是一页决策备忘录：选项、推荐、异议、判例。
会议规则写死：每人必须给证据，Critic 必须唱反调，Auditor 不投票。

### 4. 学徒转正（Apprenticeship）

```
影子学习（观察 5 次成功运行）
  → 技能草案
  → 5 题留出考试（Auditor 监考）
  → ≥4/5 通过 → 转正，获得技能 v1，信任分 +10
  → 失败两次 → 退休
```

它证明的不是「多一个 Agent」，而是系统能**长出**新能力。

---

## 七个 Agent

| Agent | 目标函数 | 职责 | 关键约束 |
|---|---|---|---|
| **Atlas** / Chief of Staff | 目标推进 | 拆解、派活、早报、主持会议 | 不能验收自己的工作 |
| **Iris** / Researcher | 证据质量 | 找资料、验证来源、提供反例 | 每条结论必须带来源 |
| **Mira** / Coach | 你的学习效果 | 出题、陪练、反馈、调难度 | 追求「你真的会」 |
| **Vault** / Treasurer | 资源效率 | 预算、时间、成本 | 可否决，但必须给替代方案 |
| **Justus** / Auditor | 真实性 | 独立验收、周审计 | 不能被 Chief 推翻 |
| **Pip** / Apprentice | 能力增长 | 影子学习 → 技能 → 考试 → 转正 | 留出考试，不能用训练题 |
| **Cass** / Critic | 反脆弱 | 红队、挑战假设 | 只在内阁会议出现 |

> 多 Agent 的价值不在「并行」，在**目标函数不同**：Chief 要结果，Treasurer 要省，Auditor 要真，Coach 要你学会。冲突产生真正的决策。

---

## 三个界面

| 界面 | 回答的问题 |
|---|---|
| **Today** | 今天发生了什么？需要我决定什么？ |
| **Cabinet** | 我有哪些 Agent？状态、负载、成本、绩效如何？ |
| **Review** | 这周哪里错了？学到了什么？下周改什么？ |
| **Memory** | 它记住了我什么？证据在哪？我能改吗？ |
| **Council** | 这个高风险决策，各方怎么说？ |

---

## 快速开始

### 1. 准备 Postgres

```bash
brew services start postgresql@18
createdb cabinet_dev
```

或用 Docker：

```bash
docker compose up -d
# 然后把 DATABASE_URL 改成 postgres://cabinet:cabinet@localhost:5433/cabinet_dev
```

### 2. 安装与初始化

```bash
cp .env.example .env.local
pnpm install
openssl rand -base64 32   # 写入 .env.local 的 BETTER_AUTH_SECRET
pnpm db:setup             # 本地已有库：push + seed
# 或全新库：pnpm db:migrate && pnpm db:seed
pnpm dev
```

演示登录：`demo@cabinet.local` / `cabinet-demo`。
本地默认 `AUTH_REQUIRED=false`，不阻塞演示；公网部署时设为 `true`。

打开 http://localhost:3000

### 3. 可选：接真实模型

```bash
# .env.local
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
# OPENAI_BASE_URL=https://your-compatible-endpoint/v1
```

不设置也能完整演示：Agent 会使用确定性模板，并明确标注 `demo` 模式。

---

## 3 分钟演示脚本

1. **Today**：早报、今天 3 件事、2 个待决定。
2. 打开「设计检索评估练习」→ 点 **提交验收** → Auditor 驳回：缺少评分标准。
3. 点 **执行** → 新版本包含 rubric → 再点 **提交验收** → 通过，任务变绿。
4. **Review** → 点 **运行反思** → 生成一条新洞察（21:00 阅读移到 13:30）。
5. **采纳** → 计划改变；再点 **回滚** → 恢复原状，审计留痕。
6. **Council** → 看 5 方立场 → 有条件批准 → 写入判例。
7. **Cabinet** → 打开 Pip → **运行结业考试** → 5/5 转正，L2 解锁。
8. **Memory** → 看 7 条记忆、1 条冲突、每条证据；删除一条，Agent 不再使用。

---

## 架构

```
Next.js App（UI + API + SSE）
   │
Core Domain（TypeScript）
   Org · Task · Run Engine · Memory · Learning · Policy · Review
   │
Postgres（Drizzle） · 可选 LLM（AI SDK）
```

| 层 | 选择 |
|---|---|
| Web | Next.js 16 + TypeScript |
| UI | Tailwind 4 + 手写 shadcn 风格组件 |
| DB | Postgres 18 + Drizzle ORM |
| LLM | Vercel AI SDK（可选） |
| 状态 | 自写状态机 + `runs/steps` 事件流 |
| 审计 | SHA-256 哈希链 |
| 部署 | Vercel + Neon（或任意 Node 主机 + Postgres） |

**没有用 LangGraph / CrewAI 作为核心。** 组织语义、任务状态机、审计和授权是产品本身，不能被框架抽象掉。

---

## 数据模型（22 张表）

`users` · `profiles` · `agents` · `agent_grants` · `agent_templates` · `goals` · `tasks` · `runs` · `steps` · `artifacts` · `memories` · `insights` · `reviews` · `approvals` · `audit_events` · `skills` · `councils` · `council_positions` · `checkins` · `policy_config` · `idempotency_keys` · `user_actions`

核心状态机：

- **Task**：`planned → assigned → running → submitted → auditing → accepted / rejected → done`；外部动作：`assigned → awaiting_approval → approved → running`
- **Run**：`queued → running → succeeded / failed`
- **Agent**：`probation → active → paused → retired`
- **Apprentice**：`shadowing → drafting → examining → active / retired`
- **Insight**：`proposed → applied → rolled_back` / `rejected`

---

## 真实 vs 模拟（重要）

这个 MVP 刻意区分「机制真实」和「模型模拟」：

| 部分 | 状态 |
|---|---|
| 数据库、任务/运行状态机、审计哈希链 | ✅ 真实，哈希链可验证 |
| 授权门禁、审批、预算、回滚 | ✅ 真实（paused / self-audit / budget / approval） |
| 记忆存储、证据链、冲突标记 | ✅ 真实 |
| 学徒考试、转正、技能状态 | ✅ 真实（结果为确定性） |
| Agent 产物 | ✅ 默认确定性模板；设置 API Key 后走真实模型，失败自动回退 |
| 指标（AAO / 依从性 / 成本 / 驳回率） | ✅ 从事件实时计算 |
| 内阁会议 | ✅ 预置会议 + 手动发起；决议与审计真实；自动召集是 P1 |
| 反思 | ✅ 规则驱动，生成可采纳/回滚的洞察；LLM 反思是 P1 |
| 外部动作（预订、支付） | ✅ 审批流真实；不真实执行预订/支付 |
| 鉴权 | ❌ 本地 demo 无登录；公网部署前必须补 |
| 社区 / 市场 / 链上身份 | ❌ 不在 MVP |

---

## 当前指标（演示数据）

- AAO / week：5（实时计算：`accepted_at` 在本周且 `accepted_autonomy_level ≥ 2`）
- 每日管理时间：2.8 min（来自 `user_actions`，不是写死）
- 计划依从性：63%（本周到期任务完成率）
- 审计驳回率：17%（本周 audit 事件）
- 周模型成本：约 $0.07（`runs.cost_cents` 求和）
- 记忆：7 条，平均置信度 80%，1 条冲突待确认

---

## 测试与 CI

```bash
pnpm test          # 82 tests: policy matrix, state machines, timezone, integration
pnpm typecheck
pnpm lint
pnpm build
```

- 单元测试：`tests/unit/policy.test.ts`、`state.test.ts`、`time.test.ts`
- 集成测试：run/audit、审批、洞察、学徒、授权、审计链、管理动作
- CI：`.github/workflows/ci.yml`（Postgres service + typecheck + lint + test + build）
- 迁移基线：`drizzle/0000_baseline.sql`；新库用 `pnpm db:migrate`，本地已有库用 `pnpm db:push`

## 鉴权（A1 已完成，A2 进行中）

- better-auth + Drizzle + Postgres，登录页 `/login`，演示账号已 seed。
- `AUTH_REQUIRED=false`：本地演示不拦截。
- `AUTH_REQUIRED=true`：页面 redirect `/login`，API 返回 401。
- 租户作用域（A2）已完成：所有 service/query 接收 `userId`，跨用户访问返回 404，并有 7 条隔离测试。
- 目前还没有注册/`/setup`，所以实际可登录账号只有 seed 的 demo 账号。

## 已知边界（下一步）

- **`/setup` 与注册**：A5 才会做；当前只有 demo 账号可登录。
- **engine 拆分**：已加 `userId`，但 2,300 行文件尚未拆到 `src/lib/services/`；与 A3 同批做。
- **Onboarding**：仍依赖 `db:seed`；`/setup` 创建真实 workspace 是 P1。
- **自动内阁**：会议目前是预置/手动的；规则触发 + LLM 立场生成是 P1。
- **技能评测**：学徒转正是状态机；留出集、灰度、回滚的评测管线是 P1。
- **外键/约束**：核心表尚未全部加 FK；迁移基线已就绪，下一步收紧。
- **成本模型**：`estimated_cost_cents` 目前由任务声明；模型路由与真实 token 计费是 P2。

## 路线图

### P1（接下来 2–4 周）

- 自动召集内阁会议（规则引擎 + LLM 立场生成）
- 技能版本评测：留出集 + 灰度 + 回滚
- 日报/周报自动生成，接入真实日历与笔记
- Agent Card 导出（A2A 兼容）+ 绩效记录签名

### P2（OPE 方向）

- **Guest Agent**：朋友的外教 Agent 临时加入，受限权限，绩效回写
- 可携带信用报告：跨家户雇佣/租赁/合伙
- 社区治理：提案、投票、异议、判例

> 个人产品里的「自主阶梯」，就是社区里「信用 → 权限 → 自治」的缩微版。

---

## 参考与致谢

- Generative Agents：Memory Stream / Reflection / Planning
- Letta：有状态记忆与自编辑
- Bitterbot：Dream Engine + 技能试用期
- Mission Control：Agent 控制平面的信息架构
- ERC-8004 / A2A / AP2：身份、Agent Card、授权与支付的协议参考
- Voyager：技能库与自动课程

---

## License

Private MVP. 未选择开源许可证。
