# 运行的可恢复性

一次运行以前活在发起它的那个 HTTP 请求里。进程重启、部署、OOM、`Ctrl-C`——任何一种中断都会留下同样的现场：任务卡在 `running`，预算预留挂在账本上，没有任何东西会来收尾。用户看到的是「执行中」，账本看到的是永久占用。

这一层解决三件事：**请求不会因为进程死掉而消失，卡住的运行会被收尾，收尾不会把可能已经花掉的钱当成没花。**

## 两种执行模式

| `RUN_EXECUTION` | `POST /api/tasks/:id/run` 做什么 | 适用 |
|---|---|---|
| `inline`（默认） | 在请求内直接执行，返回结果 | 单进程部署、演示、本地开发 |
| `worker` | 写入 `run_jobs` 并返回 `202 {queued:true,jobId}` | 部署环境，需要重启不丢任务 |

两种模式下**策略、预算、审计、验收完全一致**——worker 只是换了个调用 `runTask()` 的进程。

## 一次排队到落地

```
POST /run  ──►  run_jobs(status=queued)  ──►  worker 认领
                                              │  status=running
                                              │  claim_token=<uuid>
                                              │  lease_until=now+10min
                                              ▼
                                        runTask(taskId, userId)
                                              │
                            ┌─────────────────┼──────────────────┐
                            ▼                 ▼                  ▼
                      succeeded          blocked             failed
                    （有 runId）      （PolicyDenied）    （其他异常）
```

- **认领**：`SELECT … ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED` + 条件 `UPDATE`。两个 worker 永远不会拿到同一行，谁也不会等谁。
- **回写**：任何结果都带 `claim_token` 作为条件。租约过期的老 worker 回写命中 0 行，`updated:false`——它不会覆盖接手者的结论。
- **重复请求**：同一任务已有 `queued`/`running` 的 job 时，`enqueueRun` 返回同一个 job，不会排两次。

## 恢复：为什么要按「未知」记账

`RUN_STALE_MINUTES`（默认 15 分钟）之后仍是 `running` 的运行，说明持有它的进程已经不在了。恢复流程在一个事务里做四件事：

1. 看这次运行的步骤里有没有供应商接触痕迹（`output.provider`，或工具状态为 `ok`/`timeout`/`invalid_response`/`rate_limited`）；
2. **有痕迹 → 按未知用量结算**（`unknown_charged`，金额 = 当初预留的额度上限）；**无痕迹 → 释放**；
3. 运行标记 `failed`，任务退回 `planned`（可以重试，但必须由人再点一次）；
4. 写 `run.recovered` 审计事件，带上 `settlement` 与 `providerContacted`。

第 2 步是整层的关键。把未知用量当 0 释放，等于让「崩一次」成为免费调用模型的最便宜方式。宁可账上多记一笔未知，也不假装没发生。

反过来，恢复也不自动重跑：重跑会产生新的费用，那是用户的决定，不是进程的决定。

## 运维

```bash
# 常驻
pnpm run:worker

# 或者交给 cron，每次跑干队列
pnpm run:worker:once
```

一轮 = 先恢复卡住的运行，再逐个认领执行，直到队列空。日志每行一个 JSON，只在有动作时打印。

`RUN_LEASE_MINUTES` 要大于一次运行的最长耗时（含模型与检索超时）。调得太小会让两个 worker 先后执行同一个任务；调得太大只会让崩溃后的收尾晚一点。

## 边界

- **投递/执行都是至少一次**：进程可能在「外部调用已发出、结果未写回」之间死掉。这正是按未知用量收尾的理由，不假装恰好一次。
- **`inline` 模式不会自动恢复**：没有 job 可认领，但恢复流程照样会把卡住的 `running` 运行收尾——所以定时跑一次 `run:worker:once` 在任何模式下都有意义。
- **没有优先级、没有取消**：队列 FIFO。取消需要定义「已发出去的请求怎么办」，那是另一个决定。
