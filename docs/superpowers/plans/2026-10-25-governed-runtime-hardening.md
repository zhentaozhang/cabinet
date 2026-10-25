# Governor Runtime 加固实施计划（Phase 0–4）

> **For agentic workers:** 逐 Task 执行，先失败测试再实现。步骤用 `- [ ]` 勾选跟踪。
> **过程要求（用户 m00072）：** 计划 → 执行 → 独立审查，审查通过后任务才算完成。

**Goal:** 补上调研报告（docs/competitive-analysis.md）里四类劣势中"可离线验证"的部分，并把最高杠杆的亮点（任务级 MCP 治理、可离线验证的 run manifest）做成真实可跑的能力，而不是文档。

**Architecture:** 四个阶段按依赖串行：先让"过程可见"（OTel span），再让"工具可调"（MCP + governedCall），再让"结论可验"（manifest），最后把验收契约导出。每阶段独立可交付、独立可回滚，全部改动先有失败测试。

**Tech Stack:** Next.js 16 · React 19 · TypeScript · Drizzle ORM · vitest 5 · Postgres 18（本机 @5432，`pnpm test` 起隔离库）

---

## 范围决定（含明确的"不做"）

| 报告项 | 本计划 | 理由 |
|---|---|---|
| P0-1 执行面薄（无工具循环/无 MCP） | **做（Phase 2）** | 分水岭；也是亮点 ★1 |
| P0-3 无 OTel span | **做（Phase 1）** | 低风险高收益，零新依赖即可 |
| ★2 manifest 可离线验证 | **做（Phase 3）** | 差异化最强，纯逻辑，可完全单测 |
| ★4 验收契约导出 | **做（Phase 4）** | 小，且复用已有 acceptance 结构 |
| P0-2 记忆无向量 | **不做** | 本机 Postgres 18 `pg_available_extensions` 只有 `pg_trgm`，没有 `vector`（已实测）；换镜像 + 迁移 + 嵌入供应商是独立工程，硬塞会写出"假向量" |
| P0-4 judge 验收 | **不在本计划** | 需要真实模型调用才能验证；无 key 时只能测降级路径，价值不足以占用本期 |
| P1 单供应商 / RBAC / 外部执行器 | **不做** | 单供应商在 README 已声明为已知边界；RBAC 与"个人优先"定位冲突（见报告反面意见） |
| CI push 不触发 | **诊断（Phase 0）**，不改 CI 逻辑 | 可能是仓库设置而非代码；先在仓库侧修可修的，修不动的如实记录 |

**硬约束（来自 AGENTS.md，违反即返工）：**
1. 状态写回必须带条件 + 检查影响行数，空返回抛 `ConflictError`。
2. 报告每句话要有证据，无证据写 `undetermined: true` 的人工项。
3. 时间判断用 `sql`now()``；后台维护只走 `pnpm tick`。
4. 不得新增运行时依赖（本计划所有实现零新包；MCP 与 OTLP 都手写协议层）。
5. 每个 Task 结束必须 `git commit`，提交信息说明"为什么"。

---

## 文件结构（新增/修改)

```
src/lib/observability/tracing.ts          (新) 零依赖 OTel span + OTLP/HTTP JSON 导出
src/lib/observability/tracing-export.ts   (新) OTLP payload 组装与 flush 队列
src/lib/mcp/protocol.ts                   (新) JSON-RPC 2.0 + Streamable HTTP 传输
src/lib/mcp/client.ts                     (新) initialize / tools/list / tools/call
src/lib/mcp/registry.ts                   (新) MCP server 解析与工具→resource 映射
src/lib/mcp/governed-call.ts              (新) 授权→预算→调用→记账 的唯一入口
src/lib/domain/manifest.ts                (新) 运行 manifest 构建 + Merkle 根 + 离线校验
src/lib/domain/acceptance-export.ts       (新) 验收契约导出为 JSON Schema
src/server/services/commands/tasks/run.ts (改) step→span；工具循环接 governedCall
src/server/services/commands/tasks/tool-loop.ts (新) 受限工具循环（maxSteps）
src/app/api/tasks/[id]/manifest/route.ts  (新) 导出 run manifest
scripts/verify-manifest.ts                (新) 离线校验 CLI
src/lib/db/schema.ts + drizzle/*          (改/新) mcp_servers 表 + 迁移
tests/unit/tracing*.test.ts               (新)
tests/integration/mcp-client.test.ts      (新) 起一个进程内假 MCP server
tests/integration/governed-call.test.ts   (新)
tests/integration/manifest.test.ts        (新)
```

---

## Phase 0 — 地基：文档校准 + CI 诊断

### Task 0.1 校准 README 的三处漂移

**Files:** `README.md:220`（44 个 route handler）、`README.md:266`（97 个测试文件 / 852 个测试）、`README.md:292`（"没有后台队列"）

- [ ] 实测：`find src/app -name route.ts | wc -l` → 45；`ls tests/**/*.test.ts | wc -l` → 104。
- [ ] 改 220 行的数字，并把"44/45"这类易漂移的计数改成**可复算的口径**（写明命令），而不是写死数字。
- [ ] 修 266 行：写明测试文件数与断言数各自的来源命令，标注实测日期。
- [ ] 修 292 行：改为"同步执行是默认路径；`RUN_EXECUTION=worker` 时走 `run_jobs` 队列（脚本 `scripts/run-worker.ts`，维护入口 `pnpm tick`）"，并保留"没有流式输出"这一条仍然成立的事实。
- [ ] 校验：`grep -n "44 个 route" README.md` 无输出；三处数字与实测命令输出一致。

### Task 0.2 CI push 不触发的真因诊断

**Files:** 只读诊断；若可修则改 `.github/workflows/ci.yml`

- [ ] `gh api repos/zhentaozhang/cabinet/actions/permissions` → 看 `enabled` / `allowed_actions`。
- [ ] `gh api repos/zhentaozhang/cabinet/actions/runs?per_page=5` → 看最近 run 的 `event`。
- [ ] `gh api repos/zhentaozhang/cabinet/branches/main/protection` → 看是否有 required checks 但无 run。
- [ ] 若结论是"Actions 被禁用/额度"→ 写进 `docs/observability.md` 或 README 的已知边界，**不改 workflow**；若结论是"workflow 分支过滤不匹配"→ 修 `on.push.branches` 并 push 一个空提交验证。
- [ ] 产出：`docs/ci-status.md` 记录三步输出与结论（证据优先，禁止猜）。

---

## Phase 1 — P0-3：run / step 变成 span（零依赖 OTLP）

**设计要点：**
- 开关：`OTEL_EXPORTER_OTLP_ENDPOINT` 存在才导出；不存在时 `startSpan` 返回 no-op，**零开销**、零网络。
- 结构：`run` = 根 span（`gen_ai.operation.name=invoke_agent`），每个 `steps` 行 = 子 span；模型调用额外带 `gen_ai.request.model` / `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`。
- 绝不阻塞主链：导出走内存队列 + 定时 flush，失败只 `logEvent("warn", ...)`，不得影响 run 结果。
- 不泄漏：属性白名单，禁止把 prompt 全文、API key 写进 span。

### Task 1.1 span 核心（纯函数、无网络）

**Files:** 新建 `src/lib/observability/tracing.ts`；测试 `tests/unit/tracing.test.ts`

- [ ] 失败测试：`startSpan({name:"run"})` 在无 env 时返回带 `traceId`/`spanId`（32/16 位 hex）但 `sampled=false` 的对象；`end()` 后 `span.endTimeUnixNano >= startTimeUnixNano`。
- [ ] 失败测试：子 span 的 `parentSpanId` 等于父 `spanId`；`traceId` 继承父。
- [ ] 失败测试：`attrs` 里出现 `apiKey`/`authorization`/`prompt` 键时被丢弃（白名单 + 脱敏）。
- [ ] 实现：`withSpan(name, attrs, fn)` 用 `AsyncLocalStorage` 传当前 span（复用 `context.ts` 模式），`fn` 抛错时 `status.code=2` 且 `status.message` 为错误消息，**然后重新抛出**。
- [ ] `vitest run tests/unit/tracing.test.ts` 通过。

### Task 1.2 OTLP/HTTP JSON 导出器

**Files:** 新建 `src/lib/observability/tracing-export.ts`；测试 `tests/unit/tracing-export.test.ts`

- [ ] 失败测试：给定两个 span，`toOtlpPayload([a,b])` 返回 `{resourceSpans:[{resource:{attributes:[{key:"service.name",value:{stringValue:"cabinet"}}]},scopeSpans:[{scope:{name:"cabinet"}},spans:[...]}]}` 结构；span 的 `startTimeUnixNano` 是**字符串形式**的 19 位纳秒。
- [ ] 失败测试：`kind` 映射 SPAN_KIND_INTERNAL=1 / SERVER=2；`status.code` 0/2。
- [ ] 失败测试：`flush(endpoint, spans)` 用注入的 `fetch` 断言 URL = `${endpoint}/v1/traces`、`content-type: application/json`；fetch 抛错时**不抛出**、返回 `{ok:false}`。
- [ ] 失败测试：队列上限（如 512）溢出时丢最旧并记 `dropped` 计数。
- [ ] 实现：模块级队列 + `flushSpans()`；`export function tracingEnabled(): boolean`。
- [ ] `vitest run tests/unit/tracing-export.test.ts` 通过。

### Task 1.3 接进 runTask

**Files:** `src/server/services/commands/tasks/run.ts`（`addStep` 345-367 与整段 try 369+）；测试 `tests/integration/tracing-run.test.ts`

- [ ] 失败测试：注入内存 exporter，跑一次 `runTask`（无模型 key，走 not_connected 路径）后，导出的 span 里至少有 1 个 `run.execute` 根 span，且 `runId` 属性存在；step span 数量 = steps 行数。
- [ ] `addStep` 内部开子 span（`name = step.type`，属性 `step.idx`、`step.tool`、`latency_ms`），`end()` 用 rows 实际写入时间。
- [ ] 根 span 属性：`run.id`、`task.id`、`agent.id`、`gen_ai.operation.name=invoke_agent`。
- [ ] 断言：run 失败（抛 ConflictError）时根 span 的 `status.code=2`，且 run 的返回/异常行为**与改动前完全一致**（回归测试：已有 `tests/integration/*run*.test.ts` 全绿）。
- [ ] `vitest run tests/integration/tracing-run.test.ts tests/integration/tasks-run.test.ts` 通过（后者文件名以实际存在为准，先 `ls tests/integration | grep run`）。

### Task 1.4 文档

- [ ] `docs/observability.md` 增一节"Trace 层"：开关 env、字段映射表（`run`→`gen_ai.operation.name`，`step`→child span）、与审计链的分工（审计=结论，trace=诊断）、采样与丢弃策略。

---

## Phase 2 — P0-1 / ★1：MCP client + 受治理的工具循环

**设计要点（正确性是重点）：**
- 传输：只实现 Streamable HTTP（POST JSON-RPC，响应可能是 `application/json` 或 `text/event-stream`），**不实现 stdio**（远程仓库场景用不到，且起子进程不可测）。
- 治理顺序不可换：`planTools`（已有授权判定）→ `decideRun` 复查（run 已做）→ `reserveBudget` 预扣 → 调用 → 记账 → 写 step。**预扣在前、结算在后**，与现有 `reserveBudget` 语义一致。
- 单次 run 的工具调用上限 `maxSteps`（默认 2，env `RUN_MAX_TOOL_STEPS`），每次调用都写一行 step，`type="tool"`。
- MCP 工具名到资源映射：registry 显式配置 `resource`（缺省 `mcp:<server>`），否则一律 `unknown_tool` 拒绝——不允许"自动放行"。
- 失败语义：连接失败 → `not_connected`（沿用现有枚举）；授权拒绝 → `unauthorized`；预算不足 → `budget_exceeded`；协议错误 → `error` + 原始 JSON-RPC error 落 step。

### Task 2.1 协议层（纯函数）

**Files:** 新建 `src/lib/mcp/protocol.ts`；测试 `tests/unit/mcp-protocol.test.ts`

- [ ] 失败测试：`jsonRpcRequest("tools/call", {name, arguments}, 7)` → `{jsonrpc:"2.0", id:7, method, params}`；`parseJsonRpcResponse` 能同时解析 `{result}` 与 `{error:{code,message}}`。
- [ ] 失败测试：SSE 文本 `event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{...}}\n\n` 解析出 1 条消息；注释行 `: ping` 被忽略；多 event 按序返回。
- [ ] 失败测试：`extractToolResult` 处理 MCP 2025-06-18 的 `{content:[{type:"text",text}], isError}`，`isError:true` → `{ok:false}`。
- [ ] 实现 + `vitest run tests/unit/mcp-protocol.test.ts` 通过。

### Task 2.2 client（真 HTTP，假 server）

**Files:** 新建 `src/lib/mcp/client.ts`；测试 `tests/unit/mcp-client.test.ts`（用 `node:http` 起进程内 server）

- [ ] 失败测试：对假 server 依次发 `initialize` → 断言带 `protocolVersion`、`clientInfo`，且收到 `Mcp-Session-Id` 响应头后，后续请求自动带上该头（Streamable HTTP 的会话要求）。
- [ ] 失败测试：`initialize` 后发 `notifications/initialized`（无 id、不期待响应）。
- [ ] 失败测试：`listTools()` 返回 `[{name, description, inputSchema}]`。
- [ ] 失败测试：`callTool(name,args)` 超时（默认 15s，可注入）→ 返回 `{ok:false, error:{code:"timeout"}}`，不抛。
- [ ] 失败测试：响应 401/500 → `{ok:false, error:{code:"unauthorized"|"upstream_error", retryable:false|true}}`，语义与 `src/lib/connectors/types.ts` 的 `SearchOutcome` 对齐。
- [ ] `vitest run tests/unit/mcp-client.test.ts` 通过。

### Task 2.3 schema + 迁移

**Files:** `src/lib/db/schema.ts`（新增 `mcpServers`）、`drizzle/`（`drizzle-kit generate` 产物）；测试 `tests/integration/schema-mcp.test.ts`

- [ ] 失败测试：插入一行 `mcp_servers`（`user_id`, `name`, `url`, `resource`, `enabled`），唯一约束 `(user_id, name)` 冲突时抛错；`url` 非空。
- [ ] 字段设计：`id`, `userId`, `name`, `url`, `resource`, `enabled boolean default true`, `createdAt`, `updatedAt`；**不存 token 明文到可导出接口**（token 走 env/headers 加密字段，本期只支持 `MCP_<NAME>_TOKEN` env）。
- [ ] `./node_modules/.bin/drizzle-kit generate` 生成迁移；`drizzle-kit migrate` 在隔离库通过。
- [ ] `tests/helpers/migrations.ts` 兼容性检查（迁移链从空库可跑通：`bash scripts/verify.sh` 会验）。

### Task 2.4 governedCall（治理唯一入口）

**Files:** 新建 `src/lib/mcp/governed-call.ts`；测试 `tests/unit/governed-call.test.ts`

- [ ] 失败测试：工具未授权 → `{ok:false, status:"unauthorized"}` 且**没有发生任何 fetch**（用 spy 断言 0 次）。
- [ ] 失败测试：预算预留返回 `{allowed:false}` → `status:"budget_exceeded"`，不调用。
- [ ] 失败测试：调用成功 → 结算用的 `costCents` 取自预留值（本期 MCP 调用不计费，固定 0，但**必须走预留/结算同一个函数**，否则以后加计费会漏账）。
- [ ] 失败测试：调用抛错 → 释放预留（`releaseBudget`），不产生负账。
- [ ] 实现 + `vitest run tests/unit/governed-call.test.ts` 通过。

### Task 2.5 受限工具循环接进 runTask

**Files:** 新建 `src/server/services/commands/tasks/tool-loop.ts`；改 `run.ts:545-571`（当前 not_connected 分支）；测试 `tests/integration/tool-loop.test.ts`

- [ ] 失败测试：agent 配了 `web_search` 且**没有** MCP server → 行为与现在完全一致（1 个 not_connected / 或 provider 结果），回归零变化。
- [ ] 失败测试：配了 MCP server 且授权 → 调 1 次工具，steps 多 1 行，`output.status="ok"`，`output.tool` 是 MCP 工具名。
- [ ] 失败测试：`maxSteps=2` 时最多 2 次调用，第 3 次计划被截断并写 `output.status="step_limit"`。
- [ ] 失败测试：MCP 超时 → step `output.status="error"`，run 仍正常收尾（不得因外部工具挂掉而丢 run）。
- [ ] 实现 + `vitest run tests/integration/tool-loop.test.ts` 通过。

### Task 2.6 文档

- [ ] 新增 `docs/mcp.md`：能力边界（只支持 Streamable HTTP）、授权模型（`resource` 显式配置）、预算语义（预扣/结算/释放）、失败枚举、以及"为什么不做 stdio"。

---

## Phase 3 — ★2：可离线验证的 run manifest

**设计要点：**
- `manifest = { runId, taskId, agentId, createdAt, steps:[{idx,type,tool,outputHash}], evidence:[{id,contentHash}], auditHead:{seq,hash}, merkleRoot, version }`。
- 每个叶子 = `sha256(canonicalJson(item))`，Merkle 用**成对排序拼接**（`a<b` 规范化），单叶奇数复制最后一个——算法写进文档，避免"自己实现的树自己验"。
- 校验器 `verifyManifest(manifest, fetchLeaf)`：重算 root、逐条比对 `outputHash`，返回 `{ok, mismatches:[{path,expected,actual}]}`。
- 导出端点需要登录 + 只导出本人 run；不含 prompt 全文（只有 hash）。

### Task 3.1 canonical json + merkle（纯函数）

**Files:** 新建 `src/lib/domain/manifest.ts`；测试 `tests/unit/manifest.test.ts`

- [ ] 失败测试：`canonicalJson({b:1,a:[2,{d:3,c:4}]})` → `{"a":[2,{"c":4,"d":3}],"b":1}`（键排序、无空格、数组保序）。
- [ ] 失败测试：`merkleRoot([])` → `null`；`merkleRoot(["a"])` → `sha256(leaf("a"))`；两叶时 root = `sha256(h1+h2)`（拼接顺序按字节比较小的在前）。
- [ ] 失败测试：改动任一叶子 → root 必变（性质测试：3 个随机样本）。
- [ ] 实现 + 通过。

### Task 3.2 构建 + 校验

**Files:** 同文件 + `scripts/verify-manifest.ts`；测试 `tests/integration/manifest.test.ts`

- [ ] 失败测试：`buildManifest(runId)` 返回结构正确，`merkleRoot` 等于对该 run 所有 step 叶子手算的 root。
- [ ] 失败测试：把 manifest 里某 step 的 `outputHash` 改一位 → `verifyManifest` 返回 `ok:false` 且 `mismatches[0].path` 指向该 step。
- [ ] 失败测试：`scripts/verify-manifest.ts <file.json>` 对篡改文件 exit 1、对原文件 exit 0（用 `tsx` 跑，断言退出码）。
- [ ] 实现 + 通过。

### Task 3.3 导出端点

**Files:** 新建 `src/app/api/tasks/[id]/manifest/route.ts`；测试 `tests/integration/manifest-route.test.ts`

- [ ] 失败测试：未登录 → 401；他人 run → 404（不泄漏存在性）；本人 → 200 + `content-type: application/json` + `content-disposition` 附件名含 runId。
- [ ] 失败测试：响应体不含 prompt 全文（用含哨兵字符串的任务跑一遍，断言哨兵不出现在响应里）。
- [ ] 实现 + 通过。

---

## Phase 4 — ★4：验收契约导出

**Files:** 新建 `src/lib/domain/acceptance-export.ts`；端点 `src/app/api/tasks/[id]/acceptance/route.ts`；测试 `tests/unit/acceptance-export.test.ts`

- [ ] 失败测试：`exportAcceptance(items)` 对 `section/min_words/min_sources/min_evidence/manual` 各产出一个 JSON Schema 片段，`manual` 明确标 `x-undetermined: true`（否则外部会以为机器判了）。
- [ ] 失败测试：同一 task 两次导出字节一致（确定性，无时间戳）。
- [ ] 实现 + 通过。

---

## 审查关卡（每阶段结束）

1. `DATABASE_URL_TEST=postgres://localhost:5432/cabinet_test ./node_modules/.bin/vitest run`（全量，0 失败）。
2. `./node_modules/.bin/tsc --noEmit` && `./node_modules/.bin/eslint`。
3. 独立审查 subagent：只读 diff + 计划，逐条核对"是否真有失败测试 → 是否真通过"，输出问题清单。
4. 有 ❌ 就修，修完重跑 1–3；三轮未通过则上报。

## 已知风险

- **Next 16 破坏性变更**：新增 route 前先读 `node_modules/next/dist/docs/` 对应指南（AGENTS.md 要求）。
- **迁移链**：本机长驻库是 `drizzle-kit push` 建的，迁移验收必须用 `scripts/verify.sh` 的临时库路径，不能用长驻库。
- **MCP 上游兼容性**：只对自建假 server 验证，真实 server 的 `text/event-stream` 行为可能不同；文档里写清"未对真实第三方 server 验证"。
