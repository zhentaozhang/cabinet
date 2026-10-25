# 验收契约：把「怎样算做完」变成可以带走的文件

一句话：**验收清单不该只存在于本库的 `jsonb` 里。**「怎么算做完」是任务发起人和执行者之间的约定，
发起人、执行者、外部复核方应该读到同一句话。

- 代码：`src/lib/domain/acceptance-export.ts`（纯函数：`exportAcceptanceContract` / `renderAcceptanceContract`）
- 读模型：`src/server/readmodels/acceptance.ts` `loadAcceptanceContract(taskId, userId)`
- HTTP：`GET /api/tasks/[id]/acceptance`（JSON）、`?format=markdown`（`.md` 下载）

## 导出里的每一项

```json
{
  "version": 1,
  "taskId": "tsk_…", "title": "…", "criteria": "用户写的原文，逐字保留",
  "checks": [
    { "id": "0-section", "type": "section", "required": true,
      "statement": "必须包含小节 «结论»", "spec": { "section": "结论" }, "undetermined": false }
  ]
}
```

7 种类型都会被翻译成一句人能读懂的话 + 一份机器能读的 `spec`：

| 类型 | `statement` | `spec` | `undetermined` |
| --- | --- | --- | --- |
| `section` | 必须包含小节 «X» | `{ section }` | false |
| `min_words` | 正文至少 N 字（汉字按 1 字计） | `{ minWords }` | false |
| `min_sources` | 至少引用 N 个链接（只计数，不验证可达性） | `{ minSources }` | false |
| `min_evidence` | 至少 N 条检索证据，且 `[cite:evd_…]` 指向真实证据行；人工提交的产物没有证据库 | `{ minEvidence, citation }` | **true** |
| `contains` | 正文必须包含 «X» | `{ contains }` | false |
| `claims_table` | 断言表至少 N 行；格式系统查，内容人查 | `{ claimsTableRows }` | **true** |
| `manual` | 人工判定：<note> | `null` | **true** |

两个刻意的选择：

1. **`spec` 不是原始 item**。原始 item 六种类型用 `value`、`manual` 用 `note`，
   键名是实现细节；导出面向的是外部读者，键名要能自己解释自己。
2. **`undetermined` 只在三种类型上为 true：`manual`、`claims_table`、`min_evidence`。**
   判据是求值器 `src/lib/domain/acceptance.ts` 的真实行为，不是类型的名字：
   - `manual` 恒为 `{ passed: false, undetermined: true }`（:167-172）；
   - `claims_table` 格式合格时也恒为 undetermined（:142-147，「每行是否被原文支持需你逐行核对」）；
     但**格式不合格**（行数不足、缺列）时求值器给的是确定 `fail`（:139-140），
     导出侧没有原文可比，只能标 undetermined——所以「导出说 undetermined」不等于「系统从不判它」。
   - `min_evidence` 在人工提交的产物上 undetermined（:99-106），只有平台自己跑过检索、
     能拿到 `evidenceIds` 时才会判。

   第一版把这两个标成 false，外部复核方读到的就是「本仓库会判定它」——而它永远不会。
   这正是 `AGENTS.md` 第 2 条禁止的那种标签。

## 没有清单的任务

不是导出空数组，而是导出一条 `undetermined` 的人工项：「本任务没有验收清单，导出方没有逐条对照」。
空数组会被读成「没什么要检查的」，而那正是过去让 Auditor 写出「逐条对照通过」的措辞。

## 为什么要能 diff

导出里**没有时间戳、没有随机 id**，`checks[].id` 是 `<序号>-<类型>`。
所以同一个任务导出两次是逐字节相同的，改了一条验收标准就能直接 diff 出来改了哪一条。

```bash
curl -s localhost:3000/api/tasks/tsk_read/acceptance | jq .data.contract
curl -s 'localhost:3000/api/tasks/tsk_read/acceptance?format=markdown'
```

Markdown 版本会把「需人工判定」标在正文里，并在末尾单独统计条数：
签署的人不需要打开 JSON 才知道哪几项没人验过。

## 边界：这份契约不能证明什么

- 它证明的是**规则被逐条写出**，不证明**产物满足了规则**。判定发生在运行时
  （`evaluateAcceptance`），结果进 manifest 的 `acceptance[]`。
- `min_sources` 只数链接个数：不可达的链接、与结论无关的链接都算数。
- `claims_table` 只查格式（有表、行数够、每行引用能解析到真实证据 id）：
  「这句话有没有被原文支持」不判定。
- `min_evidence` 在人工提交的产物上不判定：没有检索证据可数，标 undetermined。
- `undetermined: true` 的条目**永远不会被算作通过**，导出和渲染都会把它标出来；
  但它也不会被算作失败——它是一条等待人签字的空位。
- 导出与某次运行无关：同一个任务导出两次逐字节相同，换一次运行也不变。

## 与 manifest 的分工

- **验收契约**回答「怎样算做完」，导出的是**规则**，与某次运行无关。
- **manifest**（`docs/manifest.md`）回答「这次运行到底产出了什么」，导出的是**哈希**。
  manifest 里的 `acceptance[].verdict` 是拿这份契约去评的结果，两者配合才是完整证据链。

## 测试

```bash
DATABASE_URL_TEST=postgres://localhost:5432/cabinet_test TZ=UTC \
  ./node_modules/.bin/vitest run tests/unit/acceptance-export.test.ts \
  tests/integration/acceptance-route.test.ts
```

覆盖：7 种类型各自的 `statement`/`spec`、`manual` 的 `undetermined` 与 `note`、
空清单导出一条人工项、两次导出逐字节一致、序号 id 稳定、Markdown 标注人工项、
路由 200/404（他人任务与不存在同答 404）与 Markdown 下载头。
