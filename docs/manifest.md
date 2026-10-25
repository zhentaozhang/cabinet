# Run manifest：把一次运行导出成别人能自己验的文件

一句话：**manifest 不是运行日志，而是一份「不需要信任我方数据库」的声明。**
它只带哈希、不带 prompt；能离线用一条命令验完；验不过就是 exit 1。

- 代码：`src/lib/domain/manifest.ts`（纯函数 + 校验）、`src/server/services/commands/tasks/manifest.ts`（从库里装配）
- CLI：`scripts/verify-manifest.ts`
- HTTP：`GET /api/tasks/[id]/manifest[?run=<runId>]`

## 里面有什么

```json
{
  "version": 2,
  "runId": "run_…", "taskId": "tsk_…", "agentId": "ag_…", "userId": "usr_…",
  "status": "succeeded", "createdAt": "…",
  "model": { "provider": "openai", "model": "gpt-4.1-mini" },
  "promptVersion": 1,
  "steps": [{ "idx": 0, "type": "tool", "tool": "read_notes",
              "inputHash": "…64 hex…", "outputHash": "…64 hex…" }],
  "artifacts": [{ "id": "art_…", "sha256": "…" }],
  "evidence": [{ "id": "evd_…", "contentHash": "…" }],
  "acceptance": [{ "item": { "type": "min_words" }, "verdict": "pass", "undetermined": false },
                 { "item": { "type": "manual" }, "verdict": "undetermined", "undetermined": true }],
  "acceptanceRunId": "run_…",
  "approvals": [{ "id": "apr_…", "action": "send_email", "status": "approved", "decidedAt": "…" }],
  "auditHead": { "seq": 412, "hash": "…64 hex…" },
  "merkleRoot": "…64 hex…",
  "digest": "…64 hex…"
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

## 两类哈希：树根管 steps，digest 管其余

- `merkleRoot` 只覆盖 **steps**。它让「给一部分 step 就能验」成立。
- `digest` = `sha256(canonicalJson(整个 manifest 除 digest 之外))`，覆盖**所有其它字段**：
  验收判定值、审批记录、产物/证据 id、删除掉的一整段、以及本代码还不认识的新字段。

为什么两者都要：第一版只有 `merkleRoot`，于是把 `acceptance[0].verdict` 从 fail 改成 pass、
或者把 `approvals` 整段删掉，`ok` 仍然是 `true`——而验收判定正是外部审计方最先看的那行。
提交 `9a3d549` 之后的审查用三条手工篡改抓到了这一点，改法就是加 `digest`（`MANIFEST_VERSION` 因此变成 2）。

代价要说清楚：**字段被改而 digest 没被同步改，manifest 验得出来；如果有人把 digest 一起改掉，
单靠 manifest 验不出来**——digest 保护的是「文件没有被随手改动」，不是「这份文件来自我方」。
后者需要 `auditHead` 对上审计链，再往上需要外部锚定（见「已知未做的」）。

## 验收判定有三种，不是两种

`verdict` = `pass` / `fail` / `undetermined`。第三种不是「弱一点的 fail」：
它表示**没有人判过**（人工规则、需要逐行读原文的 claims table、人工提交的产物没有检索证据）。
第一版把这些行写成 `verdict: "fail"`，于是只读 `verdict` 的消费方会把「没判定」读成「不合格」，
而 `AGENTS.md` 第 2 条要的正好相反：没做的事要显示成没做。审查用这一条抓到了
（`src/lib/domain/acceptance.ts:142-147`、`:99-106` 的求值器行为是判据）。

`undetermined` 布尔字段与 `verdict` 表意重复，是为了兼容只读布尔的老消费方；
两者必须一致，`structure` 检查会拒绝互相矛盾的条目。

## Merkle 规则（写死，避免「自己实现自己验」）

| 叶子数 | 根 |
| --- | --- |
| 0 | `null` |
| 1 | 该叶原样 |
| ≥2 | 成对 `sha256(a + b)`，a/b 按字典序小在前；奇数个时最后一个节点**直接晋级**，不复制 |

不复制最后一个是刻意的：复制会让 `[a]` 和 `[a, a]` 得到同一个根，
而「只有一步」和「同一步做了两遍」在审计里是两件完全不同的事。

成对哈希按字典序排（所以 `[aa, bb]` 与 `[bb, aa]` 同根）：树根证明的是**有哪些叶、怎么配对**，
不证明它们在数组里的先后。叶子本身含 `idx`（见下），所以把两步对调会改变各自的哈希；
真正兜住「顺序」的是 `digest`——它覆盖整个文件，`steps` 数组的顺序也在里面。
只拿 `merkleRoot` + 部分叶子复核时，请把顺序当成未判定，而不是当成已核对。

叶子 = `sha256(canonicalJson({idx, type, tool, inputHash, outputHash}))`，
`canonicalJson` 来自 `src/lib/ids.ts:13-30`（键排序、无空格），所以重新序列化不会改变根。

## 校验能证明什么

`verifyManifest(manifest, { chain? })` 返回 `{ ok, checks, unchecked, mismatches }`：

| 检查 | 能证明 | 什么时候跳过 |
| --- | --- | --- |
| `structure` | 版本、id 非空、哈希是 64 位小写 hex、`verdict` 只用 pass/fail/undetermined 且与 `undetermined` 标志一致 | 有结构问题时**不进 `checks`**：只读 `checks` 的调用方否则会把坏文件当成好的 |
| `digest` | 重算整个文件的 digest，与文件里写的 `digest` 一致 | **自身**不匹配时**不进 `checks`**（别的检查失败不影响这一行的出现，它验的是另一种篡改） |
| `merkle` | 用 manifest 里现有的 step 重算，根一致 | 该 run 没有任何 step 时进 `unchecked`：没有叶子就没有证明，不能记成通过 |
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
- **验收判定按任务取，不按 run 取**：审计本身是一次运行，它的 `audit` step 挂在审计那次 run 上，
  所以 manifest 取的是「该任务最新一条 `audit` step」，用 `acceptanceRunId` 写明来自哪次 run。
  「最新」按 `createdAt desc, id desc` 排——同一事务写下的行共享 `now()`，只按时间排会让同一份 run
  两次导出得到不同 digest。要判定「这份验收是不是针对这一次 run」，看 `acceptanceRunId`，
  manifest 不能替你判断，因为它没有这条边。
- **审批按「谁花掉了它」归属**：`approvals.run_id` 在消费那一刻写入消费它的 run
  （`src/server/services/commands/tasks/run.ts` 的条件 UPDATE）。manifest 只列 `run_id` 为空（还没被任何 run
  消费）或等于本 run 的审批，排序 `createdAt asc, id asc` 以保证可复现。
  两个必须说清的边界：一，2026-10-25 之前消费的审批 `run_id` 是空的，仍对所有 run 可见；
  二，「哪次 run 申请了这条审批」没有记录——被消费的审批属于**执行**它的 run，不是申请它的 run。
  崩溃恢复会把手里的审批交还任务（`reopenConsumedApprovalsTx` 把 `consumedAt` 和 `runId` 一起清空），
  所以「`run_id` 为空」既可能是没人花过，也可能是被交还了；两种都对该任务的每个 run 可见。
- **常设授权不在 manifest 的 `approvals` 里**：`agent_grants.created_by_approval_id`
  （`src/lib/db/schema/agents.ts:65`）记录「这条常设授权当初是哪一次审批开出来的」。一次 run 如果靠
  已经生效的常设授权放行，它自己根本没有申请审批，所以 manifest 的 `approvals` 是空数组——
  空数组的意思是「这次 run 没花掉任何一次性审批」，不是「没有人为它放行」。
  「谁授权了这个 Agent 做这件事」只能去审计链查 `grant` 相关条目，manifest 不重复这一点。

## 测试

```bash
DATABASE_URL_TEST=postgres://localhost:5432/cabinet_test TZ=UTC \
  ./node_modules/.bin/vitest run tests/unit/manifest.test.ts \
  tests/integration/manifest.test.ts tests/integration/manifest-route.test.ts
```

覆盖：`digest` 抓到「改验收判定」「删一段」「改审批」，空 steps 进 `unchecked`；Merkle 三种叶子数（含奇数晋级与「不复制」反证）、`canonicalJson` 与键序无关、
篡改某个 `outputHash` 后 `ok:false` 且 path 指向 `merkleRoot`、伪造 `auditHead` 被链拒、
CLI 原文件 exit 0 / 篡改文件 exit 1 / 错链 exit 1、路由 401/404/200 与「响应体不含 prompt」。