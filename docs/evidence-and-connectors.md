# 外部证据与检索连接器（M1）

> 目标：让「研究」这件事第一次真的发生，并且失败就是失败。

## 一句话规则

**证据 = 数据库里的一行 `evidence`，不是正文里的一个 URL。**

Auditor 只认 `evidence` 表里、属于本次 run 的行。正文里写什么链接都不算数，
因为模型可以凭空写一个看起来很像的 URL。

## 数据流

```
任务标题 + 描述
   → planTools(agent.tools × agent_grants)      选出 web_search / web_fetch
   → searchAndPersist()                         Brave →（可重试失败时）Tavily
   → evidence 表                                每行：url / title / publisher / quote / provider / retrievedAt / contentHash
   → generateArtifact(evidence)                 提示词给出来源清单，要求每处引用写 [cite:evd_xxx]
   → evaluateAcceptance(content, checklist, {evidenceIds})
   → 通过 / 驳回（驳回理由里写明引用了几条、有几处悬空引用）
```

## 连接器

| 变量 | 作用 | 失败语义 |
|---|---|---|
| `BRAVE_API_KEY` | 主检索（`api.search.brave.com`） | 401/403 → `unauthorized`（不切换提供方） |
| `TAVILY_API_KEY` | 备用检索（`api.tavily.com`） | 429/5xx/超时 → 自动切到 Tavily |

两者都没配：不报错、不编造，tool step 记录 `not_connected`，证据 0 条，
验收时 `min_evidence` 直接失败并说明原因。

超时 8 秒，一次调用只发一次请求——重试策略属于调用方，藏在循环里会掩盖失败。
响应体不是 JSON（例如网关错误页）记为 `invalid_response`，不会当成空结果。

## 验收项

| 类型 | 检查什么 | 是否证明「来源可靠」 |
|---|---|---|
| `min_evidence` | 正文中 `[cite:evd_xxx]` 且该 id 属于本次 run 的行数 | 证明「引用的是真实取回的东西」 |
| `min_sources` | 正文里 URL 的**数量** | **不证明**。文案固定写「仅计数，未验证可达性」 |

两点必须记住：

1. `min_evidence` 也不检查「这条来源是否支持这个结论」——那是人的工作。
2. 悬空引用（`[cite:evd_ghost]`）会让该项直接失败，避免用假引用凑数。

## 研究任务的默认清单

交给具备 `web_search` / `web_fetch` 的 Agent 的任务，如果没有显式清单，
创建时自动附加：

```json
[{ "type": "min_evidence", "value": 3, "required": true },
 { "type": "section", "value": "来源", "required": true }]
```

理由：没有证据要求的「研究任务」在形式上无法被驳回。

## 没有 key 时怎么验证

```bash
node node_modules/vitest/vitest.mjs run tests/unit/connectors.test.ts \
  tests/unit/evidence-citations.test.ts \
  tests/integration/evidence.test.ts \
  tests/integration/research-checklist.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

连接器测试全部使用注入的 `fetchImpl`，不会发出真实网络请求。

## 尚未覆盖（明确不在 M1 内）

- 站点抓取略过 JavaScript 渲染：`web_fetch` 抓的是服务器返回的 HTML 正文，需要登录或依赖前端渲染的页面会记录为「响应异常」而不是给出空证据。
- 不做可达性与相关性判断：能抓下来、能引用，不等于来源可靠。
- 可达性/时效性校验、来源质量评分。
- 检索成本计入预算：检索有自己的成本口径，混进 token 预算会模糊失败语义。
- 定时调度与主动推送：需要独立进程 + 幂等 + 重试，不能靠 `setInterval`。

## 默认验收清单的前置条件

给研究任务自动挂 `min_evidence: 3` 需要两个条件同时成立：执行 Agent 的工具里有 `web_search` / `web_fetch`，并且**至少配置了一个搜索 key**。没有 key 时不会挂这条要求——因为运行时一行证据都落不了库，挂上就等于让每个新装环境的调研任务注定被驳回，而用户在产品里没有地方能修好它。

需要人工判断的清单项（`manual`）永远不由系统判为通过，它们显示为「需人工复核」；由 Agent 运行产出、且清单里有证据要求时，`min_evidence` 才真正参与判定。

## `web_fetch`：抓任务自己给的链接

`web_fetch` 不搜索。它从任务的描述与验收标准里取第一个 http(s) 链接，抓那一页，把标题、正文首段（作为 `quote`）落成一条 `evidence`。

| 情况 | 步骤状态 | 证据 |
|---|---|---|
| 抓到了可读正文 | `ok` | 1 条 |
| 任务里没有链接 | `skipped`（未执行） | 0 条 |
| 目标不是公网地址 | `invalid_response` | 0 条 |
| 对方返回 PDF/图片等非文本 | `invalid_response` | 0 条 |
| 超过 2 MiB 或 10 秒超时 | `invalid_response` / `timeout` | 0 条 |
| 页面需要登录或纯前端渲染 | `invalid_response`（没有可读正文） | 0 条 |

**安全边界**：`http://localhost`、`127.0.0.1`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`*.local`、`*.internal` 一律拒绝，重定向后的最终地址会再检查一次。这是字面地址检查，不做 DNS 解析：一个解析到内网 IP 的公网域名仍然可能被访问到。抓取用的是任务作者本来就有的信任，这个守卫只保证「写字据时的笔误不会打到本机」。

## 检索费用为什么单列

模型费用按 token 结算，检索按次收费，两条曲线不同。`weeklyMetrics.search` 单独给出 `requests`、`priceCents`、`estimatedCents`：

- 只有真正到达过服务商的调用才计数（`ok` / `timeout` / `invalid_response` / `rate_limited`）；`not_connected`、`unauthorized`、`skipped` 没有产生费用，不计。
- 每次调用都在 `retrieval_calls` 落一行，带上**当时的单价快照**（`unit_price_cents`）与金额（`charged_cents`）。周报读的是这张表，所以事后改 `SEARCH_COST_CENTS_PER_REQUEST` 不会把上个月的花费重算一遍。
- 调用没返回可引用结果（`invalid_response`）也照样计费：钱已经花出去了，`evidence` 里没有行不代表这次调用不存在。
- `SEARCH_COST_CENTS_PER_REQUEST` 没配置时单价记 0，界面显示「未计价」，而不是假装免费；`unpricedRequests` 会把这类调用单独报出来。
- 这个金额**不会**进入 `weeklyMetrics.costCents`，也不影响模型的周预算上限 —— 混在一起会让「本周预算」失去意义。

`web_fetch` 抓一条任务指定的 URL 不计费（不是按次检索服务），但同样在 `retrieval_calls` 留痕，带上 `unit_price_cents = 0`。

## 主张—来源表（机器只验格式）

产物最后必须有一张 `## 主张—来源` 表：

```markdown
| 主张 | 引用 | 是否被原文支持 |
| --- | --- | --- |
| RAG 在生成前检索外部文档 | [cite:evd_a] |  |
```

系统做的只有两件事：这张表存在且行数达标；每一行的引用都能解析到**本次运行落库**的 `evidence` 行。

系统**不**做的那件事：判断一句原文是否真的支撑这条主张。所以 `claims_table` 规则永远返回「需人工复核」，不会自己变成「通过」。验收页把第三列留空给你填——填之前，那一行就是一条没有证据的结论。

这条规则和 `min_evidence` 的分工：`min_evidence` 数的是「引用了几条真实证据」（数量门槛），`claims_table` 管的是「哪句话用哪条证据」（对应关系）。两者都过，也只证明**引用是真实的**，不证明**结论是对的**。

## 检索也有上限

模型花费有周预算和硬上限，检索原本没有——这是唯一一处「配置写错就会无限花钱」的地方。
现在 `RETRIEVAL_WEEKLY_BUDGET_CENTS` 给它一个每周上限（默认不设）：

- 上限在**发请求之前**检查，超出后运行记为 `skipped`（未执行），并在 trace 里写明原因
- 「未设上限」不是「上限为 0」：前者照常检索，后者不存在
- 每次调用的单价在调用时快照进 `retrieval_calls.unitPriceCents`，改环境变量不会改写历史账单
- 本周实际花费显示在 Today 页，上限配置显示在 `/settings/connectors`
