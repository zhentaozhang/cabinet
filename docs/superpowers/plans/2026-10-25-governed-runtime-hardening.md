# Governor Runtime 加固实施计划（Phase 0–4，v2）

> **For agentic workers:** 逐 Task 执行，先失败测试再实现。步骤用 `- [ ]` 勾选。
> **过程要求（用户 m00072）：** 计划 → 执行 → 独立审查，审查通过后任务才算完成。
> **v2 修订：** 依据独立审查（12 条问题）改正了 planTools 的动态工具解析、step 状态枚举、MCP 协议版本头、lib→server 分层倒置、Merkle 单叶定义、manifest 字段缺失、验收类型缺漏、recovery 判定漂移等。

**Goal:** 补上调研报告（docs/competitive-analysis.md）里"可离线验证"的劣势，并把最高杠杆的亮点（任务级 MCP 治理、可离线验证的 run manifest）做成真实可跑的能力。

**Architecture:** 四段串行：先让过程可见（span），再让工具可调（MCP + 受治理调用），再让结论可验（manifest），最后导出验收契约。每段独立可交付、独立回滚，全部先有失败测试。

**Tech Stack:** Next.js 16 · React 19 · TS · Drizzle · vitest 5 · Postgres 18（隔离库 per run）

---

## 范围决定（含明确的"不做"）

| 报告项 | 本计划 | 理由 |
|---|---|---|
| P0-1 执行面薄（无工具循环/无 MCP） | **做（Phase 2）** | 分水岭；也是亮点 ★1 |
| P0-3 无 OTel span | **做（Phase 1）** | 低风险高收益，零新依赖 |
| ★2 manifest 可离线验证 | **做（Phase 3）** | 差异化最强，纯逻辑可完全单测 |
| ★4 验收契约导出 | **做（Phase 4）** | 小，复用已有 acceptance 结构 |
| P0-2 记忆无向量 | **不做** | 本机 Postgres 18 `pg_available_extensions` 只有 `pg_trgm`，没有 `vector`（实测）；换镜像+迁移+嵌入供应商是独立工程，硬塞就是假向量 |
| P0-4 judge 验收 | **不在本期** | 需真实模型才能验证；无 key 只能测降级路径 |
| P1 单供应商/RBAC/外部执行器 | **不做** | 单供应商是已声明边界；RBAC 与"个人优先"定位冲突 |

**硬约束（AGENTS.md，违反即返工）：** 状态写回带条件+查影响行数（空→`ConflictError`）；无证据写 `undetermined`；时间用 `sql`now()``；后台只走 `pnpm tick`；**不新增运行时依赖**；每个 Task 一次 `git commit`。

---

## 文件结构

```
新增  src/lib/observability/tracing.ts             span 核心（ALS 传父级，无网络）
新增  src/lib/observability/otlp.ts                OTLP/HTTP JSON 组装 + 队列 + flush（含 test seam）
改    src/lib/observability/context.ts             复用其 ALS 模式，不合并
新增  src/lib/mcp/protocol.ts                      JSON-RPC 2.0 报文 + SSE 解析 + 结果提取
新增  src/lib/mcp/client.ts                        initialize/initialized/tools/list/tools/call
新增  src/lib/mcp/outcome.ts                       McpOutcome（独立类型，不套 SearchOutcome）
新增  src/lib/mcp/registry.ts                      工具名→resource/scope 的显式映射（fail-closed）
改    src/lib/domain/tool-plan.ts                  planTools 增加 extraSpecs 解析器；扩展 ToolStepStatus
改    src/lib/presentation/task-view.tsx           TOOL_STATUS_MAP 补新状态（Record<string,…>，靠类型检查兜底）
新增  src/server/services/commands/tasks/governed-call.ts   授权→预扣→调用→记账（server 层，避免 lib→server）
新增  src/server/services/commands/tasks/tool-loop.ts       受限循环（maxSteps）
改    src/server/services/commands/tasks/run.ts    step→span；工具分支接 tool-loop
改    src/server/services/commands/tasks/recovery.ts  判定补 MCP 状态（同一 Task 内）
新增  src/lib/domain/manifest.ts                   构建 + Merkle + 离线校验（复用 ids.ts 的 sha256/canonicalJson）
新增  src/app/api/tasks/[id]/manifest/route.ts     导出端点
新增  scripts/verify-manifest.ts                   离线校验 CLI
新增  src/lib/domain/acceptance-export.ts          7 种验收项 → JSON Schema，确定性
改    src/lib/db/schema/ops.ts + drizzle/*          mcp_servers 表（0031）
新增  tests/unit/{tracing,tracing-export,mcp-protocol,governed-call,manifest,acceptance-export}.test.ts
新增  tests/integration/{mcp-client,tool-loop,manifest,manifest-route,schema-mcp}.test.ts
```

---

## Phase 0 — 地基（已完成）

- [x] README 四处于实测对齐（route 45、测试 104/908、执行模型、已知边界）。
- [x] `docs/ci-status.md`：六项 API 证据 + 三个被证伪假设 + 两种未判定假设；不改 workflow（无证据时不猜）。

---

## Phase 1 — P0-3：run / step 变成 span

**设计要点**
- 开关：仅当 `OTEL_EXPORTER_OTLP_ENDPOINT` 存在才导出；否则 `startSpan` 返回 no-op，零网络零定时器。
- 层次：`run` = 根 span，`steps` 每行 = 子 span，`AsyncLocalStorage` 传当前 span（与 `context.ts` 同法，不合并）。
- 绝不阻塞主链：导出队列 + 定时 flush（`timer.unref()`），失败只 `logEvent("warn", …)`。
- 属性白名单：只允许 `run.id / task.id / agent.id / step.idx / step.type / step.tool / gen_ai.*`；出现 `apiKey|authorization|prompt|content` 键一律丢弃。
- **测试 seam（v2 修正）**：`otlp.ts` 导出 `__setSinkForTests(sink: (spans: FinishedSpan[]) => void)`，测试不依赖网络。

### Task 1.1 span 核心
**Files:** `src/lib/observability/tracing.ts`；测试 `tests/unit/tracing.test.ts`

- [x] 失败测试：无 env 时 `startSpan({name:"run"})` 返回 `traceId`(32 hex)/`spanId`(16 hex)/`sampled=false`；`end()` 后 `endTimeUnixNano >= startTimeUnixNano`。
- [x] 失败测试：`withSpan` 内开的子 span `parentSpanId === 父 spanId`，`traceId` 继承。
- [x] 失败测试：attrs 含 `apiKey`/`authorization`/`prompt` → 该键被丢弃，其余保留。
- [x] 失败测试：`fn` 抛错 → span `status.code=2` 且 `status.message` 是错误消息，**异常继续往外抛**。
- [x] 实现 → `vitest run tests/unit/tracing.test.ts` 绿。

### Task 1.2 OTLP 导出
**Files:** `src/lib/observability/otlp.ts`；测试 `tests/unit/tracing-export.test.ts`

- [x] 失败测试：`toOtlpPayload([a,b])` → `{resourceSpans:[{resource:{attributes:[{key:"service.name",value:{stringValue:"cabinet"}}]},scopeSpans:[{scope:{name:"cabinet"},spans:[…]}]}]}`；`startTimeUnixNano` 是 19 位十进制**字符串**。
- [x] 失败测试：kind INTERNAL=1 / SERVER=2；status UNSET=0 / ERROR=2。
- [x] 失败测试：`flush(endpoint, spans, fetchImpl)` 请求 `${endpoint}/v1/traces`（endpoint 尾部 `/` 先剥离），`content-type: application/json`；fetch 抛错返回 `{ok:false}` 且不抛。
- [x] 失败测试：队列上限 512，溢出丢最旧并累加 `dropped`。
- [x] 实现（含 `__setSinkForTests`；`timer.unref()`）→ 绿。

### Task 1.3 接进 runTask
**Files:** `run.ts:345-367`（addStep）、`run.ts:369+` 的 try 段；测试 `tests/integration/tracing-run.test.ts`

- [x] 失败测试：用 `__setSinkForTests` 收集 span，跑一次 runTask（无模型 key，走 not_connected 路径）→ 恰好 1 个 `run.execute` 根 span（带 `run.id`），step span 数 = steps 行数。
- [x] `addStep` 内开子 span（`name=step.type`，attrs `step.idx/step.tool`），写入后 end。
- [x] 回归：run 抛 `ConflictError` 时根 span `status.code=2`，且**返回值/异常与改动前一致**（跑既有 `tests/integration/*run*.test.ts`）。
- [x] 绿。

### Task 1.4 文档
- [x] `docs/observability.md` 增 "Trace 层"：开关、字段映射、与审计链分工（审计=结论/trace=诊断）、丢弃策略。

**落地记录（2026-10-25）**

- 与计划的两处偏离，都是把「采样」表达得更简单：没有 `sampled` 字段，而是「没配 endpoint 就没装 sink」——
  span 照建（微秒级），但一个字节都不发。测试用 `setSpanSink` 收集；生产用 `installOtlpExporterIfConfigured()`，
  `src/instrumentation.ts`（Next 启动钩子）和 `scripts/run-worker.ts`（CLI 没有 Next 运行时）各调一次。
- 文件名：单测是 `tests/unit/otlp.test.ts`（计划里写的 `tracing-export.test.ts`），
  run 级是 `tests/integration/tracing.test.ts`。
- step 子 span 用 `startSpan` 直接开而不是 `withSpan`：插入完就 end，`withSpan` 的异常语义用不上。
- 额外补的：导出队列上限 512 + `dropped` 计数（计划要求）；属性键命中 `prompt|content|body` 也丢，比计划的四类更宽。
- bigint 字面量在本仓库不可用（`target: ES2017`），统一用 `BigInt(...)` 构造。

验证：`tsc --noEmit` 干净；`vitest run` **107 文件 / 925 用例全绿**（基线 104/908，新增 3 文件 17 例）；
eslint 干净。

---

## Phase 2 — P0-1 / ★1：MCP client + 受治理工具循环

**设计要点（v2 修正后）**
- 传输只做 Streamable HTTP（POST JSON-RPC；响应可能是 `application/json` 或 `text/event-stream`）。**不做 stdio**（起子进程不可测）。
- 协议版本：`initialize` 后，所有 POST 必须带 `MCP-Protocol-Version: 2025-06-18`、`Accept: application/json, text/event-stream`、以及服务端返回的 `Mcp-Session-Id`。会话过期 = **HTTP 404**（重新 initialize），不是 401。
- 结果类型独立：`McpOutcome = {ok:true, latencyMs, content} | {ok:false, latencyMs, error: ConnectorError}`（复用 `ConnectorErrorCode`，不发明 `upstream_error`）。
- 治理顺序不可换：`planTools(specs)` → 预算预扣 → 调用 → 结算 → 写 step；`governedCall` 放 **server 层**（`src/lib` 不得 import `@/server`，`tests/unit/boundary.test.ts` 会拦）。
- **动态工具解析（堵住"永远 unknown_tool"）**：`planTools` 增加 `extraSpecs?: Record<string, ToolSpec>`，合并优先级 = extraSpecs 覆盖 TOOL_SPECS；未注册的 MCP 工具仍是 `unknown_tool`（fail-closed）。
- step 状态：`ToolStepStatus` 增加 `budget_exceeded`、`step_limit`（`task-view.tsx` 的 `TOOL_STATUS_MAP` 同步补 label/tone/description），其余沿用 `ok|not_connected|skipped|unauthorized|rate_limited|timeout|invalid_response`；`ConnectorErrorCode` 映射：`not_configured→not_connected`、`unauthorized→unauthorized`、`rate_limited→rate_limited`、`timeout→timeout`、`invalid_response→invalid_response`、`network_error→not_connected`。
- 单 run 上限 `maxSteps`（默认 2，env `RUN_MAX_TOOL_STEPS`）；超限写 `step_limit` step 后收尾。

### Task 2.1 协议层
**Files:** `src/lib/mcp/protocol.ts`；测试 `tests/unit/mcp-protocol.test.ts`

- [x] 失败测试：`jsonRpcRequest("tools/call",{name,arguments},7)` → `{jsonrpc:"2.0",id:7,method,params}`；`parseJsonRpcResponse` 同时处理 `result` 与 `error`。
- [x] 失败测试：SSE `event: message\ndata: {...}\n\n` 解析 1 条；`: ping` 忽略；多 event 按序。
- [x] 失败测试：`extractToolResult` 支持 `{content:[{type:"text",text}], isError}`；`isError:true` → `ok:false, code:"invalid_response"`。
- [x] 绿。

### Task 2.2 client
**Files:** `src/lib/mcp/client.ts`、`src/lib/mcp/outcome.ts`；测试 `tests/integration/mcp-client.test.ts`（`node:http` 起进程内假 server，统一用 integration 路径，消除 v1 自相矛盾）

- [x] 失败测试：`initialize` 带 `protocolVersion/clientInfo`，收 `Mcp-Session-Id`；之后每个 POST 都带 session 头 **和** `MCP-Protocol-Version`。
- [x] 失败测试：`initialize` 后发 `notifications/initialized`（无 id、不期待响应）。
- [x] 失败测试：`listTools()` 返回 `[{name,description,inputSchema}]`。
- [x] 失败测试：`callTool` 超时（默认 15s，可注入）→ `{ok:false,error:{code:"timeout"}}`，不抛。
- [x] 失败测试：HTTP 401 → `unauthorized`；404 → 触发一次重新 initialize 后重试，仍失败则 `invalid_response`；500 → `network_error, retryable:true`。
- [x] 绿。

### Task 2.3 schema + 迁移
**Files:** `src/lib/db/schema/ops.ts`（**不是** schema.ts 那个 barrel）+ `drizzle/`；测试 `tests/integration/schema-mcp.test.ts`

- [x] 失败测试：插入 `mcp_servers(user_id,name,url,resource,enabled)`；`(user_id,name)` 唯一冲突抛错；`enabled` 默认 true。
- [x] `drizzle-kit generate`（应生成 0031）→ 隔离库 migrate 通过。
- [x] 绿。

### Task 2.4 governedCall
**Files:** `src/server/services/commands/tasks/governed-call.ts`；测试 `tests/unit/governed-call.test.ts`

- [x] 失败测试：未授权 → `{ok:false,status:"unauthorized"}` 且 fetch 调用 0 次（spy 断言）。
- [x] 失败测试：`reserveBudget` 返回 `{allowed:false}` → `status:"budget_exceeded"`，不调用。
- [x] 失败测试：成功 → 结算金额 = 预留值（本期恒 0，但必须走同一对函数，否则以后加计费必漏账）。
- [x] 失败测试：调用抛错 → 释放预留，不产生负账。
- [x] 绿。

### Task 2.5 工具循环接入 + 状态枚举
**Files:** `src/server/services/commands/tasks/tool-loop.ts`、`run.ts:545-571`、`tool-plan.ts`（`extraSpecs` + 状态枚举）、`task-view.tsx`、`recovery.ts:62-67`；测试 `tests/integration/tool-loop.test.ts`

- [x] 失败测试（回归）：无 MCP server 时行为与改动前完全一致。
- [x] 失败测试：`planTools` 对 `extraSpecs` 里注册的工具返回 planned；未注册仍是 `unknown_tool`。
- [x] 失败测试：授权 MCP 工具 → 1 次调用、1 行 step、`status:"ok"`、`tool` 为 MCP 工具名。
- [x] 失败测试：`maxSteps=2` → 最多 2 次调用，第 3 次截断并写 `step_limit`。
- [x] 失败测试：MCP 超时 → step `timeout`，run 正常收尾。
- [x] 失败测试（recovery）：含 `ok`/`timeout`/`invalid_response`/`rate_limited` 之外，MCP 成功调用的 step 也必须被判定为"已接触供应商"（断言 `settleBudget` 收到 `unknown_usage` 而非 `not_contacted`）。
- [x] 绿。

### Task 2.6 文档
- [x] `docs/mcp.md`：能力边界（仅 Streamable HTTP）、授权模型（resource 显式配置、fail-closed）、预算语义（预扣/结算/释放）、失败枚举映射、为什么不做 stdio、未对真实第三方 server 验证。

**落地记录（2026-10-25）**

- `McpOutcome` 留在 `src/lib/mcp/client.ts`，没有单独建 `outcome.ts`：一个类型的文件不抵一次 import。
- 默认客户端超时 8000ms（计划写 15s），与 `SEARCH_TIMEOUT_MS` 对齐；`runMcpToolLoop` 新增 `timeoutMs` 透传，测试用 150ms（否则一个超时用例要跑满 8 秒）。
- `callTool` 的参数固定是 `{query}`：schema 驱动的参数生成要等有真实 server 再做，凭空的参数映射只是装饰。
- `settleBudget` 的 `SettleInput` 新增 `reservationId`、`runId` 改为可选（二者至少一个，否则抛错）。原因：`agent_budget_reservations` 有 `WHERE run_id IS NOT NULL` 的部分唯一索引，一次 run 只能有一条带 runId 的预留；MCP 每次调用持有自己的 0 分预留，必须按 id 结算。
- recovery **没有改代码**：MCP step 写 `provider: "mcp:<name>"`，成功的 status 是 `ok`，`recovery.ts:62-67` 的两条旧规则都已覆盖；用 `tests/integration/tool-loop.test.ts` 的一个用例固化（断言 run 以「可能已调用供应商」收尾）。
- `tools/list` 实现了但 run 里不用：声明即权限。让上游返回的工具集决定本地下限，等于把策略交给外部服务。
- 工具步上限默认 2，`RUN_MAX_TOOL_STEPS` 覆盖；超限写一条 `step_limit` step 并列出被跳过的工具名，不静默丢弃。
- `mcp_servers` 只有表和迁移，没有 UI/API 写入入口（`docs/mcp.md` 里写明现状）。

验证：`tsc --noEmit` 干净；eslint 干净（只剩 `.archify/` 里未跟踪产物的旧 warning）；
`vitest run` **112 文件 / 964 用例全绿**（Phase 1 后基线 107/925，新增 5 个测试文件所在 39 例）；
`bash scripts/verify.sh` 全过（fresh db migrate → typecheck → lint → vitest → next build）。

---

## Phase 3 — ★2：可离线验证的 run manifest

**设计要点（v2 修正）**
- 叶子 = `sha256(canonicalJson(item))`，复用 `src/lib/ids.ts:13-30`。
- Merkle 规则（写死，禁止"自己实现自己验"）：
  - `n=0 → null`；`n=1 → 该叶值原样`；`n≥2` 成对 `sha256(a+b)`，`a`/`b` 按字典序取小在前；**奇数个时最后一个节点直接晋级下一层**（不复制，避免与 n=1 断言冲突）。
- manifest 字段（v2 补齐 ★2 承诺）：`{version, runId, taskId, agentId, createdAt, model:{provider,model}, promptVersion, steps[], artifacts:[{id,sha256}], evidence:[{id,contentHash}], acceptance:[{item,verdict,undetermined}], approvals:[{id,approverId,decidedAt}], auditHead:{seq,hash}, merkleRoot}`。
- `verifyManifest` 必须**真的校验 auditHead**：读该 user 的审计链，确认 seq 存在且 hash 匹配，不匹配返回 `{ok:false, mismatches:[{path:"auditHead",…}]}`。

### Task 3.1 Merkle + 校验
**Files:** `src/lib/domain/manifest.ts`；测试 `tests/unit/manifest.test.ts`

- [x] 失败测试：`merkleRoot([])` → `null`；`merkleRoot([h])` → `h`（原样）；`merkleRoot([a,b])` → `sha256(min+max)`。
- [x] 失败测试：n=3 时第 3 个直接晋级（手算期望值写进断言）。
- [x] 失败测试：改任一叶 → root 变（3 组样本）。
- [x] 失败测试：`verifyManifest` 对篡改的 `auditHead.seq`/`hash` 返回 `ok:false`，`mismatches[0].path="auditHead"`。
- [x] 绿。

### Task 3.2 构建 + CLI
**Files:** 同文件 + `scripts/verify-manifest.ts`；测试 `tests/integration/manifest.test.ts`

- [x] 失败测试：`buildManifest(runId)` 的 `merkleRoot` 等于对同批 step 手算值；含 artifacts/evidence/acceptance/approvals 四组。
- [x] 失败测试：改 manifest 里某 step 的 `outputHash` 一位 → `ok:false`，path 指向该 step。
- [x] 失败测试：CLI 对篡改文件 exit 1、原文件 exit 0（`tsx` 跑，断言退出码）。
- [x] 绿。

### Task 3.3 导出端点
**Files:** `src/app/api/tasks/[id]/manifest/route.ts`；测试 `tests/integration/manifest-route.test.ts`

- [x] 失败测试：未登录 401；他人 run 404（不泄漏存在性）；本人 200 + JSON + `content-disposition` 含 runId。
- [x] 失败测试：响应体不含 prompt 哨兵字符串。
- [x] 先读 `node_modules/next/dist/docs/` 的 Route Handler 指南（Next 16）。
- [x] 绿。

---


### 落地记录（2026-10-25）

实现与计划的偏离，逐条说明原因：

1. **`ManifestStep` 多了 `inputHash`**。计划只列了 `outputHash`，但 `steps.input` 同样可被改写，
   只锁输出等于让输入可替换；输入里是 prompt 和原文，所以存哈希而不是值。
2. **`auditHead` 允许 `null`**。计划写死 `{seq, hash}`；该用户还没有审计事件时没有任何真实锚点，
   用 `seq: 0` 顶替会让校验方必须怀疑一个本来就空的锚点。`null` 在 `verifyManifest` 里进 `unchecked`，
   **不算通过**。
3. **`approvals` 里没有 `approverId`**。`approvals` 表（`src/lib/db/schema/tasks.ts:63-85`）没有这一列，
   审批人只存在于审计链的 `actor`。实现按表结构落 `{id, action, status, decidedAt}`，并在 `docs/manifest.md` 写明。
4. **没给 `chain` 时 `auditHead` 是 `unchecked` 而不是失败**。离线只验 manifest 自身是合法用法；
   但 `unchecked` 永远不会被当成通过（`AGENTS.md` 第 2 条）。
5. **路由默认跳过含 `audit` step 的运行**，并支持 `?run=<runId>` 指定。审计本身也是一次运行，
   「最新一次运行」通常是审计，导出它会描述检查者而不是被检查的活。
6. **响应体是 manifest 本体**，不是 `{ok, data}` 包装：它是下载物，带 `content-disposition`；
   错误仍走 `toErrorResponse`（401/404 与其它路由一致）。
7. **`promptVersion` 是手 bump 的整数常量** `PROMPT_TEMPLATE_VERSION`（`src/lib/llm.ts`），
   不是函数源码哈希：打包会改写源码文本，dev 与 prod 会得出不同版本号。
8. **新增 `docs/manifest.md` 与 README 一条链接**（计划未列），记录字段、Merkle 规则、CLI 与「能证明什么/不能证明什么」。

验证：`tests/unit/manifest.test.ts` 16 例、`tests/integration/manifest.test.ts` 5 例（含真实 `tsx` 子进程跑 CLI 断言退出码）、
`tests/integration/manifest-route.test.ts` 5 例；`bash scripts/verify.sh` 全过。

## Phase 4 — ★4：验收契约导出

**Files:** `src/lib/domain/acceptance-export.ts`；测试 `tests/unit/acceptance-export.test.ts`

- [x] 失败测试：**7 种**类型各产出片段：`section/min_words/min_sources/min_evidence/contains/claims_table/manual`；`manual` 标 `x-undetermined:true` 且用 `note` 字段（不是 `value`）。
- [x] 失败测试：同一 task 两次导出字节一致（无时间戳）。
- [x] 绿。

---


### 落地记录（2026-10-25）

1. **导出 + 渲染分成两个纯函数**：`exportAcceptanceContract` 返回对象（可 JSON 化、可 diff），
   `renderAcceptanceContract` 返回 Markdown。计划的「片段」两者都覆盖，但对象是可测的、Markdown 是给人签的。
2. **`spec` 不是原始 item**：六种类型用 `value`、`manual` 用 `note`，键名是实现细节；导出改成语义键名，
   `manual` 的 `spec` 为 `null`、`undetermined` 恒 true。
3. **空清单导出一条人工项**（而不是空数组）：空数组会被读成「没什么要检查的」，
   正是过去让 Auditor 写出「逐条对照通过」的措辞（`AGENTS.md` 第 2 条）。
4. **额外接了路由与读模型**（计划只写 domain 模块）：`GET /api/tasks/[id]/acceptance`（JSON）与
   `?format=markdown`（`.md` 下载），读模型 `src/server/readmodels/acceptance.ts`。
   没有出口的导出函数等于没做；路由同样把「他人任务」与「不存在」答成同一个 404。
5. **新增 `docs/acceptance-contract.md`** 与 README 链接，写清 7 种类型的 `statement`/`spec` 对照表、
   为什么没有时间戳、以及与 manifest 的分工（契约 = 规则，manifest = 某次运行的哈希）。

验证：`tests/unit/acceptance-export.test.ts` 9 例、`tests/integration/acceptance-route.test.ts` 3 例；`bash scripts/verify.sh` 全过。

## 审查关卡（每阶段结束）

1. `bash scripts/verify.sh`（migrate 临时库 → tsc → eslint → vitest → next build）。
2. 独立审查 subagent：只读 diff + 计划，核对"失败测试是否真的先红后绿"。
3. 有 ❌ 就修并重跑；三轮不过则上报。

## 已知风险
- Next 16 破坏性变更：新增 route 前读 `node_modules/next/dist/docs/`。
- 迁移验收必须用临时库（长驻库是 push 建的，migrate 会撞对象）。
- MCP 只对自建假 server 验证；真实第三方 server 的 SSE 行为可能不同，文档要写明。
- `src/lib` 的边界由 `tests/unit/boundary.test.ts` 强制，governedCall 不得放 lib。