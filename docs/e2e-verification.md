# 端到端验证：一次「诚实失败」的真实记录

这个仓库的核心承诺不是「能跑通」，而是**跑不通的时候会说清楚**。
所以端到端验证要验的也不是 happy path，而是：检索失败、零证据、验收驳回这条链条上，
每一层有没有偷偷把失败讲成成功。

## 怎么跑

```bash
next build
BRAVE_API_KEY=invalid-key DEMO_MODE=true next start -p 3970
node --import tsx scripts/e2e-probe.ts     # 或 E2E_BASE=http://host:port node --import tsx ...
```

`DEMO_MODE=true` 让草稿走模板（不花钱、不需要模型密钥），
`BRAVE_API_KEY` 故意给一个无效值，用来**触发真实的提供方错误**——
这不是 mock：请求真的发出去了，Brave 真的回了 422。

退出码 0 表示「每一层的结论与它实际做过的事一致」，
退出码 1 表示某一层在谎报（脚本会打印是哪一条断言）。

## 2026-10-24 的实际输出

```
sign-in                    200
create task                200 tsk_sk9xVQmxhZLp
run                        200 {"ok":true,"data":{"runId":"run_qw4Htkmopmbb","artifactId":"art_xS0CqOkUKWH2"}}
runs recorded              1
  run                      succeeded · demo · -
  web_search               invalid_response · "brave 返回了意外的状态码 422。"
evidence rows              0
audit decision             rejected
acceptance items           3
  min_evidence             未通过 · 引用了 0 条已落库证据，要求至少 3
  claims_table             未通过 · 主张—来源表不合格：没有找到「主张—来源」表
  section                  未通过 · 缺少章节「来源」
audit chain                完整 · 38 条
```

## 每一行证明了什么

| 观察 | 说明 |
|---|---|
| `web_search → invalid_response · brave 返回了意外的状态码 422` | 连接器把**提供方原话**记了下来，没有降级成「检索成功但没结果」 |
| `evidence rows 0` | 失败没有被写成空证据充数 |
| `run → succeeded · demo` | 这是需要解释的一行：**运行成功 ≠ 交付合格**。run 描述的是「这次执行跑完了、产出了草稿」，验收结论在 Auditor 那一层；`demo` 标记说明草稿是模板，不是模型产出 |
| `audit decision → rejected` | 分离验收在真实数据上生效：执行者不能给自己的产物盖章 |
| 三条 `acceptance items` 全部 `未通过` 且带原因 | 驳回不是一句「不合格」，而是逐条给出可复核的理由 |
| `audit chain 完整 · 38 条` | 上面每一步都进了哈希链，事后可验证没被改过 |

## 什么情况算「这一层在谎报」

脚本里写死了这几条断言，它们才是这个探针的价值：

- 零证据，但工具步骤报告 `ok` —— 说明检索层把失败吞掉了
- 零证据却被验收通过 —— 说明 Auditor 放水
- 审计链校验不通过 —— 说明有写入绕过了 `logAuditTx`

## 已知边界（不要过度解读这次验证）

- 验证的是**失败语义**，不是真检索质量：真实提供方返回结果、证据落库、引用对上号，
  需要真实密钥；本次用无效密钥只证明了失败路径诚实。
- `DEMO_MODE=true`，所以草稿是模板。生产环境必须 `DEMO_MODE=false`，
  否则 `/api/health` 会以 `degraded` 报出「artifacts are templates」。
- 探针会真的建一条任务并留库；在共享环境跑完记得清理，或只对演示账号跑。

## 与其它验证的关系

- `pnpm test`：单元/集成，覆盖规则与命令，不需要网络
- `pnpm e2e:probe`：本文，覆盖真实 HTTP + 真实数据库 + 真实提供方错误
- `pnpm bench:reads`：读路径 p50/p95，用于判断是否需要索引或缓存
  （见 `docs/caching-decision.md`）
