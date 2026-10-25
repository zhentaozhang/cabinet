# Run manifest：把一次运行导出成别人能自己验的文件

一句话：**manifest 不是运行日志，而是一份「不需要信任我方数据库」的声明。**
它只带哈希、不带 prompt；能离线用一条命令验完；验不过就是 exit 1。

- 代码：`src/lib/domain/manifest.ts`（纯函数 + 校验）、`src/server/services/commands/tasks/manifest.ts`（从库里装配）
- CLI：`scripts/verify-manifest.ts`
- HTTP：`GET /api/tasks/[id]/manifest[?run=<runId>]`

## 里面有什么

```json
{
  "version": 1,
  "runId": "run_…", "taskId": "tsk_…", "agentId": "ag_…", "userId": "usr_…",
  "status": "succeeded", "createdAt": "…",
  "model": { "provider": "openai", "model": "gpt-4.1-mini" },
  "promptVersion": 1,
  "steps": [{ "idx": 0, "type": "tool", "tool": "read_notes",
              "inputHash": "…64 hex…", "outputHash": "…64 hex…" }],
  "artifacts": [{ "id": "art_…", "sha256": "…" }],
  "evidence": [{ "id": "evd_…", "contentHash": "…" }],
  "acceptance": [{ "item": { "type": "min_words" }, "verdict": "pass", "undetermined": false }],
  "acceptanceRunId": "run_…",
  "approvals": [{ "id": "apr_…", "action": "send_email", "status": "approved", "decidedAt": "…" }],
  "auditHead": { "seq": 412, "hash": "…64 hex…" },
  "merkleRoot": "…64 hex…"
}
```

全部字段都是**从表里读回来再算的**，不采信执行器内存里的「本来打算做什么」：
一个用意图拼出来的 manifest 什么都证明不了，而一个用「攻击者能改的行」拼出来的 manifest
恰好证明了对的事——改了行，哈希就变。

## 为什么 step 只有哈希

`steps.input` 里是用户的 prompt、任务描述和检索到的原文；`output` 里是产物正文。
manifest 是要发给外部审计方的文件，带正文等于把工作区一起发出去，所以：

- 输入、输出各算一个 `sha256(canonicalJson(value))`；
- 产物（`artifacts`）与证据（`evidence`）只带 id + 哈希；
- `promptVersion` 是个**手动 bump 的整数常量**（`src/lib/llm.ts` 的 `PROMPT_TEMPLATE_VERSION`），
  不是 `Function.prototype.toString()` 的哈希——打包、压缩、dev overlay 都会改源码文本，
  同一份 prompt 会在 dev 和 prod 得出不同版本号，那样「版本」就失去了可比性。

代价要说清楚：**step 的 `input`/`output` 被改而哈希表没被同步改，manifest 验得出来；
但如果有人把库里的行和 manifest 里的哈希一起改掉，单靠 manifest 验不出来**——
那需要审计链和外部锚定（见下文）。

## Merkle 规则（写死，避免「自己实现自己验」）

| 叶子数 | 根 |
| --- | --- |
| 0 | `null` |
| 1 | 该叶原样 |
| ≥2 | 成对 `sha256(a + b)`，a/b 按字典序小在前；奇数个时最后一个节点**直接晋级**，不复制 |

不复制最后一个是刻意的：复制会让 `[a]` 和 `[a, a]` 得到同一个根，
而「只有一步」和「同一步做了两遍」在审计里是两件完全不同的事。

叶子 = `sha256(canonicalJson({idx, type, tool, inputHash, outputHash}))`，
`canonicalJson` 来自 `src/lib/ids.ts:13-30`（键排序、无空格），所以重新序列化不会改变根。

## 校验能证明什么

`verifyManifest(manifest, { chain? })` 返回 `{ ok, checks, unchecked, mismatches }`：

| 检查 | 能证明 | 什么时候跳过 |
| --- | --- | --- |
| `structure` | 版本、id 非空、哈希是 64 位小写 hex、`verdict` 只用 pass/fail | 结构坏了直接 `ok:false` |
| `merkle` | 用 manifest 里现有的 step 重算，根一致 | — |
| `auditHead` | 该 user 审计链里存在 `seq` 且哈希一致 | 没给 `chain`，或 `auditHead` 为 `null` 时进 `unchecked` |

`unchecked` 里的项**永远不算通过**。这是 `AGENTS.md` 第 2 条的同一件事：
没做的事要显示成没做，而不是显示成做过了。

`auditHead` 允许为 `null`（该用户还没有任何审计事件）。用 `{seq: 0, hash: …}` 假装存在
会让校验方必须去怀疑一个本来就空的锚点，不如直接把它标成「没有锚」。

## 离线验证

```bash
# 只看 manifest 自身（structure + merkle）
./node_modules/.bin/tsx scripts/verify-manifest.ts run-manifest.json

# 同时核对审计锚（chain.json 是 [{ "seq": 12, "hash": "…" }]，或 { "events": [...] }）
./node_modules/.bin/tsx scripts/verify-manifest.ts run-manifest.json --chain chain.json
```

退出码：`0` = 能跑的检查全过；`1` = 有 mismatch；`2` = 文件读不了或不是 JSON。
除 0 以外都应让流水线失败。脚本**不连数据库**、不读环境变量，只依赖 `node:fs`。

## 从 HTTP 取

```
GET /api/tasks/tsk_read/manifest            # 该任务最新一次「产出型」运行
GET /api/tasks/tsk_read/manifest?run=run_x  # 指定某一次运行
```

- 响应体就是 manifest 本身（不是 `{ok, data}` 包装），并带
  `content-disposition: attachment; filename="<runId>.manifest.json"`，浏览器直接当文件下载。
- 默认跳过含 `audit` step 的运行：审计本身也是一次运行，把审计的 manifest 当成交付物的
  manifest 会描述「检查者」而不是「被检查的活」。
- 别人的 run、不存在的 run、别人的 task 都回答同一个 404；不带 session 且要求认证时 401。

## 已知未做的

- **没有外部锚定**：`auditHead` 只对接到本库的审计链。要防「连库带 manifest 一起改」，
  得把链头定期写到本库之外（Git 提交、透明日志、时间戳服务）——这是 ★2 的下一步，不是现在的实现。
- `approvals` 里没有 `approverId`：`approvals` 表没有这一列，审批人只存在于审计链的
  `actor` 字段。manifest 因此只写 `{id, action, status, decidedAt}`，
  「谁批的」要回审计链查。计划里写的 `approverId` 是设计口径，实现按表结构落了。
- 没有签名：manifest 不自证来源，只自证完整。

## 测试

```bash
DATABASE_URL_TEST=postgres://localhost:5432/cabinet_test TZ=UTC \
  ./node_modules/.bin/vitest run tests/unit/manifest.test.ts \
  tests/integration/manifest.test.ts tests/integration/manifest-route.test.ts
```

覆盖：Merkle 三种叶子数（含奇数晋级与「不复制」反证）、`canonicalJson` 与键序无关、
篡改某个 `outputHash` 后 `ok:false` 且 path 指向 `merkleRoot`、伪造 `auditHead` 被链拒、
CLI 原文件 exit 0 / 篡改文件 exit 1 / 错链 exit 1、路由 401/404/200 与「响应体不含 prompt」。
