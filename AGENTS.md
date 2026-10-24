<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 后端链路约定（改后端前必读）

以下是审查 docs/backend-chain-review.md 之后总结的三条反模式。它们都曾在本仓库真实发生过，不是假设。

1. **状态写回必须带条件，并且检查影响行数。**
   `UPDATE ... WHERE id = ? AND status = ?`，`returning()` 为空就抛 `ConflictError`。
   反例：无条件 `update(tasks).set({ status })` 会把并发期间用户手动改过的状态静默覆盖掉，
   而且日志里看不出发生过竞争。参考实现见 src/server/services/commands/tasks/cancel.ts。

2. **报告里的每一句话都要有对应证据，没有证据就写"未判定"。**
   反例：任务没有验收清单时，Auditor 却写「产物存在，验收标准逐条对照通过」——逐条对照根本没发生，
   这句话还会直接显示给用户。现在的做法是补一条 `undetermined: true` 的人工项
   （src/server/services/commands/tasks/audit.ts），让页面显示"需要你人工判定"。
   同理：审计行要记下被判定的 `artifactId`，否则报告无法回溯到它描述的那份内容。

3. **时间判断用数据库时钟，后台维护只走 tick 单一入口。**
   租约/领取用 `sql`now()`` 而不是 Node 的 `new Date()`，否则多实例时钟漂移会让同一行被重复领取。
   过期审批、重试耗尽、限流表清理、幂等键清理、outbox 归档全部收在
   `pnpm tick`（src/server/jobs/maintenance.ts）里，不要在 request handler 里临时起循环。
