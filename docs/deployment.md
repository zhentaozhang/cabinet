# 发布与恢复

> **适用范围**：本项目是本地学习项目——单进程、`RUN_EXECUTION=inline`、不部署到托管环境。
> 本文「发布中/回滚」段落描述的是**假设要上线时**的清单，当前没有任何流程会执行它们。
> 仍然可用的是：`pnpm preflight`（本地也能跑，检查「会不会安静地骗人」）、`GET /api/health`、
> `pnpm run:worker`（手动跑一轮，用来观察 `run_jobs` 队列）。没有常驻调度器，`worker` 模式不会被自动触发。

这一页只回答一个问题：**把新版本推上去之前和之后，各要看什么、发现不对怎么退回来。** 它不是架构文档。

## 发布前（每次）

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm db:migrate          # 先迁移，再换进程
pnpm preflight           # NODE_ENV=production，出错就退出 1
```

`pnpm preflight` 检查的是「会不会安静地骗人」：

| 检查 | 失败意味着 |
|---|---|
| `database.unreachable` | 数据库连不上，进程起来也是 500 |
| `schema.behind` | 迁移没跑，第一个用户请求才会 500 |
| `auth.unstated` | 生产环境没有显式写 `AUTH_REQUIRED=true`（warn，不是漏洞：见下面 `/api/health` 的 `auth.open`） |
| `demo.login` / `demo.mode` / `demo.reset` | 演示账号、模板产物或重置接口还开着 |
| `auth.secret_missing` | 没有 `BETTER_AUTH_SECRET`，会话签名不可信 |

`warn` 级别不阻塞发布，但每条都对应一个用户可见的降级：没配 SMTP → 通知显示「未发送」；没配检索 → 研究任务记 `not_configured`，永远过不了证据验收。`auth.unstated` 只说明意图没写明：`isAuthRequired()` 把 `NODE_ENV=production` 本身也算成要登录，所以生产进程不设 `AUTH_REQUIRED` 仍然会拒绝没有会话的请求。

确实要在生产开演示（客户演示环境），必须显式写 `ALLOW_DEMO_IN_PROD=true`——让「开演示」成为一个被记录的决定，而不是一个漏掉的变量。

## 发布中

1. `pnpm db:migrate`（只前进，不回滚迁移）
2. 启动新进程
3. `curl -fsS https://<host>/api/health` → 必须 200 且 `"ok":true`
4. `RUN_EXECUTION=worker` 时再启动 `pnpm run:worker`

`/api/health` 不需要登录（监控没有 cookie），返回：

```json
{ "ok": true, "status": "healthy", "failing": [],
  "checks": { "database": {...}, "schema": {...} },
  "warnings": [{ "code": "auth.open", "detail": "…" }],
  "queue": { "queued": 0, "staleRuns": 0 },
  "execution": "inline" }

`checks` 只有 `database` / `schema` 两项（它们决定 200 还是 503）；演示、鉴权、SMTP、检索这些是 `warnings` 里的条目，不会让探针失败。`auth.open` 说的是**这个进程此刻的事实**：只要当前不要求登录（本地 `pnpm dev` 就是这样），没有会话的请求就都是演示账号——它不猜「生产环境少写了哪个变量」。
```

数据库不可达、或 `run_jobs` 不存在时返回 **503**。`queue.staleRuns` 长期不为 0 说明有运行反复卡住，那是有东西在崩，不是队列在忙。

## 备份与恢复

```bash
# 备份
pg_dump "$DATABASE_URL" -Fc -f cabinet-$(date +%F).dump

# 恢复演练（必须在隔离库做，不要在生产上试）
createdb cabinet_restore
pg_restore -d cabinet_restore cabinet-2026-10-23.dump
psql "postgres://…/cabinet_restore" -c "select count(*) from audit_events"
```

**没有演练过的备份等于没有备份。** 恢复后至少确认三张表非空：`users`、`tasks`、`audit_events`——审计链断了的话，治理这套说辞就不成立了。

## 回滚

- **代码回滚**：切回上一个 release 并重启。进程内没有迁移状态，回滚是安全的。
- **迁移回滚**：不自动做。新增列带默认值、新增表不动旧表，所以上一个版本能跑在新库上；如果某个改动不能这样兼容，它就不该和代码一起发。
- **队列**：`run_jobs` 里的 `queued` 行会在下一个 worker 起来时继续执行；`running` 行在 `RUN_STALE_MINUTES` 后由恢复流程收尾。回滚期间不会有任务凭空消失。

## 事故处理顺序

1. **先看 `/api/health`**：是数据库、是 schema、还是配置。
2. **卡住的运行**：跑一次 `pnpm run:worker:once`，它先恢复再执行；输出的 `recovered/executed/blocked/failed` 就是现场。
3. **钱对不上**：查 `agent_budget_periods`（`reserved / settled / unknown`）与 `agent_budget_reservations`（`reserved / settled / released / unknown_charged`）。`unknown_charged` 是「可能花掉了但供应商没给回执」，不是错误，是账实相符的写法。
4. **审计链报警**：`GET /api/audit/verify` 返回 `{verified:false, firstMismatch}`，说明有人改了历史。先停写、导出全量，再谈修复——不要在链断的库上继续追加。
