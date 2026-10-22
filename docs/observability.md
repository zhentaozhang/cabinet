# Cabinet 可观测性（T0：管道与证据）

> 目标：让「用户说打不开」变成「打开 requestId，三十秒内知道卡在哪一层」。
> 原则：遥测永不反噬业务——日志失败不影响请求，观测失败不影响数据。

## 1. 三个平面，不要混

| 平面 | 内容 | 事务 | 谁看 | 保留 |
|---|---|---|---|---|
| **P1 证据面** | `audit_events` 哈希链、`runs`、`steps`、`artifacts` | 与业务同事务 | 用户可见（Review / 任务详情） | 永久 |
| **P2 遥测面** | stdout JSON 日志、指标、trace | 绝不在事务内 | 运维可见 | 日志 14 天 / trace 7 天 |
| **P3 度量面** | `getWeeklyMetrics` 从 P1 派生 | — | 用户可见 | 随时重算 |

**R1：P2 只记标识与形状，不记内容。** 任务正文、prompt、记忆、邮件、密钥一律不进日志；需要正文时用 `runId` / `taskId` 回 P1 查。

本轮（T0）只建 **P2 的管道** 与 **健康检查**，并把「生产环境 5xx 不可见」这个漏洞堵掉。指标（T1）、trace（T2）、告警（T3）见 §9。

## 2. 落地清单

| 文件 | 作用 |
|---|---|
| `src/lib/obs/logger.ts` | 零依赖 JSON 行日志：分级、脱敏、深度/长度截断、永不抛 |
| `src/lib/obs/request-id.ts` | 请求 ID 的生成与校验；把路径折叠成路由模板 |
| `src/lib/obs/context.ts` | Node 侧 `AsyncLocalStorage` 上下文：requestId 贯穿异步调用 |
| `src/lib/obs/http.ts` | `handleQuery` / `handleMutation` 的统一观测包装 |
| `src/proxy.ts` | 边缘入口：生成 / 沿用它方 requestId，注入下游与响应头 |
| `src/app/api/health/route.ts` | 存活探针；`?deep=1` 附加数据库就绪探针 |

## 3. 请求 ID 契约

```
浏览器 ──▶ proxy.ts（无 id 则生成 r_<16hex>）
             ├─▶ 请求头 x-request-id / x-request-path / x-request-method
             └─▶ 响应头 x-request-id（错误响应与重定向同样带）
                    │
   RSC 页面 ──▶ src/lib/api/server.ts correlationHeaders()
                    └─▶ 内部 /api/* 调用继承同一个 id
                          └─▶ handleQuery / handleMutation 写入 AsyncLocalStorage
```

- 头部常量在 `src/lib/obs/request-id.ts`：`REQUEST_ID_HEADER`、`REQUEST_PATH_HEADER`、`REQUEST_METHOD_HEADER`。
- 外部传入的 id 只有匹配 `^[A-Za-z0-9._:-]{8,96}$` 才被采信，否则重新生成——防止日志注入与标签基数爆炸。
- **`proxy` 运行在边缘运行时，不得 import `context.ts`**（`AsyncLocalStorage` 不存在）；边缘只负责搬头部，Node 侧才建上下文。`tests/unit/boundary.test.ts` 与 `eslint.config.mjs` 都拦这条。

## 4. 日志事件目录

一行一个 JSON，字段固定为 `ts` / `level` / `event` + 事件专属字段。

| event | level | 关键字段 | 判读 |
|---|---|---|---|
| `http.request` | info / warn(4xx) / error(5xx) | `requestId` `method` `route` `kind` `status` `durMs` `user` | 一个请求恰好一条，无论成功失败 |
| `http.error` | error | `errorName` `errorMessage` `stack` `status` `fault:"server"` | 5xx 的根因；**生产也写** |
| `http.rejected` | info / debug | `code` `status` `fault:"client"` | 业务拒绝（policy/限流/冲突）是功能，不是故障 |
| `http.unhandled` | error | `requestId` `errorMessage` | 管道自身抛错（理论上不该出现） |
| `mutation.committed` | info | `endpoint` `status` `replayed` | 写成功；`replayed` 区分幂等重放 |
| `llm.call` | info | `model` `durMs` `tokensIn` `tokensOut` | 真实调用成功 |
| `llm.fallback` | warn | `fallbackReason` `model` `durMs` | `timeout` / `auth` / `rate_limited` / `upstream_error` / `client_error` / `unknown` |
| `llm.skipped` | debug | `reason:"missing_key"` | 没配 key，走模板产物（**与降级可区分**） |
| `llm.empty_output` | warn | `model` `durMs` | 上游返回空文本 |
| `dto.violation` | error | `label` `detail` | 契约漂移：服务端产出的 DTO 不合 schema |
| `health.database_unreachable` | error | `errorMessage` `timeoutMs` | 深探针失败 |

`route` 是**路由模板**（`/api/tasks/:id/run`），不是具体路径——`tsk_*`、UUID、纯数字段都被折叠，否则标签基数直接失控。

## 5. 脱敏与截断

`logger.ts` 按 key 名脱敏（顶层与嵌套都生效）：`content` `prompt` `text` `body` `input` `output` `memor*` `description` `email` `cookie` `authorization` `password` `secret` `apiKey` `title` `charter` `acceptance*` → `[redacted]`。

结构性兜底：深度 4 层、数组取前 20 项、单字符串截断 400 字符、循环引用打成 `[depth]`、`Error` 自动转成 `{errorName,errorMessage,stack(前 4 行)}`。

用户标识只以 `u_<8hex>` 形式出现（`hashUserId`，盐为 `OBS_USER_SALT`），日志里不出现真实 userId。

**新增字段前先自问：这段内容会不会让运维看到用户的正文？会，就别加。**

## 6. 健康检查

| 端点 | 语义 | 用途 |
|---|---|---|
| `GET /api/health` | 进程存活，不碰数据库 | 存活探针 / 快速冒烟 |
| `GET /api/health?deep=1` | 额外 `select 1`，800ms 超时 | 就绪探针 / 负载均衡 |

返回 `{ ok, service, version, uptimeSeconds, database? }`，`cache-control: no-store`；深探针失败返回 **503**。

存活探针刻意不查库：依赖抖动时重启进程只会把一次数据库波动放大成一次事故。

`/api/health` 在 `proxy.ts` 的公开名单内，无需登录。

## 7. 本地怎么看

```bash
# 只看 5xx
node server.js 2>&1 | jq -c 'select(.level=="error")'

# 打开一个请求的完整轨迹
... | jq -c 'select(.requestId=="r_0123456789abcdef")'

# 谁在拖慢接口（按耗时排序）
... | jq -r '[.route, .durMs] | @tsv' | sort -k2 -n | tail -20

# LLM 降级原因分布
... | jq -r 'select(.event=="llm.fallback") | .fallbackReason' | sort | uniq -c
```

级别阈值由 `OBS_LOG_LEVEL` 控制（`debug` / `info` / `warn` / `error`，默认 `info`）。排查时临时降到 `debug`，能看到 404 这类噪音级拒绝。

## 8. 新增一条信号的规则

1. **只记标识与形状**：`runId`、`taskId`、`durMs`、`tokensIn`、`status`、`route`——不记正文。
2. **不阻塞响应**：在 `handleQuery` / `handleMutation` 之外写日志时用 `after()`（`next/server`），让 I/O 落到响应之后。
3. **不抛错**：`log()` 自身已 try/catch，别在外面再包一层会抛的东西。
4. **进事务前想清楚**：日志绝不写 Postgres；`db.transaction` 内部只允许 P1 证据。

## 9. 尚未落地（下一步）

| 阶段 | 内容 | 为什么必要 |
|---|---|---|
| T1 | Prometheus `/api/ops/metrics` + `cabinet_*` 指标 | 日志算不出 SLO，也做不了趋势与告警 |
| T2 | `src/instrumentation.ts` + OTel trace | 跨 RSC→API→DB→LLM 的耗时归因 |
| T3 | 告警规则、看板、审计链日巡检 | 从「能查」变成「自己叫人」 |
| T4 | 用实测值替换 `steps.latency_ms` / `tokens` 的估算 | 产品展示的数字必须可追溯 |

T0 的价值是：**当 T1–T4 建起来时，它们才有干净的输入**——一个贯穿全链路的 requestId，和一条不会在 500 时失语的日志管道。

## 10. 值班速查

| 症状 | 先看 | 再看 |
|---|---|---|
| 页面打不开 | `http.request` 里该 `route` 的 `status` 与 `durMs` | 同 `requestId` 的 `http.error` 栈 |
| 操作被拒 | `http.rejected` 的 `code` | `policy_denied` → 看自主等级/授权，不是 bug |
| Agent 产物像模板 | `llm.fallback` / `llm.skipped` | `auth`＝key 失效；`rate_limited`＝配额；`skipped`＝没配 key |
| 数据异常 | `/api/audit/verify` 的链校验结果 | 再按 `requestId` 找对应写操作 |
