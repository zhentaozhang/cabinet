# 可观测性

三个问题，三个答案：

| 问题 | 答案 |
|---|---|
| 用户说「刚才那次操作失败了」 | 让用户报 `x-request-id`，`grep` 一条日志 |
| 线上是不是在正常干活 | `GET /api/metrics`（带 `OPS_TOKEN`） |
| 部署能不能接流量 | `GET /api/health`（公开，无 session） |
| 一次 run 到底慢在哪 | trace（配 `OTEL_EXPORTER_OTLP_ENDPOINT` 后可在 Jaeger/Tempo 里看） |

## 请求 id

每个 API 请求进管道（`handleQuery` / `handleMutation`）时进入一个 `AsyncLocalStorage`
作用域，id 有三条出路：

1. 响应头 `x-request-id` —— 用户可以把它贴给你
2. 该请求产生的每一条日志
3. 服务端 500 的日志（含堆栈）

调用方自带 `x-request-id` 时会被沿用，前提是符合 `[A-Za-z0-9._:-]{1,64}`。
不符合就换一个新的：一个 id 的用途是「把多条日志串起来」，让任意 header 内容
顺着它流进每一行日志，是把日志变成注入面。

为什么用 `AsyncLocalStorage` 而不是加参数：加参数意味着把 `requestId` 穿过
整个 service 层，而那一层和 HTTP 无关。可观测性不该污染业务签名。

## 日志

一行一个 JSON 对象，便于 `grep` / `jq`：

```json
{"at":"2026-10-23T11:58:10.420Z","level":"info","event":"query.ok","requestId":"req_9f2c1a4b7e5d3c8a0b61","ms":12}
```

事件名固定几类：`query.ok` `query.failed` `mutation.failed` `api.unhandled`。
`api.unhandled` 在**所有环境**都会打印——线上一个没有任何痕迹的 500 是运维唯一
真正无法排查的东西。

## 指标端点

`GET /api/metrics`，需要 `OPS_TOKEN`（`x-ops-token: <token>` 或 `Authorization: Bearer <token>`）。

- 未配置 `OPS_TOKEN` → **404**（端点不存在，自身不宣传）
- token 不匹配 → **403**（长度无关的定时安全比较）

返回的是运维关心的量，不含任何用户内容：

```json
{
  "ok": true,
  "data": {
    "at": "2026-10-23T11:58:10.416Z",
    "jobs": { "queued": 2, "running": 1, "succeeded": 40, "failed": 1 },
    "jobsStaleLeases": 0,
    "outbox": { "pending": 1, "sent": 12 },
    "retrievalLast24h": { "ok": 8, "timeout": 1 },
    "tasks": { "total": 10, "running": 0 }
  }
}
```

`jobsStaleLeases` 是最该盯的一个数：`running` 且租约已过期，说明有 worker
死了但没把活交回来——恢复脚本会接住，但这个数持续不为 0 意味着 worker 在反复
崩溃。`retrievalLast24h` 只统计最近 24 小时，因为累计值掩盖故障恢复。

## Trace

审计链和 trace 回答的是不同问题，别互相替代：

| | 审计链（`audit_events`） | Trace（OTLP span） |
|---|---|---|
| 回答 | 谁在什么时候改了什么，可验证 | 这次执行花了多久，卡在哪一步 |
| 存储 | 数据库，哈希链，永久 | 采集器，采样，可丢 |
| 能否事后删除/伪造 | 不能（链会断） | 可以（丢掉不影响证据） |

### 开关

只有设置了 `OTEL_EXPORTER_OTLP_ENDPOINT` 才会导出：

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev
```

没设就只建 span 不发送——进程内多花几微秒，零网络、零定时器。导出走
`POST {endpoint}/v1/traces`，就是 collector 原生吃的 OTLP/JSON，不需要装
OpenTelemetry SDK：为了这点数据引入几十个传递依赖不划算（理由写在
`src/lib/observability/tracing.ts` 的文件注释里）。

### 层次

| span 名 | 由谁开 | 关键属性 |
|---|---|---|
| `run.execute` | `runTask` | `task.id` `agent.id` `run.id` `run.steps` |
| `&lt;step.type&gt;`（如 `plan`） | `addStep` | `step.idx` `step.tool` `step.latency_ms` |
| `llm.generate` | `src/lib/llm.ts` | `gen_ai.provider` `gen_ai.request.model` `gen_ai.usage.*` |

父子关系靠 `AsyncLocalStorage`，不是靠传参：子 span 继承父的 `traceId`，
`parentSpanId` 指向父 `spanId`。

### 属性按「键名分段」拒绝

span 会被发到第三方。键名按 `.` `_` `-` `[` `]` 切成段，
**任意一段**等于 `secret|token|password|passwd|authorization|auth|api[-_]?key|apikey|key|credential|credentials|prompt|content|payload|body`
的属性**直接丢弃**，字符串超过 256 字符截断。按拒绝清单而不是白名单放行，
是为了让新调用点默认失败在安全一侧：宁可少一个属性，不要多一次泄漏。

分段而不是子串匹配，是被一个真实缺陷逼出来的：子串规则里含 `token`，
于是 `gen_ai.request.max_tokens`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`
全被丢掉——span 上只剩下 provider 和 model，「这次 run 花了多少 token」这个
本来就该由 trace 回答的问题永远问不出来。现在 `input_tokens` 切出来是 `tokens`，
不等于 `token`，因此保留；而 `openai.api_key`、`http.request.header.authorization`、
`user.password` 仍然整条丢弃（见 `tests/unit/tracing.test.ts`）。

数值属性按类型发出：整数用 `intValue`（十进制字符串）、小数用 `doubleValue`、
布尔用 `boolValue`。早期版本把所有数字都当 `stringValue`，后端就没法对
`step.idx`、`gen_ai.usage.*` 求和。

### 只在 Node 里跑（边界）
`src/instrumentation.ts` 无条件调用 `installOtlpExporterIfConfigured()`，而 `tracing.ts`
用的是 Node 的 API（`process.hrtime.bigint()`、`node:crypto`）。当前仓库没有
`middleware.ts`、也没有 edge route，instrumentation 只会在 Node 里执行，所以这条线是安全的。

一旦新增 middleware 或 `runtime = "edge"` 的 route，Next 会把 `src/instrumentation.ts`
也编进 edge bundle（`bash scripts/verify.sh` 的 build 阶段已经能看到这条 import trace，
现在只是 warning）。那时必须先加运行时守卫：

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installOtlpExporterIfConfigured } = await import("@/lib/observability/otlp");
  // ...
}
```

动态 import 不是风格问题：静态 import 会把 `otlp.ts` 整个拖进 edge bundle。

### 丢了怎么办

导出队列上限 512，溢出丢最旧的并累加 `dropped`；满 32 条或每 5 秒 flush 一次，
失败只打一行 `{"event":"otlp.export.failed"}`，不重试、不影响业务。
「遥测不能成为任务失败的原因」是这条链路上唯一的硬规则。

## 相关

- 健康检查与恢复门槛：[`docs/deployment.md`](./deployment.md)
- 投递队列语义：[`docs/notifications.md`](./notifications.md)
- 运行队列与租约：[`docs/run-durability.md`](./run-durability.md)
