# 运行的可恢复性

> **适用范围**：租约、`recoverStaleRuns` 都是真实实现（定时器入口 `src/server/jobs/maintenance.ts:299`，
> worker 启动时 `scripts/run-worker.ts:103` 也会先收尾一次），但本项目单进程运行，
> `inline` 模式下「执行者」就是那个 HTTP 请求本身，所以「进程死掉留下 `running`」只能靠手动
> `kill` 一个 `pnpm run:worker` 复现。本文里**未知用量不能当成 0** 的推理仍然有效，是可复用的记账笔记。

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

## tick：唯一的后台入口

上面这些收尾动作原先各写各的：恢复流程有 `run:worker:once`，通知投递有 `notify:deliver`，而**过期审批、重试耗尽、限流窗口、幂等键、outbox 老行**根本没有入口——代码写了，没有人调用，所以它们要清理的状态一直原样躺着。把清扫塞进 web 进程的 `setInterval` 也不成立：进程重启、部署、多实例，定时器要么消失，要么同时跑两遍。

现在只有一个入口：

```bash
pnpm tick    # 跑一轮，可重复执行
```

一轮按顺序做八步，每步都在自己的 try/catch 里，**一步失败不会阻断后面七步**——cron 场景下最怕的就是「恢复步骤因为锁表报错，于是限流表再也没被清过」。

| 步骤 | 做什么 | 对应的问题 |
|---|---|---|
| `recoverStaleRuns` | 收尾超过 `RUN_STALE_MINUTES` 仍是 `running` 的运行：按未知用量结算、标记 failed、任务退回 `planned` | 崩溃后的运行没人收尾 |
| `expireStaleApprovals` | `expiresAt <= now` 的 `pending` 审批置 `expired`，任务退回 `planned`，写 `approval.expire` | 没人点的审批让任务永久停在 `awaiting_approval` |
| `failExhaustedJobs` | 用满 `MAX_CLAIM_ATTEMPTS` 且租约已过期的 job 置 `failed`，原因写进 `lastError` | 反复被认领又反复死掉的 job 永远没有结论 |
| `settleDueDissents` | 观察窗口已过的 `pending` 异议交给 `evaluateDissents` 判定（窗口未过的不动） | 异议判定只挂在 `/api/reflect`，没人点复盘就永远 pending |
| `closeExpiredPeriods` | `period_end <= now` 且未关闭的预算周期写 `closed_at`（不清零、不删除） | 准入路径会读 `closed_at` 拒绝预留，但这个字段从来没有写入方，一周永远不会结束 |
| `pruneRateLimits` | 删掉 `window_start` 早于 24h 的窗口行 | 限流表每天每用户每动作长一行 |
| `pruneIdempotencyKeys` | 删掉 `expires_at < now` 的幂等记录 | 只在复用同一个 key 时才顺手清，用一次就再也不清 |
| `archiveOldOutbox` | 删掉 30 天前（`OUTBOX_RETENTION_DAYS`）状态已收尾（`sent`/`skipped`）的通知 | outbox 只增不减 |

三张表的 TTL 都是**纯删除**：限流窗口按时间分桶，删掉旧桶不会让人多一次配额；幂等键过期就等于不存在；outbox 只动终态行，`pending`/`sending` 还欠着一封信，`failed` 是地址失效的现场记录，都不会被删。

`closeExpiredPeriods` 是唯一不删行的清扫：它只写 `closed_at`，因为预算周期行是账本，删掉就等于毁掉对账依据。

每一步都是条件写入或带谓词的删除，所以第二轮跑出来是八个 0。这既是幂等的实现方式，也是它的检验方式。

**投递不在这里**：发信有重试节奏和 `--dry-run`，仍然是 `pnpm notify:deliver`。要一起跑就串在同一行 cron 里。

**记忆衰减也不在这里**：`src/lib/memory/decay.ts` 明确写着「先有 `policy_config` 的留存/half-life 配置，再接调度」——`policy_config` 至今没有这个键，硬挂一个常量半衰期等于把产品决策藏进代码。这是**有意的空缺**，不是漏接：`settleDueDissents` 已经证明调度位存在，缺的只是一个配置字段和一个明确的产品口径。

### 挂 cron

每 1–5 分钟一次，一轮通常是空跑（几条索引扫描）：

```cron
*/2 * * * * cd /srv/cabinet && pnpm tick >> /var/log/cabinet-tick.log 2>&1; pnpm notify:deliver >> /var/log/cabinet-notify.log 2>&1
```

退出码只在**八步全失败**（实践上等于数据库连不上）时非 0；脚本自身构建失败也是 1。某一步坏掉只会体现在那行 `FAIL 步骤名 — <error>` 和报告里的 `failed` 计数里：让一次坏掉的恢复把整个 cron 标红，只会训练所有人忽略这个告警。

日志每行一个步骤（`ok  /FAIL  步骤名  计数  细节`），最后一行是 JSON 汇总，`counts` 里能直接看出这一轮到底有没有事做。
