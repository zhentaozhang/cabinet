# Cabinet 外部工具接入（Connectors）调查与执行计划

> 状态：只读调研 + 计划。**本文件不包含任何实现改动**。
> 范围：搜索、日历、邮件、预订、支付五类外部动作。
> 结论先行：这不是「接 5 个 HTTP 客户端」的活。当前缺的是**外部动作的执行语义**——执行器、证据、幂等、审批消费、可逆性分级。按现在的代码直接接 API，会是「假证据 + 重复副作用 + 审批失效」三连。

---

## 0. 一句话结论

现状是：`policy` 已经会要求审批、`approvals` 已经能记录、`steps` 已经能展示，**但没有一个执行器去消费这份授权**。工具步骤是角色到字符串的硬编码（`src/server/services/commands/tasks/run.ts:376-397`），永远写 `status: "not_connected"`，`latencyMs` 固定 10ms、token 为 0 —— 它不是「失败的外部调用」，它是**一个从不发起调用的占位符**。

因此接入顺序必须是：**先补执行语义（P0）→ 再接只读搜索（P1）→ 再接只读日历（P2）→ 再接写类动作（P3/P4）→ 最后才是支付（P5）**。先接搜索再补语义，等于把可被幻觉骗过的验收标准继续喂给用户。

---

## 1. 现状诊断（代码级证据）

### 1.1 工具步骤是装饰，不是调用

`src/server/services/commands/tasks/run.ts:376-397`：

```ts
const tool =
  agent.role === "researcher"
    ? "web_search"
    : agent.role === "coach"
      ? "read_notes"
      : agent.role === "treasurer"
        ? "ledger_read"
        : agent.role === "auditor"
          ? "read_artifacts"
          : "read_notes";

await addStep({
  type: "tool",
  tool,
  input: { query: task.title },
  output: {
    status: "not_connected",
    tool,
    reason: "No external connector is configured for this tool.",
  },
  latency: 10,
});
```

问题不在「没接 API」，在于：

| 症状 | 后果 |
| --- | --- |
| 工具名由 `agent.role` 三元表达式决定，不来自 `agent.tools` 或授权 | 接上搜索后，`coach` 仍然拿不到搜索结果，`researcher` 的 `web_fetch` 永远不会被调用 |
| `output.status` 是唯一语义，没有错误码、没有 evidence、没有 HTTP 状态 | 下游无法区分「没配连接器」/「被限流」/「超时」/「返回空」 |
| `latency: 10`、token 0 是写死的 | 指标（AAO、成本）把假步骤当真步骤统计 |
| 没有 `tool_calls` 记录 | 无法审计「Agent 到底对外发了什么请求」 |

`src/lib/llm.ts:23` 的 `generateArtifact` 同样是单轮 `generateText`：没有 tools、没有 `stopWhen`、没有工具循环。也就是说**模型从来没见过任何工具定义**。`ai@7.0.148` 本身已导出 `tool` / `stopWhen` / `stepCountIs`（`node_modules/ai/dist/index.d.ts`），接工具不需要新依赖。

### 1.2 验收标准可被幻觉 URL 骗过（先修这个）

`src/lib/domain/acceptance.ts:16-18`：

```ts
function countSources(content: string): number {
  return (content.match(/https?:\/\/[^\s)\]>]+/g) ?? []).length;
}
```

`:53-59` 的 `min_sources` 直接用它判断。**模型只要在正文里写两个链接就通过验收**，链接是否真实、是否被访问过、是否支持结论，一概不查。

`docs/superpowers/plans/2026-10-22-data-trust-and-real-data.md` 的 Task 9（带引用 web search）如果只加连接器不改这条，验收仍然是「文本里有 URL」。这是本计划把 **evidence 落库** 放在 P0/P1 的核心理由。

### 1.3 审批通过后，授权与预算检查被短路

`src/lib/domain/policy.ts:308-315`（`decideRun`）：

```ts
if (approval?.status === "approved") {
  if (approval.consumedAt) {
    return deny("Approval has already been consumed.");
  }
  return allow("Execution approved.");
}
```

这段在 `normalizeAction` / `hasGrant` / 预算校验**之前**返回。含义是：一旦某次审批通过，执行阶段不再校验 grant、不再校验预算上限、不再校验 action 类型。对内部动作影响有限，对外部写动作（发邮件、预订、支付）是硬伤——审批是**针对某一次具体动作**的授权，不是对该 Agent 的永久豁免。

另外 `approvals` 表（`src/lib/db/schema.ts`）有 `consumedAt` 字段，但 `runTask` 里没有「消费审批」的写入路径；`consumedAt` 目前没有任何代码会写。

### 1.4 没有幂等键、没有 outbox、没有重试语义

- 执行在同一次 HTTP 请求内同步完成，模型调用有 20s 上限（`src/lib/llm.ts` 的 `AbortController`）。
- `handleMutation`（`src/lib/api/mutation.ts`）提供 `Idempotency-Key`，但那是**整条 API 请求**级别；一次 run 里如果发生两次工具调用，没有工具级幂等。
- 没有 outbox 表：发邮件/预订失败后重试，只能整条 run 重跑，会重复投递。

外部写动作的可观测失败率远高于内部写。没有工具级幂等键 + outbox，「重试」这个动作本身就是事故源。

### 1.5 没有连接器与凭证层

- `src/lib/env.ts` 只加载 `.env`；`.env.example` 里与外部服务相关的只有 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。没有 `BRAVE_API_KEY` 之类。
- `envPositiveInt`（`src/lib/config/env-int.ts`）只处理数字，没有「缺 key 时如何降级」的统一约定。
- 没有任何表存 OAuth 刷新令牌、API key 引用、scope 列表、健康状态。
- `src/app/` 下没有 settings 路由（`find src/app -name page.tsx` 只有 `/`、`/cabinet`、`/cabinet/[id]`、`/council`、`/memory`、`/review`、`/setup`、`/login`、`/tasks/[id]`），连接器无处可管。

### 1.6 账户导出/删除是固定表清单

`src/lib/account.ts` 的 `exportAccount` 逐表 `select`，`deleteAccount` 逐表 `delete`。新表（`connectors` / `tool_calls` / `evidence` / `outbox`）如果不加进去，会直接违反 `docs/trust-and-memory-plan.md` 的 I1 与隐私预期——导出缺数据、删除留残骸。

### 1.7 缺口矩阵

| 能力 | 现状 | 影响 |
| --- | --- | --- |
| 工具注册与路由 | 角色三元表达式（run.ts:376） | 授权模型与实际可用工具脱节 |
| 外部调用执行 | 不存在 | 所有「工具」都是装饰 |
| 证据持久化 | 无 evidence 表，仅 `steps.output` JSON | 无法验收、无法引用、无法审计 |
| 引用真实性 | `countSources` 数文本 URL（acceptance.ts:16） | 幻觉即可通过验收 |
| 凭证管理 | 无 | 无法接入任何带鉴权的服务 |
| 幂等 / outbox | 仅 API 级 `Idempotency-Key` | 重试会重复副作用 |
| 审批消费 | `consumedAt` 字段存在，无人写 | 一次批准可反复使用 |
| 连接器健康 | 无 | 用户看到 `not_connected` 却不知原因 |
| 账户可移植 | 固定表清单（account.ts） | 新表漏出隐私边界 |

---

## 2. 外部现实约束（2026-10 调研）

> 以下均为只读调研结论，来源见 §10。日期敏感的事实已标注。

### 2.1 搜索：Bing 已退役，选型要「一主一备」

- **Microsoft Bing Search API 已退役**：文档在原 URL 上被重定向到 `learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/overview`，页面最后更新 `2025-05-07`，且仍在引用旧的 `aka.ms/bingsearchapipricing` 订阅页。**不要把它作为新接入目标**。
- **Brave Search API**：Search 计划 **$5.00 / 1,000 requests**，每月含 **$5 免费额度**，容量 **50 req/s**；另有面向 agent 的 "LLM context" 结果形态，以及 Answers 计划（$4/1k 查询 + $5/1M input tokens + $5/1M output tokens，2 req/s）。
- 中文覆盖是选型的关键变量：Brave/Tavily/Exa 对中文长尾与国内站点覆盖弱于国内供应商（如博查 Bocha，阿里云市场有售）。**结论：provider 抽象 + 主备切换，默认 Brave（价格透明、有免费额度、snippet 可直接做 evidence），中文场景可切国内供应商。** 不把任何一家写进核心逻辑。

### 2.2 日历：只读 scope 是 sensitive，不是 restricted

- Google Calendar 的 `calendar.readonly` 属 **sensitive** scope：需要 OAuth 应用验证（未验证应用有 100 用户上限 + 未验证警告），**不触发 CASA**。
- 真正触发 **CASA** 的是 restricted scope（Gmail 的 `gmail.readonly` / `gmail.modify` / `gmail.compose` / `https://mail.google.com/`，以及 Drive 全量）。CASA 分 Tier 1 自评 / Tier 2 第三方 DAST / Tier 3 渗透测试，**每年几百到几千美元**，OAuth 审核 1–3 周，且需每年复评。
- **结论：日历先只读。** 只读既满足 `docs/superpowers/plans/2026-10-22-data-trust-and-real-data.md` Task 10 的范围，也避开 CASA。日历写入放到「邮件/预订」同一批（P3+），因为它本质是外部写动作。

### 2.3 邮件：`gmail.send` 免 CASA，但仍需验证

- 按 Nylas 的 2026-10-07 版核对表：`gmail.send` 属 **sensitive、非 restricted** → 需要验证，**不需要安全评估**；`gmail.readonly`/`modify`/`compose` 才是 restricted，会拉出 CASA。
- **结论：邮件第一版走 SMTP 或事务邮件服务（Resend/Postmark 类），把 OAuth 邮局作为可选项。** 理由：(1) 免 OAuth 验证与审核周期；(2) 自托管用户本来就有 SMTP；(3) 发信是**不可回滚**动作，治理成本主要在审批与幂等，不在通道。

### 2.4 预订：Cal.com API v2 可用，且已有 MCP server

- Cal.com API v2 支持 OAuth 或 **API key**（测试 `cal_` / 生产 `cal_live_`，`Authorization: Bearer`），**120 req/min** 默认限流；端点覆盖 bookings / slots / event types / webhooks。
- Cal.com 官方文档里就有 MCP server 一节——说明「预订」这类动作在 2026 已经有标准化的 agent 接入形态。
- **结论：预订接 Cal.com v2（slots 查询 + 创建 booking + webhook 回写），强制人工审批。**

### 2.5 支付：2026 已有一整套 agent 支付协议，但都不适合「Agent 自主扣款」

- Stripe 的 Agentic Commerce 给出三类路径：**Link Agent Wallet**（agent 用客户控制的钱包付款）、**Shared Payment Tokens**（为 agent 发起的购买签发带作用域的支付凭证）、**UCP**（跨平台 agentic commerce 协议）；另有 **x402 / MPP** 用于「按工具调用/HTTP 请求计费」。
- 行业侧同期还有 Google AP2、Visa Intelligent Commerce、Mastercard Agent Pay、Coinbase x402、Stripe ACP 等（ATXP 2026-03 的对比把它们列为六个协议）。
- 关键共同点：**支付凭证是「有限作用域 + 可撤销」的，不是长期卡号**；且主流方案都保留人类授权环节。
- **结论：支付放在最后，且只做「人批准 + 受限 token + 白名单商户 + 金额上限」，永不实现 Agent 自主扣款。** 这与 `docs/superpowers/plans/2026-10-22-data-trust-and-real-data.md` 的 Release Gates（不实现支付）一致——本计划不推翻该 gate，只是把它排到 P5 并给出前置条件。

### 2.6 MCP 是连接器的标准形态，但别把它焊进核心

- MCP 规范最新版本为 **2026-07-28**：JSON-RPC 2.0，Hosts/Clients/Servers 三角色，服务端提供 Resources / Prompts / Tools，客户端可提供 Elicitation；规范强调「用户明确同意」「工具描述不可信，除非来自可信服务端」；扩展里有 **Tasks**（长时任务、轮询、持久句柄）、**MCP Apps**、**Skills over MCP**。
- 这对 Cabinet 的意义：**工具网关应设计成 MCP 兼容（同样的 tool 描述形态），但内部先走直连 HTTP adapter**。理由：核心 run 流程不该被协议版本绑架；等 adapter 契约稳定后，MCP 只是多一种 transport。

---

## 3. 设计

### 3.1 分层

```
runTask (同步编排, 事务外)
  └─ toolPlanner          选工具：agent.tools × grant × task.actionType
      └─ connectorRegistry 解析 connector + 健康检查 + 凭证
          └─ connector.execute()  纯 HTTP，带超时/重试/幂等键
              └─ tool_calls + evidence 落库（短事务）
                  └─ generateArtifact(带 evidence 上下文)
                      └─ 验收：按 evidence 计数，不按文本 URL
```

### 3.2 核心契约（新增 `src/lib/connectors/types.ts`）

```ts
export type ConnectorKind = "search" | "calendar" | "email" | "booking" | "payment";

/** 可逆性决定治理强度，不决定实现难度。 */
export type Reversibility = "read" | "reversible_write" | "irreversible_write";

export type ToolDescriptor = {
  name: string;            // "search.query" / "calendar.list_events" / "email.send"
  kind: ConnectorKind;
  reversibility: Reversibility;
  /** 落进 evidence 的字段名，用于验收与引用 */
  produces: "evidence" | "effect" | "both";
  inputSchema: unknown;    // JSON Schema，可直接映射到 ai@7 的 tool()
};

export type ConnectorContext = {
  userId: string;
  connectorId: string;
  secrets: Record<string, string>;  // 已解密，仅在内存中
  timeoutMs: number;
};

export type ToolResult =
  | { status: "ok"; evidence: EvidenceInput[]; effectId?: string; raw: unknown }
  | { status: "empty"; raw: unknown }
  | { status: "error"; code: ToolErrorCode; message: string; retryable: boolean };

export type ToolErrorCode =
  | "not_connected"     // 没有可用连接器（语义修正：仅此一种情况）
  | "unauthorized"      // 凭证失效 → 需要用户重连
  | "rate_limited"
  | "timeout"
  | "upstream_error"
  | "invalid_response"
  | "policy_denied";

export interface Connector {
  kind: ConnectorKind;
  provider: string;                 // "brave" | "tavily" | "google" | "smtp" | "cal.com" | "stripe"
  tools: ToolDescriptor[];
  health(ctx: ConnectorContext): Promise<{ ok: boolean; detail?: string }>;
  execute(tool: string, args: unknown, ctx: ConnectorContext, idemKey: string): Promise<ToolResult>;
}
```

设计约束：
- **adapter 不许碰数据库**。落库在 service 层，adapter 只负责 HTTP 与结果归一化。
- **adapter 不许读 `process.env`**。凭证由 registry 注入，便于测试与轮换。
- `ToolErrorCode` 是封闭联合，UI 与审计都依赖它做分支。

### 3.3 数据模型（迁移 `drizzle/0010_connectors.sql`，additive）

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `connectors` | `id`, `user_id`, `kind`, `provider`, `label`, `status`(`active\|degraded\|revoked`), `auth_type`(`api_key\|oauth2\|smtp`), `secret_ref`, `scopes` jsonb, `config` jsonb, `last_ok_at`, `last_error`, `created_at` | 一用户同类可多实例（如两个搜索供应商，一个主一个备） |
| `connector_secrets` | `id`, `connector_id`, `ciphertext`, `key_version`, `expires_at`, `rotated_at` | 应用层加密（AES-256-GCM，密钥来自 env/KMS）；`secret_ref` 走 env 时此行可空 |
| `tool_calls` | `id`, `user_id`, `run_id`, `step_id`, `connector_id`, `tool`, `args_hash`, `idempotency_key`, `status`(`ok\|empty\|error\|denied`), `error_code`, `http_status`, `latency_ms`, `request_fingerprint`, `response_summary` jsonb, `external_id`, `created_at` | 唯一索引 `(user_id, idempotency_key)`；索引 `(run_id)`、`(connector_id, created_at)` |
| `evidence` | `id`, `user_id`, `run_id`, `task_id`, `step_id`, `connector_id`, `kind`(`web_page\|calendar_event\|email_message\|booking\|payment_receipt`), `url`, `title`, `publisher`, `quote`, `content_hash`, `retrieved_at`, `payload` jsonb | 唯一索引 `(run_id, url, content_hash)` 防同一来源重复入库 |
| `outbox` | `id`, `user_id`, `tool_call_id`, `status`(`pending\|sent\|failed\|dead`), `attempts`, `next_attempt_at`, `last_error` | 仅 `irreversible_write` 需要；指数退避，`attempts >= 5` 进 `dead` 并要求人工介入 |
| `approvals` 补列 | `connector_id`, `tool_call_id`, `payload_hash`, `consumed_by_run_id` | `payload_hash` 保证「批准的是这次动作」，防批准后参数被换 |

`steps` 保持原样，但 `type: "tool"` 的 `output` 结构标准化为：

```json
{
  "status": "ok | empty | error | not_connected",
  "connectorId": "con_...",
  "provider": "brave",
  "errorCode": "rate_limited",
  "evidenceIds": ["evd_..."],
  "effectId": "cal_booking_123",
  "retryable": true
}
```

这样 §1.1 的三个症状一次性消掉：工具来自注册表、结果有错误码、失败可区分。

### 3.4 执行管线（改造 `runTask`）

```
T1 (短事务): policy.decideRun → task=running → insert run
   执行 (事务外):
     for toolCall of planTools(agent, task):
        idemKey = sha256(userId|connectorId|tool|argsHash)
        若 irreversible_write: 必须 approval.approved 且 payload_hash 匹配 → 消费一次
        connector.execute(...) → tool_calls 落库 → evidence 落库
        每次调用 addStep({type:"tool", tool, output:{...}})   // 真实 latency/token
     generateArtifact({ ..., evidence: topN(evidence, task) })  // 引用注入 system prompt
T2 (短事务): artifact + task=submitted + run=succeeded + 计费 + audit
失败: T3 (短事务) run=failed + task=failed + audit（不再笼统 ValidationError）
```

关键规则：

1. **工具总数与预算上限**：单 run 最多 `config.connectors.maxToolCallsPerRun`（建议 3），单次 8s，run 总 20s（沿用现有模型超时）。超限 → `status:"error", code:"timeout"`，**run 仍可成功产出无证据草稿，但 artifact 的 `sourceType` 必须是 `model_generated` 且在 UI 标注「无外部证据」**。
2. **失败不静默**：`not_connected` 只在「该 kind 没有任何 connector 行」时出现；有 connector 但调用失败必须是 `error` + 具体 `errorCode`。
3. **审批消费**：`UPDATE approvals SET consumed_at=now(), consumed_by_run_id=? WHERE id=? AND status='approved' AND consumed_at IS NULL RETURNING *`，0 行 → 409，并在同事务写 `audit.approval.consume`。
4. **幂等**：`tool_calls.idempotency_key` 唯一冲突 → 返回上次结果，不重发。对外 HTTP 头带 `Idempotency-Key`（Cal.com / Stripe 都支持）。
5. **LLM 不在事务内**：沿用 `docs/trust-and-memory-plan.md` 的 I3。

### 3.5 动作分级与治理强度

| 动作 | 可逆性 | L1 | L2 | L3 | 额外要求 |
| --- | --- | --- | --- | --- | --- |
| `search.query` | read | allow | allow | allow | 只读、可缓存、有配额 |
| `calendar.list_events` | read | allow | allow | allow | 只读 |
| `calendar.create_event` | reversible_write | suggest | require_approval | allow（grant + 预算内） | 必须可撤销入口 |
| `email.send` | irreversible_write | suggest | require_approval | require_approval（**L3 不豁免**） | outbox + 幂等 + 发件人白名单 |
| `booking.create` | irreversible_write | suggest | require_approval | require_approval | 需 slots 先查后订 + 金额上限 |
| `payment.charge` | irreversible_write | deny | deny | require_approval + 金额/商户白名单 | 受限 token、对账、永不自动重试 |

**这张表是本计划的核心判断**：`decideRun` 现在把 L3 的 external_action 直接 `allow`（`policy.ts:356-361`），对搜索可接受，对发信/预订/支付不可接受。分级必须按可逆性，而不是按「是不是 external_action」。

### 3.6 验收改造（`acceptance.ts`）

新增验收项类型（保持向后兼容）：

```ts
| { type: "min_evidence"; value: number; required: boolean }      // 数 evidence 表行数
| { type: "evidence_domains"; value: string[]; required: boolean } // 要求来源域名集合
| { type: "every_claim_cited"; required: boolean }                // 正文每个 `<cite:evd_...>` 都存在
```

`min_sources` 保留但降级为 legacy：当任务有 `sourceType` 相关要求时不使用它；新任务模板（`src/contracts/templates.ts`、`src/lib/db/seed.ts`）改用 `min_evidence`。`auditTask` 的 `evaluateAcceptance(artifact.content, ...)` 需要多传一个 `evidence: Evidence[]` 上下文（签名改为 `evaluateAcceptance({ content, evidence, checklist })`）。

### 3.7 UI

- `/settings/connectors`：列表 + 状态灯（`active`/`degraded`/`revoked`）+ 「测试连接」按钮 + 最近错误。
- `/tasks/[id]`：tool 步骤渲染 `errorCode` 徽章与 evidence 列表（复用 `Evidence` 结构，`src/lib/db/schema.ts:16` 已有 `label/ref/quote`）。
- 审批卡片：显示「将要调用什么工具、目标是什么、金额多少、幂等键」，而不只是任务标题。

---

## 4. 分阶段执行计划

每阶段独立可回滚，gate 不过不进下一阶段。

### P0 · 执行语义基座（预估 2–3 天）

**改动**
- `drizzle/0010_connectors.sql`：§3.3 全部表 + `approvals` 补列。
- `src/lib/connectors/{types,registry,secrets,errors}.ts`：契约、注册表、凭证解密（AES-256-GCM）、错误映射。
- `src/lib/domain/tool-plan.ts`：`planTools(agent, task)` —— 用 `agent.tools` × `agent_grants` × `task.actionType` 决定可调用工具，替换 `run.ts:376-397` 的三元表达式。
- `src/server/services/commands/tasks/run.ts`：抽出 `executeToolCalls()`；`not_connected` 语义收窄；tool step 写真实 latency。
- `src/lib/domain/policy.ts`：修 §1.3 的早返回——`approved` 时仍校验 grant 与预算，并校验 `payload_hash`。
- `src/lib/account.ts`：导出/删除覆盖 4 张新表。
- `src/app/api/connectors/*`：`GET/POST/DELETE`，走 `handleMutation`（CSRF + 限流 + 幂等）。
- README 的 4 处 `not_connected` 描述（`README.md:31/112/119/250`）。

**测试**
- `tests/unit/connectors-registry.test.ts`：provider 缺 key → `not_connected`；有 key 但 401 → `unauthorized`。
- `tests/unit/tool-plan.test.ts`：无 grant 的工具不出现；`actionType=internal` 时不可调用 `email.send`。
- `tests/unit/policy-approval.test.ts`：审批通过但无 grant → deny；`payload_hash` 不匹配 → deny；二次消费 → 409。
- `tests/integration/run-tool-step.test.ts`：tool step 的 `output.status` 只能是 4 个枚举值；`latencyMs > 0`。
- `tests/integration/account-export.test.ts`：新表出现在导出 JSON 中，删除后 0 行。

**Gate**：`pnpm typecheck && pnpm lint && pnpm test` 全绿；`not_connected` 文案只在「无连接器」时出现。

**回滚**：迁移 additive，回滚只需 revert 代码 + 保留空表。

---

### P1 · Web 搜索（预估 3–4 天）

**改动**
- `src/lib/connectors/search/brave.ts`、`search/tavily.ts`（主备），共用 `search/types.ts`。
- `src/lib/connectors/search/normalize.ts`：把 `{title,url,snippet}` 归一成 `EvidenceInput`（`url`、`title`、`publisher`、`quote`、`retrieved_at`、`content_hash`）。
- `src/lib/llm.ts`：`generateArtifact` 增加 `evidence` 输入，system prompt 要求「每条结论标注 `<cite:evd_xxx>`，没有证据就说不知道」。
- `src/lib/domain/acceptance.ts`：`min_evidence` / `every_claim_cited`（§3.6）。
- `src/app/tasks/[id]/page.tsx`：tool 步骤下展开 evidence 列表。
- `src/contracts/templates.ts` + `src/lib/db/seed.ts`：Iris 的工具与验收清单改为 `search.query` + `min_evidence`。

**关键测试**
- `tests/unit/acceptance-evidence.test.ts`：正文有 2 个假 URL 但 evidence 表 0 行 → `min_evidence` 失败（回归 §1.2）。
- `tests/integration/search-run.test.ts`：mock Brave 返回 3 条 → evidence 3 行 → `min_evidence:2` 通过；`<cite:evd_>` 全部可解析。
- 失败注入：429 → `rate_limited` 且 `retryable=true`；超时 → `timeout`；返回 HTML 而非 JSON → `invalid_response`。
- 主备切换：主 provider 401 → 自动切备，`tool_calls` 记录两条（第一条 `unauthorized`）。
- `pnpm test` 全程不打真实网络（mock `fetch`，断言 URL 与 header）。

**Gate**：一条真实任务从「执行」到「验收通过」，Run Trace 里能看到 real evidence 与其 URL；关掉外网时该任务被正确拒绝而不是假通过。

**风险**：搜索结果质量不稳定。缓解——`quote` 必须有原文片段，否则该条 evidence 不入库。

---

### P2 · 只读日历（预估 2–3 天）

**改动**
- `src/lib/connectors/calendar/google.ts`：OAuth2 授权码 + 刷新令牌，scope 仅 `calendar.readonly`（§2.2）。
- `src/app/api/connectors/google/callback/route.ts`、`src/app/api/connectors/[id]/refresh/route.ts`。
- 工具：`calendar.list_events`（时间窗 + 关键词），evidence `kind:"calendar_event"`。
- `runTask`：把「今天/本周的占用」摘成 5 行进 context，供 Coach/Treasurer 判断可行性。

**测试**
- token 过期自动刷新一次；刷新失败 → `unauthorized` + connector `status:"revoked"` + UI 提示重连。
- 只读断言：adapter 只允许 GET 类端点，写方法在类型层不可达（`calendar.write` 不存在于 `ToolDescriptor`）。
- 凭证明文不得出现在 `steps.output`、`tool_calls.response_summary`、日志（测试断言无 token 子串）。

**Gate**：未验证 OAuth 应用下（100 用户上限）本地开发可完整跑通；不存在任何写日历的代码路径。

**回滚**：删除 connector 行 + 撤销 Google 授权即可，数据库无副作用。

---

### P3 · 邮件（预估 3–4 天）

**改动**
- `src/lib/connectors/email/smtp.ts`（nodemailer 或原生 SMTP）与 `email/http.ts`（事务邮件 API），`gmail.send` 作为可选 provider。
- `outbox` 写入 + 消费者（同进程 worker，`setInterval` 或 route 触发；不引入队列服务）。
- 审批卡片展示「收件人、主题、正文摘要、幂等键」；`payload_hash` 绑定正文。
- 幂等：`idempotencyKey = sha256(userId|"email.send"|to|subject|bodyHash)`。

**测试**
- 同一 `Idempotency-Key` 重放 → 只发一封（断言 adapter 被调用一次）。
- outbox `attempts=5` → `dead`，任务状态回到 `rejected` 且 audit 记录原因。
- 审批后修改正文 → `payload_hash` 不匹配 → 拒绝执行。
- `SMTP` 连接超时 → `timeout`，不重试超过 3 次。
- 发件域 SPF/DKIM 未配置时文档提示（不阻塞流程）。

**Gate**：任何一次实际发信都能在 `tool_calls` 找到唯一记录，且该记录能追溯到审批 ID 与 run ID。

---

### P4 · 预订（预估 2–3 天）

**改动**
- `src/lib/connectors/booking/calcom.ts`：`slots` 查询 + `bookings` 创建 + webhook 回调（`/api/webhooks/calcom`，校验签名）。
- 工具：`booking.list_slots`（read）、`booking.create`（irreversible_write）。
- 先查后订：`booking.create` 必须携带前一步 `slots` 结果的 `slotId`，否则拒绝（防模型编造时间）。

**测试**
- 缺 `slotId` → `invalid_response`/`policy_denied`。
- webhook 重复投递 → 幂等（`external_id` 唯一）。
- 时区：用户 `users.timezone`（`src/server/services/queries/task.ts` 已读取）必须进入请求，测试覆盖跨时区。

**Gate**：booking 创建前必有审批；取消路径可执行；webhook 幂等。

---

### P5 · 支付（预估 3–5 天 + 合规评估，**默认不启用**）

**前置条件（全部满足才进入实现）**
1. P3 的 outbox + 幂等 + 审批消费已在生产验证 ≥ 2 周。
2. 明确商户与场景（单商户、单币种、金额上限由 `policy_config` 提供）。
3. 法务/合规确认（SCA/3DS、退款流程、对账口径）。

**方案**：Stripe Agentic Commerce 路线——`Shared Payment Tokens`（作用域受限、可撤销）或 `Link Agent Wallet`；**不使用**长期卡号。工具 `payment.quote`（read）与 `payment.charge`（irreversible_write，L3 仍强制审批）。

**硬约束**
- 金额上限与商户白名单来自配置表，不写死。
- `payment.charge` 永不自动重试（`retryable: false`），失败即 `dead` + 人工介入。
- 每笔支付写 `audit.payment.authorize` / `audit.payment.settle`，可对账。
- 保留「不实现支付」的开关：`CONNECTORS_PAYMENT_ENABLED=false` 时工具不注册。

**Gate**：沙箱全链路 + 对账脚本 + 回滚预案（撤销 token）演练通过。

---

## 5. 测试策略（跨阶段）

| 层级 | 内容 | 工具 |
| --- | --- | --- |
| 契约测试 | 每个 adapter 对同一组 fixture 产出相同 `EvidenceInput` 形状 | vitest |
| 单元 | policy 矩阵、tool-plan、acceptance 新类型、幂等哈希 | vitest |
| 集成 | mock `fetch`（不触网）；429/500/超时/畸形 JSON/超大响应 | vitest + 现有隔离库 |
| 幂等 | 同 key 重放、并发同 key、审批二次消费 | 集成 |
| 隐私 | 导出含新表；删除后无残留；token 不出现在任何 output | 集成 |
| 回归 | `min_sources` 旧用例仍通过（legacy 路径） | 单元 |

所有外部调用必须可注入 `fetch`，**CI 不允许真实出网**（这是本计划对测试基建的唯一硬要求）。

---

## 6. 风险登记册

| # | 风险 | 触发条件 | 缓解 |
| --- | --- | --- | --- |
| R1 | 接了搜索但验收仍数文本 URL → 假证据 | 只做 P1 不做 §3.6 | P1 gate 强制 evidence 计数 |
| R2 | 审批一次、执行多次 | 复用 `consumedAt` 未实现 | P0 实现条件更新 + 唯一约束 |
| R3 | 重复发信/重复预订 | 无 outbox、无工具级幂等 | P0/P3 幂等键 + outbox |
| R4 | 凭证泄漏 | token 进 `steps.output`/日志 | adapter 契约禁止；集成测试断言 |
| R5 | 20s 同步 run 被外部慢接口拖死 | 单次 8s × 3 次 | 预算 + 熔断 + 降级为无证据草稿 |
| R6 | 主供应商限流/涨价 | 单点依赖 | provider 抽象 + 主备 |
| R7 | CASA 成本被低估 | 顺手加 Gmail 读取 | 只做 `gmail.send` 或 SMTP |
| R8 | 支付被当成普通 external_action | 沿用现有 L3 allow | §3.5 分级表 + 配置开关 |
| R9 | 新表漏出账户导出/删除 | 忘记改 `account.ts` | P0 测试覆盖 |
| R10 | MCP 版本演进导致返工 | 把协议焊进 run 流程 | adapter 与 transport 分离 |

---

## 7. 与既有计划的关系

- `docs/superpowers/plans/2026-10-22-data-trust-and-real-data.md`
  - **Task 8（文件导入）**：独立，不冲突；其 provenance 工作可复用 `evidence` 表（`kind:"web_page"` 之外加 `"file"`）。
  - **Task 9（带引用 web search）**：本计划 P1 **取代**其实现细节，保留其「必须有引用」的目标。
  - **Task 10（只读日历）**：本计划 P2 取代，范围一致。
  - **Release Gates（不实现 BYOK / 日历写入 / 预订 / 支付）**：本计划 P3–P5 明确在该 gate 之后，且 P5 默认关闭。
- `docs/remediation-plan.md`：本计划的 policy 修补（§1.3）属于 I3 的延伸；迁移仍走 additive。
- `docs/trust-and-memory-plan.md`：I3「LLM 不在事务内」被沿用；新表需并入 A3/A4 的幂等与约束。

---

## 8. 里程碑与工作量

| 里程碑 | 内容 | 预估 | 完成后可见变化 |
| --- | --- | --- | --- |
| M0 | P0 基座 | 2–3 天 | 工具步骤有真实语义与错误码；审批不可复用 |
| M1 | P1 搜索 | 3–4 天 | 真实证据 + 可点击引用；假 URL 不再通过验收 |
| M2 | P2 日历只读 | 2–3 天 | 排期判断基于真实占用 |
| M3 | P3 邮件 | 3–4 天 | 审批后可发信，且只发一次 |
| M4 | P4 预订 | 2–3 天 | 可查 slots 并下单，带审批与幂等 |
| M5 | P5 支付（默认关闭） | 3–5 天 + 合规 | 受限 token 试点 |

合计 P0–P2 ≈ **8–10 天** 得到「可信的只读外部世界」；P3–P4 再 **5–7 天** 得到「可控的写动作」。P5 不计入常规排期。

---

## 9. 明确不做（本次范围外）

- 不做 Agent 自主扣款、不做长期卡号存储。
- 不做日历写入（P2 只读；写入归入 P3+ 批次）。
- 不做 Gmail 读取（`gmail.readonly` → CASA）。
- 不引入队列/消息中间件；outbox 用表 + 进程内消费者。
- 不引入新框架；`ai@7` 的 `tool`/`stopWhen` 足够。
- 不改 UI 视觉体系（只加 `/settings/connectors` 与 trace 里的 evidence 区块）。

---

## 10. 参考来源

- Brave Search API 定价（$5/1k requests，每月 $5 额度，50 rps）：<https://api-dashboard.search.brave.com/documentation/pricing>
- Bing Web Search API 已归档为 previous-versions（最后更新 2025-05-07）：<https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/overview>
- MCP 规范 2026-07-28（JSON-RPC、tools/resources/prompts、authorization、Tasks 扩展）：<https://modelcontextprotocol.io/specification/2026-07-28>
- Cal.com API v2（OAuth / API key、120 req/min、bookings/slots/webhooks）：<https://cal.com/docs/api-reference/v2/introduction>
- Stripe Agentic Commerce（Link Agent Wallet、Shared Payment Tokens、UCP、x402/MPP）：<https://docs.stripe.com/agentic-commerce>
- Google scope 与 CASA 分级（`gmail.send` sensitive 非 restricted；restricted 需年度安全评估；CASA 成本与审核周期）：<https://developer.nylas.com/docs/provider-guides/google/google-verification-security-assessment-guide>、<https://deepstrike.io/blog/google-casa-security-assessment-2025>
- agent 支付协议对比（AP2 / Visa IC / Mastercard Agent Pay / Stripe ACP / x402）：<https://atxp.ai/blog/mastercard-agent-pay-stripe-acp-visa-x402-comparison-2026>
