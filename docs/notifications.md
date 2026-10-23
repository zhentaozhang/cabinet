# 主动触达（M3）

Agent 不该在你打开网页时才有生命。但「主动」很容易变成骚扰，所以这里只有一条原则：

> **只在需要你动手的时候发信，并且每一封都有记录，发没发出去都能查。**

## 会发什么

| kind | 触发 | 为什么值得打扰你 |
|---|---|---|
| `rejection` | Auditor 驳回一次验收 | 任务卡住了，只有你能决定重跑还是改标准 |
| `approval` | 外部动作进入待审批 | 不批就一直停在那里 |
| `budget` | 预算触顶，运行被拒绝 | 继续跑会花钱，或者已经花不出去 |
| `conflict` | 记忆里同一个事实出现冲突值 | 旧值被标 conflicted，需要你确认哪个对 |

成功验收、任务完成、每日早报**不发邮件**——那些在 Today 页里看就够了。

## 数据流

```
run / audit / approve
      │  enqueueNotification()（与业务写入同一个事务）
      ▼
   outbox 表 ──► 投递进程（cron，不是进程内定时器）──► SMTP
      │                    │
      │                    └─ 结果写回同一行：sent / failed / skipped / waiting
      ▼
/settings/notifications（列表 + 统计 + 手动投递一次）
```

投递进程是 `scripts/deliver-outbox.ts`（`pnpm notify:deliver`）。它**不做常驻定时器**：`setInterval` 会随 web 进程重启而丢失，且多实例会重复发送。用部署层的 cron 调一次、跑完就退出，是唯一在多实例下也安全的选择。

```cron
* * * * * cd /srv/cabinet && pnpm notify:deliver >> /var/log/cabinet-outbox.log 2>&1
```

## 语义细节

- **入队幂等**：键是 `(user, kind, target, 日期)`。同一件事在同一天只会有一封，重跑任务不会重复打扰。
- **认领用 `FOR UPDATE SKIP LOCKED`**：两个投递进程同时跑，每行只会被一个进程取走。
- **重试**：真实失败（连接失败、5xx）记 `attempts+1`，60s / 5min / 15min 退避，最多 4 次后置 `failed`，不再重试。
- **`skipped` ≠ `failed`**：用户关了通知记 `skipped` 并写明原因；`SMTP_HOST` 没配记 `waiting`，邮件留在队列里每小时重试，配好就发。系统从不假装发出去过，也不因为配置缺席就把邮件丢掉。
- **静默时段不丢消息**：落在 `quietFrom–quietTo` 里的邮件推迟到窗口结束（每小时检查一次），而不是丢弃。
- **只有你能看**：每次投递都按 `userId` 过滤；手动投递只处理当前账号自己的队列。

## 配置

```bash
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false        # true 时用 465 隐式 TLS
SMTP_STARTTLS=true
SMTP_USER=
SMTP_PASS=
SMTP_FROM=               # 省略时用 SMTP_USER
NOTIFY_BATCH_SIZE=20     # 单次投递上限
```

没有 `SMTP_HOST` 时一切照常运行，邮件停在 `waiting` 状态等配置。`/settings/connectors` 会显示「未配置」，`/settings/notifications` 会写明原因。

单次投递（手动按钮或 cron）遇到进程崩溃不会卡住队列：认领时会写一张租约（`next_attempt_at`），租约过期后这一行可以被下一次投递重新认领。

## 开关与时区

用户的 `notifyEnabled`、`quietFrom`、`quietTo` 存在 `users` 表上，在 `/settings/notifications` 里改。时段按用户自己的 `timezone` 解释。默认 `22:00–08:00` 静默。

## 非目标

不做日报摘要、不做推送通知、不做站内信、不追踪打开率。这些都要在真实执行稳定之后再谈。
