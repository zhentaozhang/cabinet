# 可观测性

三个问题，三个答案：

| 问题 | 答案 |
|---|---|
| 用户说「刚才那次操作失败了」 | 让用户报 `x-request-id`，`grep` 一条日志 |
| 线上是不是在正常干活 | `GET /api/metrics`（带 `OPS_TOKEN`） |
| 部署能不能接流量 | `GET /api/health`（公开，无 session） |

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

## 相关

- 健康检查与恢复门槛：[`docs/deployment.md`](./deployment.md)
- 投递队列语义：[`docs/notifications.md`](./notifications.md)
- 运行队列与租约：[`docs/run-durability.md`](./run-durability.md)
