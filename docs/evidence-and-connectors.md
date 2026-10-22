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

- 抓取正文（`web_fetch` 目前与 `web_search` 同一实现）。
- 可达性/时效性校验、来源质量评分。
- 检索成本计入预算：检索有自己的成本口径，混进 token 预算会模糊失败语义。
- 定时调度与主动推送：需要独立进程 + 幂等 + 重试，不能靠 `setInterval`。
