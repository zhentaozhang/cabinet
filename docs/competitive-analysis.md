# Cabinet 开源对标调研（2026-10-25）

> **问题**：用 codegraph 把 Cabinet 自己的机制读清楚，再拿 GitHub 上同生态项目的**真实能力面**对照，回答两件事——哪些劣势必须补，哪些亮点值得做。
>
> **口径**：codegraph 索引（387 files / 3,952 nodes / 8,697 edges，本机 `.codegraph/`）；GitHub REST API 的 `stargazers_count`（2026-10-25 抓取）；仓库自身 `git rev-list --count HEAD` = 111 commits，首提交 2026-10-22。

---

## 0. 结论摘要

Cabinet 的位置不在「Agent 框架」，而在 **「Agent 的治理层」**：预算预留、单次审批、执行者不可自审、哈希链审计、崩溃后按「未知用量」结算。这套组合在开源生态里**没有同量级对手**。

分工已经很清楚了：

| 生态位 | 已被谁占住 | Cabinet 的位置 |
|---|---|---|
| 怎么让 Agent 干活（编排） | CrewAI 60k★ · LangGraph 44k★ · AutoGen 62k★ · MetaGPT 71k★ | 不竞争 |
| 怎么看见它（追踪/评测） | Langfuse 36k★ · Phoenix 12k★ · openllmetry 7.5k★ | 缺接口，应接入而非重造 |
| 怎么记住（记忆） | mem0 68k★ · Graphiti 32k★ · Letta 25k★ | 有治理语义，缺召回质量 |
| 怎么接工具（协议） | MCP 生态 92k★（servers）· agentgateway 5.5k★ | **完全缺失**，是最大缺口 |
| **怎么证明它干得对、花得值、谁批的** | **空位** | **Cabinet 独占** |

三条判断：

1. **必须补的三块短板**：① 执行面（工具调用循环 + MCP）② 记忆召回（embedding/混合检索）③ 可观测与评测接口（OTel span + judge 验收）。
2. **值得做的三块亮点**：① 任务级 MCP 治理（不是网关级）② 可离线验证的 run manifest（哈希链 → Merkle + 外部锚定）③ 自主度阶梯（学徒 → 信任 → 晋升）产品化。
3. **最大风险**：短板不补，亮点就只是「一个很漂亮的管理台，管着一个不会做事的 Agent」。

### 0.1 落地状态（2026-10-25）

调研写完当天按「制定计划 → 执行 → 审查」补了其中四项。这份表现在是权威的进度表，
后面章节保留的是**当时的诊断**，不是当前状态。

| 条目 | 状态 | 证据 |
| --- | --- | --- |
| P0-1 执行面：工具循环 + MCP | **已补** | `a51698a`；`src/server/services/commands/tasks/tool-loop.ts`、`src/lib/mcp/`、`docs/mcp.md`。顺序是授权 → 预扣 → 调用 → 结算 → 留痕，任一步失败都落一条可读 step |
| P0-3 可观测：trace | **已补** | `ef2625b`；`src/lib/observability/tracing.ts`、`otlp.ts`、`src/instrumentation.ts`、`docs/observability.md`。零依赖 OTLP/JSON 导出，未配 endpoint 时不发任何网络请求（span 仍会构建，只是不导出） |
| ★2 可离线验证的 run manifest | **已做** | `982e907`；`src/lib/domain/manifest.ts`、`scripts/verify-manifest.ts`、`docs/manifest.md` |
| ★4 验收契约导出 | **已做** | `06a03a1`；`src/lib/domain/acceptance-export.ts`、`GET /api/tasks/[id]/acceptance`、`docs/acceptance-contract.md` |
| P0-2 记忆：向量/混合检索 | 未做 | 本机 Postgres 的 `pg_available_extensions` 只有 `pg_trgm`，没有 `vector`；且不新增运行时依赖。仍只有词面 + 权重排序 |
| P0-4 验收 judge / golden set | 未做 | 需要真实模型与标注集，本轮明确排除 |
| P1-5 单供应商 / P1-6 RBAC / P1-7 外部执行器 | 未做 | 仍在路线图里 |
| P2-8 CI 自动触发 | **未判定** | `docs/ci-status.md`：push 事件仍未触发过 workflow，等下一次真实 push 做实验；本地门禁用 `bash scripts/verify.sh` |

边界也要写清楚，否则「已补」会被读成「已完备」：

- MCP 只做 Streamable HTTP，**不做 stdio**；没有 OAuth；`mcp_servers` 仍无 UI/API 写入入口。
- manifest 只证明**这个文件没被改过**，不证明**运行没被漏记**；`auditHead` 没有外部锚定（没有第三方时间戳/公证）。
- 验收契约仍是确定性清单 + `manual`，**没有模型判定**；导出的是规则，判定结果在 manifest 里。
- MCP 的参数目前恒为 `{query}`，且要求 server 必须回 `mcp-session-id`、每次调用重新握手：
  对真实第三方工具还不够用（`docs/mcp.md` 的能力边界表已逐条写明）。
- 验收判定有第三种 `undetermined`：没有人判过的行不会被写成 `fail`，读 `verdict` 的消费方
  不会把「没判定」读成「不合格」（`docs/manifest.md`）。

---

## 1. 方法

1. `codegraph init .` 建索引，用 `codegraph_explore` 读四条主链路：run 执行链、policy 门禁、预算台账、记忆检索。
2. 用 `grep` 确认「没有的东西」——这比确认「有的东西」更重要：全仓 `mcp` 命中 **0 个文件**；`embedding|vector|pgvector|cosine` 在 `src` 命中 **0 处实现**（只有 seed 文案里出现「embedding」这个词）；`opentelemetry|span|traceId` 命中 **0 处**；`streamText|text/event-stream` 命中 **0 处**（唯一 `ReadableStream` 在 NDJSON 导出）。
3. 抓 GitHub REST API 元数据 + README 关键能力行，只采信原文能对上的表述。
4. 交叉核对仓库自己的文档（`docs/codegraph-analysis.md`、`docs/run-durability.md`、`docs/evidence-and-connectors.md`），发现两处**文档漂移**（见 §4.8）。

**证据强度说明**：星数只代表关注度，不代表质量；`MetaGPT` 最后推送 2026-01，`khoj` 最后推送 2026-08，活跃度差异明显。codegraph 的 `codegraph_status` 返回缓存数字，符号级 fan-in 有对象字面量噪声，所以本文的耦合结论以仓库文档里脚本直读 DB 的口径为准。

---

## 2. Cabinet 现状（代码证据）

### 2.1 分层与卫生（已经做得比多数开源项目好）

| 指标 | 值 | 证据 |
|---|---|---|
| 循环依赖 | 0 | `docs/codegraph-analysis.md` §2 |
| 真孤儿文件 | 0 | 同上 |
| `lib → server` 越界 | 0 条边（原来有 1 条 shim，已删） | `tests/unit/boundary.test.ts` |
| `components/pages → server` | 0 条边，前端只走 `@/lib/api/*` | 分层矩阵 |
| 路由 | 45 个 `route.ts`、13 个 `page.tsx` | `find src/app` |
| 测试 | 104 个 `.test.ts`（README 记录 852 用例，2026-10-24 实测） | `tests/` |
| 数据表 | 35 张 | `README` + `src/lib/db/schema/` 10 个域模块 |
| 源码 | `src` 36,661 行 | `wc -l` |

### 2.2 机制盘点

| 机制 | 实现位置 | 关键设计（这才是资产） |
|---|---|---|
| 策略门禁 | `src/lib/domain/policy.ts:306` `decideRun`，`src/lib/domain/policy.ts:289` `hasGrant` | 四种效果 `allow / suggest / require_approval / deny`（`policy.ts:3`）；配置缺失 fail-closed |
| 工具授权 | `src/lib/domain/tool-plan.ts:62` `planTools`，`TOOL_SPECS` 18 个工具 | 工具由 `agents.tools × agent_grants` 推导，**不由角色三元表达式推导** |
| 预算 | `src/lib/domain/agent-budget.ts:70` `decideReservation`；`src/server/services/commands/tasks/run.ts:296` `reserveBudget` | 调用模型**之前**预留；预留与认领同一事务（`run.ts:201-333`） |
| 审批 | `approvals` + 单次消费（`run.ts:275-288`） | 条件更新 + `consumedAt`，并发下只有一个能消费成功 |
| 独立验收 | `src/server/services/commands/tasks/audit.ts:27`；`src/lib/domain/acceptance.ts:61` | 确定性清单；无法判定的写成 `manual`（`audit.ts:200`），不伪造结论 |
| 审计链 | `src/lib/audit.ts:40` `logAuditTx`，`src/lib/audit.ts:100-125` 校验 | 每用户一条 SHA-256 前向链，事务内追加、按用户串行化 |
| 队列 | `src/server/services/commands/tasks/jobs.ts:155` `claimRunJob` | `FOR UPDATE SKIP LOCKED` + 租约 10 分钟（`jobs.ts:18`）+ 最多认领 5 次（`jobs.ts:27`） |
| 恢复 | `scripts/run-worker.ts`、`recovery.ts` | 有供应商接触痕迹 → 按**未知用量**结算（金额=预留上限）；无痕迹 → 释放；不自动重跑 |
| 维护入口 | `src/server/jobs/maintenance.ts`（`pnpm tick`） | 8 步清扫，各自 try/catch，一步失败不阻断其余七步 |
| 记忆检索 | `src/lib/memory/retrieval.ts:61` `scoreMemories` | Generative Agents 权重：recency 0.5 / relevance 3 / importance 2（`retrieval.ts:23`），relevance 是 **token 集合命中率** |
| 证据/引用 | `min_evidence` 只认本 run 落库的 `[cite:evd_xxx]` | 正文里写 URL 不算证据；悬空引用直接失败 |

**这套东西的重心是「结论可追责」，不是「过程可观测」**——这正是下面所有对比的出发点。

---

## 3. 对标矩阵

> ★ 为 2026-10-25 抓取值。

### 3.1 编排框架（Cabinet 明确不竞争）

| 项目 | ★ | 语言/许可 | 它强在 | Cabinet 有而它没有 |
|---|---|---|---|---|
| MetaGPT | 71,010 | Python / MIT | 角色化 SOP、软件公司流水线 | 预算/审批/独立验收/审计链 |
| AutoGen | 61,550 | Python | 多 Agent 对话、群聊编排 | 同上 + 不做「谁验收」 |
| CrewAI | 60,074 | Python / MIT | role-play 协作、crew 级流程 | 执行者不可自审、成本准入 |
| LangGraph | 43,847 | Python / MIT | 持久化执行、`interrupt` 人工介入、短期+长期记忆 | 验收清单、预算预留、审计链 |
| agno | 42,883 | Python | Agent 平台化、会话/知识 | 治理语义 |
| Mastra | 29,057 | TypeScript | TS 原生、workflow suspend/resume、evals | 同上 |
| openai-agents-python | 30,263 | Python / MIT | 轻量 handoff、guardrails | 预算/验收/审计 |
| CAMEL | 17,964 | Python | 多 Agent 研究、scaling law | 生产治理 |

**结论**：编排层已经饱和，Cabinet 用 Next.js 重写一遍没有任何胜算。反过来说，LangGraph 的 `interrupt` 证明「人工介入」是刚需，而它只到「暂停等人点」这一步——**没有人做到「暂停等人批 + 批了只能用一次 + 超时自动过期 + 用掉要记在账上」**。

### 3.2 记忆

| 项目 | ★ | 能力 | 与 Cabinet 的差异 |
|---|---|---|---|
| mem0 | 67,757 | 单次 ADD-only 抽取（v3 起不 UPDATE/DELETE）、向量+图、LongMemEval 94.4 | **召回强、治理弱**：ADD-only 意味着「不覆盖」，但没有冲突裁决、没有 `validTo`、没有证据链 |
| Graphiti | 32,187 | 双时间上下文图、provenance、增量更新、历史查询 | 时序建模强于 Cabinet 的 `validTo`；但无「用户确认哪一条为准」的流程 |
| Letta (MemGPT) | 25,248 | 有状态 Agent、memory block、自我编辑 | 记忆是 Agent 的私有状态；Cabinet 的记忆是**跨 Agent 可见性受 `memory_scope` 约束**的公共资产 |

**结论**：Cabinet 的记忆是「有档案的」，mem0 的是「有召回的」。这不是同一场比赛——但 Cabinet 目前**只赢了档案，输了召回**。

### 3.3 治理 / 网关

| 项目 | ★ | 能力 | 留给 Cabinet 的空位 |
|---|---|---|---|
| agentgateway | 5,548 | MCP 网关（联邦、stdio/HTTP/SSE/Streamable）、A2A 网关、JWT/OAuth、**CEL RBAC**、限流、OTel | 这是**网络层**治理：谁能调、调多快。它不知道「这个任务有没有预算」「这个产物谁来验收」 |
| OPA | — | 通用策略引擎（Rego） | 策略与业务状态解耦；Cabinet 的策略直接读任务/账本/审批行 |
| Guardrails 7,558 / NeMo Guardrails 7,361 | | 输入输出内容护栏 | 管「话说不说得出口」，不管「事该不该做」 |
| immudb | 9,043 | 防篡改库、零信任、变更历史 | 可做审计链的外部锚定后端 |

**结论**：**「网络层治理」和「任务层治理」之间有一条清晰的缝**。agentgateway 是这条缝的上半截，Cabinet 是下半截，两者几乎不重叠——这是本次调研里最有机会的发现。

### 3.4 可观测 / 评测 / 计量

| 项目 | ★ | 能力 | 差距 |
|---|---|---|---|
| Langfuse | 36,396 | trace、prompt 管理、eval、成本 | Cabinet 只有 requestId + JSON 日志 + `/api/metrics`；`runs/steps` 结构天然可映射成 span，但**没有导出** |
| Phoenix | 11,989 | AI 可观测 + 评测 | 同上 |
| openllmetry | 7,504 | 基于 OTel 的 GenAI 观测 | Cabinet 0 处 OTel |
| promptfoo | 26,392 | 提示/Agent/RAG 测试、红队 | Cabinet 验收是确定性清单，**没有回归集、没有红队** |
| LiteLLM | 61,985 | 100+ 供应商、虚拟 key、**spend 追踪**、预算、限流 | Cabinet 只有 OpenAI 单供应商；但 LiteLLM 的预算是**事后统计**，Cabinet 是**事前预留 + 崩溃按未知结算**（更强） |

### 3.5 工作流持久化 / 个人助手 / 协议

| 项目 | ★ | 定位 | 对照 |
|---|---|---|---|
| Temporal | 23,966 | 持久化工作流（Go） | Cabinet 用 `run_jobs` + 租约 + tick 自建了一套轻量版；单进程够用，多实例会撞到 Temporal 已解决的问题 |
| Inngest | 5,987 | 事件驱动 step function | 同上 |
| OpenHands | 91,764 | AI 开发代理（MIT） | 工具循环/沙箱/浏览器是它的主场；Cabinet 一个都没有 |
| goose | 55,666 | Rust 可扩展 Agent（Apache-2.0） | 以 MCP 为插件面，是「工具面」的现成参考 |
| Suna | 20,311 | 开源 AI OS（TS） | 产品形态最接近 Cabinet 的「工作台」，但没有治理层 |
| Khoj | 37,813 | 自托管第二大脑（AGPL） | 个人知识 + 定时任务；无审批/预算/审计 |
| MCP spec 9,527 / servers 91,545 | | 工具协议与官方服务器 | Cabinet 全仓 0 处 MCP |
| A2A 26,286 | | Agent 间通信、Agent Card 发现、长任务 | Cabinet 的 `/api/agents/[id]/card` 只是只读 JSON，不是规范卡片，也不可签名 |

---

## 4. 劣势：必须补的

> 排序依据：**是否挡住产品自己讲的故事**，不是「别人有我们也要有」。

### P0-1 执行面太薄：一次 `generateText`，没有工具循环，没有 MCP

- **证据**：`src/lib/llm.ts:98` 是唯一一次模型调用，`maxRetries: 0`，无 `tools`、无 `stopWhen`；`tool-plan.ts:15-34` 声明了 18 个工具，但真正有连接器的只有 `web_search` / `web_fetch`（`src/lib/connectors/search/{brave,tavily}.ts`），计划到的工具若不是这两个，一律写 `not_connected` + “No external connector is configured for this tool.”（`run.ts:545-548`）；全仓 `mcp` 命中 0 个文件。
- **对标**：OpenHands / goose / Mastra 全部以 MCP 为插件面；MCP servers 已 91k★。
- **后果**：七个角色的差异只能体现在**提示词**里，不能体现在**能调什么工具**里。README 自己也承认「charter 会进入系统提示，但不是可执行约束」。
- **建议**：把 `TOOL_SPECS` 升级成 MCP server registry（`resource/scope/kind` 映射到 MCP tool 的注解），加一个受限的工具循环（`maxSteps` 2–3，每步都过 `decideRun` 的工具授权分支），并把每次 tool call 写成 `steps` 行——现有的 step 结构已经支持。
- **成本**：中（1 个 sprint）。

### P0-2 记忆只有词面匹配，没有半点和向量

- **证据**：`src/lib/memory/retrieval.ts:61-100`，relevance = `queryTokens ∩ contentTokens / queryTokens`（`retrieval.ts:39-47`），`Intl.Segmenter("zh")` 分词；无 embedding、无 rerank、无 pgvector。
- **对标**：mem0 在 LongMemEval 报 94.4；Graphiti 支持语义+关键词+图遍历的混合检索。
- **后果**：中文同义改写（「预算」vs「花费上限」）直接漏召回，而这是个人助理最常见的查询形态。
- **建议**：Postgres 加 `pgvector`，检索改 RRF 混合（词面 + 向量），**保留** 现有的 `salience`/`validTo`/冲突不覆盖语义——那是 mem0（ADD-only）和 Graphiti 都没有的东西。注意 `docs/run-durability.md` 里写的「记忆衰减缺配置键是有意空缺」，加向量前先把 `policy_config` 的留存/half-life 键定下来。
- **成本**：中（1 个 sprint + 一次迁移）。

### P0-3 可观测性只有「结论层」，没有「过程层」

- **证据**：`docs/observability.md` —— requestId（AsyncLocalStorage）+ 一行一个 JSON + `/api/metrics` + `/api/health`；`grep opentelemetry|span|traceId` 在 `src` 命中 0。
- **对标**：Langfuse 36k★ / openllmetry 7.5k★ 生态已成型；OTel GenAI semconv 是事实标准。
- **后果**：审计链能回答「谁批的、结论是什么」，回答不了「第 3 步为什么超时、检索命中了几条、哪次重试导致了成本」。
- **建议**：`run` = span、`step` = child span，字段映射 `gen_ai.*`，导出 OTLP；**审计链继续做结论，trace 做诊断**，两者不要混。这是接 Langfuse/Phoenix 的最低成本路径（不改数据模型）。
- **成本**：低（3–5 天）。

### P0-4 验收只有确定性清单，没有可回归的评测

- **证据**：`acceptance.ts:61` 支持 `section / min_words / min_sources / min_evidence / manual`；`audit.ts:200` 无法判定时写 `manual`；无 LLM judge、无 golden set、无红队。
- **对标**：promptfoo 26k★（断言 + 红队）、Phoenix/Langfuse 的 eval。
- **张力**：`AGENTS.md` 第 2 条明确「没有证据就写未判定」——引入 judge 不能违反这条，否则就是给「伪造审计」开门。
- **建议**：新增 `judge` 验收类型，但**强制三件事**：① 必须引用本次 run 的 `evidence` id；② 必须落 `reason` 和模型/提示版本；③ 判定结果与确定性项并列展示，不能覆盖 `manual`。再加一个 golden set（20–30 条历史任务 + 期望判定）做回归。
- **成本**：中（1 个 sprint）。

### P1-5 供应商单一 + 无网关

- **证据**：`src/lib/llm.ts:79-84` 只读 `OPENAI_API_KEY`/`OPENAI_MODEL`/`OPENAI_BASE_URL`（可指向兼容网关，但代码里没有抽象层）。
- **对标**：LiteLLM 61k★，100+ 供应商、虚拟 key、fallback。
- **建议**：不重造网关——把 LiteLLM 当上游（`OPENAI_BASE_URL` 已经能指过去），Cabinet 保留**预留式台账**。需要补的是 provider 抽象 + 失败分类（`timeout / provider_error / empty_response` 已有，扩到 rate_limit）。

### P1-6 只有单人工作区，没有组织

- **证据**：`grep organization|team|workspace_members` 在 `src/lib/db/schema` 命中 0；所有查询按 `userId` 作用域。
- **后果**：产品叫「内阁」「七个角色」，但只有一个人、没有成员、没有 RBAC、没有 SSO。
- **判断**：**这可能不是劣势，是定位**。个人 Agent 治理本来就该是单人的。若要做团队，成本远高于收益（RLS + 邀请 + 角色 + 计费）；建议在 README 里明确写死「personal only」，而不是留一个永远做不完的 TODO。

### P1-7 外部执行器仍是空的

- **证据**：`tool-plan.ts` 里的 `calendar_read` / `ledger_read` / `sandbox_execute` 全部 `not_connected`；审批流程没有真实对象可批。
- **后果**：`awaiting_approval` 这条最值钱的状态机分支（`run.ts:162-164`）在真实工作区里几乎不会被触发——演示里很完整，真实使用里是空的。
- **建议**：MCP 接 Google Calendar / Gmail 两个只读 + 一个写（发日程），立刻让审批有对象。依赖 P0-1。

### P2-8 交付与文档

- **CI push 触发从未产生过 workflow run**（README 自述：累计 0 条，手动 `gh workflow run` 才跑）。这不是「小问题」——门禁形同虚设。
- **文档漂移两处**：① README「已知边界」写「没有后台队列、重试调度」，但 `run_jobs` + `scripts/run-worker.ts` + `pnpm tick` 已实现且文档 `docs/run-durability.md` 写得很细；② README 说 44 个 route，实际 45。
- **页面巨型组件**：`TaskPage` 1,105 行、`TodayPage` 773 行、`QuickCreate` 829 行（`docs/codegraph-analysis.md` §6），无组件级视觉回归、无浏览器 E2E。

---

## 5. 亮点：值得做的

> 标准：**开源里没人做，或做得明显更弱，且 Cabinet 已有 60% 的基础**。

### ★1 任务级 MCP 治理（最高杠杆）

- **空位**：agentgateway 管「谁能调、调多快」（CEL RBAC、JWT、限流）；没有任何项目管「这次调用属于哪个任务、有没有预算、调完谁来验收、证据落在哪」。
- **已有基础**：`TOOL_SPECS`（resource/scope/kind）、`planTools`、`decideRun` 的工具授权分支、`agent_grants`、`steps` 表。
- **形态**：MCP client 包一层 `governedCall`：先 `decideReservation`（钱）→ `planTools`（权限）→ `decideRun`（审批/自主等级）→ 调用 → 写 `steps` + `retrieval_calls`/成本 → 交由验收清单判定。
- **为什么值得**：这是把「治理层」从一个 UI 变成**所有 Agent 工具调用的必经之路**。一旦成立，Cabinet 就是「MCP 的任务层治理」，与 agentgateway 天然互补而非竞争。

### ★2 可离线验证的 run manifest

- **空位**：immudb 做防篡改存储，但没人把「一次 Agent 运行」打包成可验证的产物。
- **已有基础**：`audit_events` 哈希链（`src/lib/audit.ts`）、`evidence.contentHash`、`artifacts`、验收报告带 `artifactId`（`audit.ts:408`）、`attemptId`。
- **形态**：导出 `run.manifest.json`：artifact 哈希 + evidence 哈希 + 验收清单逐项判定 + 审批 id/时间/批准人 + 模型/提示版本 + 链上 `hash`/`prevHash`。再进一步：Merkle 树 + 每日锚定（Git commit note / immudb / 时间戳服务）。
- **价值**：用户能对第三方证明「这份产物是那次运行产出、按这份清单验收、由我批准」。这是审计链从「自查工具」升级为「对外证据」。

### ★3 自主度阶梯产品化（学徒 → 信任 → 晋升）

- **空位**：OWS 里普遍只有 `human_approval: on/off`；CrewAI/LangGraph 没有「晋升证据」概念。
- **已有基础**：`probation → active → paused → retired`、`trust_score`（通过 +1 / 驳回 -2）、学徒 `shadowing → drafting → examining → active`（两次失败退休）、晋升要求「真实模型运行 + Agent 产物 + 任务已验收」三者同时成立。
- **形态**：把晋升条件做成**可读的进度条 + 证据列表**（哪 5 条观摩、哪几次验收、哪次真实运行），并把「L1→L2→L3 解锁了什么」渲染成权限差异（`policy.ts` 的矩阵已经是现成的数据）。
- **价值**：这是把「信任」从口号变成**可审计的数值**，几乎没有人做。

### ★4 验收契约作为可移植资产

- **空位**：promptfoo 的 assertions 不可跨项目复用；没有「质量门」的标准格式。
- **形态**：把 `acceptance criteria` 抽成可导出的模板库（研究任务 / 代码任务 / 学习任务各一套），支持 `export` 成 JSON schema，让别的系统也能按同一份清单验收。
- **价值**：低边际成本，高叙事价值——「执行者不能自审」从产品规则变成**协议**。

### ★5 预算钱包：预留式计量

- **已有基础**：`reserveBudget` 在调用前预留（`run.ts:296`）、崩溃按未知用量结算（`recovery.ts`）、`closeExpiredPeriods` 只写 `closed_at` 不删行。
- **对比**：LiteLLM 是事后 spend 统计；Cabinet 是**准入控制**。这个差异值得写进 README 的第一屏，而不是藏在文档里。
- **可做**：多 Agent 共享周预算的「池」视图 + 预留未结算的实时余额（现在分散在 3 个查询里）。

### ★6 决策事后判定（dissent vindication）

- **已有基础**：`dissents` (`pending → vindicated / invalidated`)，`settleDueDissents` 在 `pnpm tick` 里按观察窗口到期自动判定（`maintenance.ts:186-190`）。
- **对比**：CrewAI 的 debate 只是提示词，说完就没了；Cabinet 会在**事后**用事实判定当初谁对。
- **价值**：这是「内阁」唯一真正区别于「让 5 个模型各说一段」的机制，值得做成独立页面。

---

## 6. 建议路线图

| 阶段 | 内容 | 依赖 | 估算 | 风险 |
|---|---|---|---|---|
| S1 | 修 CI 触发 + 校准 README 三处漂移 + OTel span 导出（P0-3） | 无 | 1 周 | 低 |
| S2 | MCP client + 受限工具循环 + `governedCall`（P0-1、★1） | S1 | 2 周 | 中（攻击面扩大） |
| S3 | `judge` 验收类型 + golden set（P0-4、★4） | S2（要真实产物） | 1.5 周 | 中（与「无证据写未判定」的张力） |
| S4 | pgvector 混合检索 + 衰减配置（P0-2） | 无（可并行） | 1.5 周 | 中（迁移） |
| S5 | run manifest 导出 + Merkle 锚定（★2） | S2/S3 | 2 周 | 低 |
| S6 | 准入外部执行器（Calendar/Gmail via MCP）+ 审批有对象（P1-7） | S2 | 2 周 | 中 |
| S7 | 自主度阶梯 UI + 预算钱包视图（★3、★5） | 无 | 1.5 周 | 低 |

**取舍**：S2 是分水岭。做完 S2，Cabinet 从「演示治理的管理台」变成「治理真实工具调用的运行时」；不做 S2，S3–S7 全部是包装。

---

## 7. 反面意见与风险

1. **不要变成第 N 个 Agent 框架**。编排层 60k★ 的项目有四个，重造没有胜算。Cabinet 的安全区是「别人不愿意做的脏活」：审批、预算、验收、审计、崩溃结算。
2. **不要重造记忆库/网关/追踪平台**。mem0、agentgateway、Langfuse 已经是基础设施。接进去，保留自己的语义层。
3. **MCP 会扩大攻击面**。现有 `planTools` 是「白名单推导」，接 MCP 后会出现「动态工具清单」——必须保持 fail-closed，并把每个 MCP server 的 `resource/scope` 显式登记，不能从 tool 名字推断。
4. **judge 与确定性哲学冲突**。现有设计的价值在于「判定可复现」。引入模型判定必须让它**不可覆盖 `manual`、必须带理由与版本**，否则会重演 `AGENTS.md` 里记录的那次「没做对照却写逐条通过」。
5. **哈希链的信任边界要说清**。用户能改自己的库，链只能证明「库内未被静默改写」，不能证明「没有权限的人改不了」。对外宣称前必须写清；否则升级到 Merkle + 外部锚定之前，它只是完整性检查。
6. **星数不是质量**。本次对比里 MetaGPT 71k★ 已 9 个月未推送，khoj 37k★ 是 AGPL（商用受限）。用「活跃度 + 许可 + 能力面」三条一起看。

---

## 8. 附录：数据来源

**本仓库**
- `docs/codegraph-analysis.md`（分层矩阵、fan-in、索引质量限制）
- `docs/run-durability.md`（inline/worker、租约、恢复、tick 八步）
- `docs/evidence-and-connectors.md`（证据语义、Brave/Tavily、`min_evidence`）
- `docs/observability.md`（requestId、日志事件、metrics/health）
- `docs/remediation-plan.md`（八条不变量 I1–I8、硬编码替换表）

**代码锚点**
- `src/lib/domain/policy.ts:3` `PolicyEffect`；`:289` `hasGrant`；`:306` `decideRun`
- `src/lib/domain/agent-budget.ts:70` `decideReservation`
- `src/lib/domain/tool-plan.ts:15-34` `TOOL_SPECS`；`:62` `planTools`
- `src/lib/domain/acceptance.ts:61` `evaluateAcceptance`
- `src/lib/memory/retrieval.ts:25` 权重；`:36-46` 词面 relevance；`:63` `scoreMemories`
- `src/server/services/commands/tasks/run.ts:55` `runTask`；`:201-333` 认领+预留事务；`:296` `reserveBudget`
- `src/server/services/commands/tasks/jobs.ts:18` `DEFAULT_LEASE_MS`；`:27` `MAX_CLAIM_ATTEMPTS`；`:155` `claimRunJob`
- `src/server/services/commands/tasks/audit.ts:27` `auditTask`；`:200` `manual` 项；`:406` 记录被判定的 `artifactId`
- `src/lib/audit.ts:40` `logAuditTx`；`:100-125` 链校验
- `src/lib/llm.ts:98` 唯一一次 `generateText`；`:79-84` 供应商配置
- `src/app/api/tasks/[id]/run/route.ts:11-13` `RUN_EXECUTION=worker` 开关
- `src/app/api/agents/[id]/card/route.ts` Agent Card（只读 JSON）

**GitHub（★ 为 2026-10-25 抓取）**
- 编排：MetaGPT 71,010 · AutoGen 61,550 · crewAI 60,074 · LangGraph 43,847 · agno 42,883 · openai-agents-python 30,263 · Mastra 29,057 · CAMEL 17,964
- 记忆：mem0 67,757 · Graphiti 32,187 · Letta 25,248
- 治理/网关：agentgateway 5,548 · Guardrails 7,558 · NeMo Guardrails 7,361 · immudb 9,043
- 观测/评测/计量：Langfuse 36,396 · Phoenix 11,989 · openllmetry 7,504 · promptfoo 26,392 · LiteLLM 61,985
- 助手/运行时：OpenHands 91,764 · goose 55,666 · Khoj 37,813 · Suna 20,311
- 协议/持久化：MCP servers 91,545 · MCP spec 9,527 · A2A 26,286 · Temporal 23,966 · Inngest 5,987

**方法局限**
- codegraph 的 `codegraph_status` 返回缓存计数；符号级 fan-in 受对象字面量属性名污染（详见 `docs/codegraph-analysis.md` §5）。
- 本文未做运行时实测（未跑 `pnpm verify`、未接真实模型），结论基于代码与文档阅读；「劣势」中涉及运行时行为的判断，引用的是仓库自己记录的实测结果。
