# MCP 工具

一句话：Cabinet 的 Agent 可以调用外部 MCP server 的工具，但每一次调用都要先过
「授权 → 预算预扣 → 调用 → 结算」四道门，并且必须在 run 里留下一条 step。

这层能力解决的问题是**治理**，不是**连接**。OpenHands、goose、claude-code 都能连 MCP，
但它们回答不了「这个 Agent 凭什么可以写这个仓库」「这次调用花了多少钱」「被谁批准过」。
Cabinet 的答案是：工具在 `agents.tools` 里声明，权限在 `agent_grants` 里授予，
每一次调用在 `steps` 里留痕，预算在 `agent_budget_reservations` 里预扣再结算。

## 能力边界

| 项目 | 支持 | 说明 |
|---|---|---|
| 传输 | Streamable HTTP | `POST` JSON-RPC；响应可以是 `application/json` 或 `text/event-stream` |
| 传输 | stdio | **不支持**。起子进程在 CI 里不可测，也无法限制它的资源 |
| 协议版本 | `2025-06-18` | `initialize` 之后每个请求都带 `MCP-Protocol-Version` |
| 能力协商 | 只声明空 capabilities | 客户端不实现 sampling / roots / elicitation |
| 认证 | 无（无 OAuth，无 mTLS） | 受信任内网或自带网关时可用；公网 server 需要先加认证 |
| 工具发现 | `tools/list` | 已实现，但 run 里**不用它**来放宽权限：声明即权限（见下） |
| 会话 | server **必须**回 `mcp-session-id` | 规范里会话是可选的，本客户端把它当必需：没回就 `invalid_response` |
| 参数 | 恒为 `{ query: "<任务标题+描述>" }` | 没有按工具的入参 schema 组装参数，也没有让模型选参数；对入参不是 `query` 的第三方工具基本不可用 |
| 连接 | 每次调用新建一个 client | 一次 run 里 N 次调用 = N 次 `initialize` 握手，且不发 `DELETE` 结束会话（服务端要靠过期回收） |

## 配置一个 server

Server 记在 `mcp_servers`（迁移 `0031`）：

```
user_id  谁的数据
name     短名，工具名里引用它：mcp:<name>:<remote tool>
url      Streamable HTTP 端点
resource 预留列，**调用时不被读取**：需要的 grant 资源由 name 推导（mcp:<name>），见下
scope    read | write，默认 read
enabled  关掉即从 run 里消失（不是删数据）
```

这张表目前没有 UI/API 写入入口——迁移只保证**存储**就位。按本仓库的约定，
在 read 路径没被验证前先不做写界面。造数据直接插行或用 seed。

## 声明与授权

Agent 能用的 MCP 工具写在 `agents.tools` 里，名字格式 `mcp:<server>:<remote tool>`：

```json
["read_notes", "mcp:github:search_issues"]
```

授权仍然只看 `agent_grants`，资源是 `mcp:<name>`（由 server 的 `name` 推导，不读 `resource` 列——
否则一行自称 `web` 的 server 就能花掉别人发给 `web` 的 grant）：

```sql
INSERT INTO agent_grants (id, agent_id, resource, scope, config)
VALUES ('grt_gh', 'ag_coach', 'mcp:github', 'read', '{}');
```

为什么要「声明 + 授权」两条都写，而不是授权一次就能拿到 server 上的全部工具：

1. `tools/list` 的结果是**上游**说了算。让上游决定 Agent 的权限，等于让外部服务改你的策略。
2. 声明表是可见的：用户看 Agent 卡片就知道它大概会做什么，不用去读远端 manifest。
3. 没解析到的工具仍然是 `unknown_tool`（fail-closed）——`planTools` 的注册表可以被
   `extraSpecs` 扩展，但永远不能被绕过。

## 一次调用的顺序

顺序是契约，不可交换（`src/server/services/commands/tasks/tool-loop.ts` → `governed-call.ts`）：

1. **解析** — `mcp:<server>:<tool>` 拆成 server 与远端工具名；server 不存在 → `not_connected`
2. **计划** — `planTools` 用 `mcp:<name>` 和 server 行的 `scope` 作为 spec，查 grant；不通过 → `unauthorized`
3. **预扣** — `reserveBudget` 写一条 `agent_budget_reservations`；被拒 → `budget_exceeded`，调用不发生
4. **调用** — `createMcpClient({url}).callTool(...)`，超时由客户端负责（默认 8s）
5. **结算** — 成功 → `settled`；抛错、超时、网络错误、429、不可解析的应答 → `unknown_usage`（请求可能已经离开）；
   只有 401/403 或缺配置 → `released`（路上没花别人的钱）
6. **留痕** — 一条 `steps` 行：`tool`、`output.status`、`output.attempted`、`latencyMs`，
   真正发出请求时才有 `output.provider = mcp:<name>`

第 6 步的 `attempted` 是给崩溃恢复用的显式证据：早先它按「有没有 provider 字段」判断是否接触过
供应商，而那条字段在`unauthorized`/`budget_exceeded`/计划拒绝的步骤上也被写上了，于是
「没有发出请求」会被记成「可能已经花掉了钱」。现在拒绝路径写 `attempted: false` 且不带 provider，
判定集中在 `src/lib/domain/contact.ts`（`stepMadeRequest`，显式标志优先，缺省才回落到 status）。

为什么预算预扣在调用之前：预扣放在后面，模型/工具就能用「先花掉再申请」绕过额度。
为什么失败也要结算：一条不结算的预扣会永久占用额度，这正是 ledger 存在的原因。

如果进程死在「预扣」和「结算」之间，那笔预留没有任何人收尾。所以 tick 里有一个
`releaseStaleHolds`：把 `run_id IS NULL`（= 每次工具调用各自的预扣）且超过 15 分钟仍在
`reserved` 的行按 `not_contacted` 释放。run 级别的预扣不归它管——那个由
`recoverStaleRuns` 按 run 状态处理，而还在跑的 run 必须保住自己的额度。

这条兜底有一个**已知的宽松点**，写在这里而不是藏起来：每次工具调用的预扣不带 `run_id`
（它是 per-call 的，不是 per-run 的），所以它对应的 step 还没写下来时，崩溃后的 run 里没有
`attempted` 证据，恢复逻辑只能当「没发出请求」，那笔额度就被免费放行。当前
`MCP_TOOL_COST_CENTS` 是 0，所以此刻不产生账务差异；一旦给远端写调用定价，正确的做法是
调用前先落一条 in-flight 标记，或把这类 hold 记成 `unknown_usage` 而不是 `released`。

## 失败枚举

`ToolStepStatus` 是页面认的词汇，`ConnectorErrorCode` 是传输层词汇，映射在一处：

| ConnectorErrorCode | step status | 触发条件 |
|---|---|---|
| `not_configured` | `not_connected` | 没配 server |
| `network_error` | `not_connected` | 连接失败、5xx |
| `unauthorized` | `unauthorized` | 401/403，或缺 grant |
| `rate_limited` | `rate_limited` | 429 |
| `timeout` | `timeout` | 408/504，或本地超时 |
| `invalid_response` | `invalid_response` | 不是 JSON-RPC、无 text 内容、`isError: true` |

另有两个由治理层产生的状态：`budget_exceeded`（预扣被拒）、`step_limit`（本次 run 的
工具调用额度用完）。两者都**没有发出网络请求**，页面上的文案也这么写。

## 调用上限

每个 run 最多调用 `RUN_MAX_TOOL_STEPS` 次 MCP 工具，默认 2。超出的工具不会被静默丢弃：
写一条 `step_limit` 的 step，列出被跳过的工具名。

上限存在的理由：工具循环是唯一能让一次 run 的成本不受任务规模约束的地方。
默认值取 2 而不是 10，是因为默认的 run 形状是「一次检索 + 一次抓取」，
多出来的调用应该是被配置出来的，不是默认送的。

## 为什么不做的事

- **stdio**：需要起子进程，测试里无法隔离，线上无法限制 CPU/内存/文件访问。
- **HTTP+SSE（旧传输）**：`2025-06-18` 已用 Streamable HTTP 取代，同时支持两套是双倍维护。
- **OAuth**：Cabinet 没有对外发 token 的能力，也没有第三方的 client 注册表。
- **工具结果流式回传**：step 只存前 2000 字符预览，全量内容留在上游；
  要展示全文应该是 artifact，不是 step。

## 已知未验证

- 没有对真实的第三方 server 跑过（测试用进程内假 server，覆盖握手/会话/SSE/超时/错误码）。
- 会话过期靠 HTTP 404 判定并重试一次；不同 server 对「过期」的表达不一致，遇到别的码会退化成 `invalid_response`。
- `mcp_servers` 没有 UI，也没有「测试连接」按钮；配置错误的直接表现是 run 里一条 `not_connected` step。
- 参数恒为 `{query}`、必须回 session id、每次调用重新握手这三条都只在进程内假 server 上验过；
  真实第三方 server 大概率需要先补参数组装（见「能力边界」）。

## 测试

```bash
DATABASE_URL_TEST=postgres://localhost:5432/cabinet_test TZ=UTC \
  ./node_modules/.bin/vitest run \
  tests/unit/mcp-protocol.test.ts tests/integration/mcp-client.test.ts \
  tests/integration/tool-loop.test.ts tests/unit/governed-call.test.ts
```
