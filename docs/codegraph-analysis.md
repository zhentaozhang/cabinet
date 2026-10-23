# CodeGraph 索引与架构分析（2026-10-22）

> 工具：`codegraph` v0.9.9（本地 daemon，SQLite / node:sqlite，WAL）
> 索引位置：`.codegraph/codegraph.db`　分析脚本：`scripts/codegraph-analyze.py`（barrel 感知的分层统计）

---

## 1. 本次更新结果

| 项 | 更新前 | 更新后 |
|---|---|---|
| 文件数 | 209 | **241**（分析脚本入库后 242） |
| 节点数 | 1,812 | **2,106**（脚本入库后 2,138） |
| 边数 | 3,922 | **4,152**（脚本入库后 4,184） |
| DB 体积 | 3.57 MB | **4.31 MB** |

`codegraph sync` 处理了 **110 个变更文件**（新增 33 / 修改 76 / 删除 1），耗时 476 ms。

节点构成：import 963 · function 372 · file 237 · property 208 · constant 193 · type_alias 113 · method 11 · class 8。
语言：typescript 192 · tsx 44 · yaml 4 · javascript 1。**0 个文件解析报错。**

> ⚠️ 索引不会自动更新：daemon 日志显示 `CODEGRAPH_NO_WATCH=1`，且 `.git/hooks` 里没有 codegraph 钩子。
> 目前只能靠手动 `codegraph sync` 或 MCP 启动时的 catch-up。建议 `codegraph init` 装 git 钩子，或在 CI 里加一步 sync。

---

## 2. 分层是否被遵守：是

按 `import` / `export … from` 语句还原的**模块级依赖矩阵**（行 = 引用方，列 = 被引用方，仅统计内部模块）：

| from \ to | contracts | lib | server | components | app/api | app/pages | proxy | scripts | tests | config |
|---|---|---|---|---|---|---|---|---|---|---|
| **contracts** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **lib** | 7 | 0 | **1** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **server** | 11 | 162 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **components** | 4 | 15 | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **app/api** | 0 | 69 | 28 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **app/pages** | 2 | 23 | **0** | 36 | 0 | 0 | 0 | 0 | 0 | 0 |
| **proxy** | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **scripts** | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **tests** | 0 | 129 | 22 | 1 | 1 | 0 | 0 | 0 | 0 | 1 |

结论与 `docs/frontend-backend-separation.md` 的设计完全一致：

- `contracts` 出度为 0（只依赖 zod），是真正的叶子层。
- `components` / `app/pages` 对 `server` **0 条边** —— 前端确实只经 `@/lib/api/*` 走 HTTP。
- `server` 不反向引用 UI（0 条），`app/api` 是唯一入口（34 个 route，全部有 handler）。
- **循环依赖 0 个**（Tarjan SCC，>1 文件的分量数量为 0）。

### 唯一的分层瑕疵

- `src/lib/engine.ts:1` → `@/server/services/engine`
  这是带 `@deprecated` 注释的迁移垫片，靠 ESLint `no-restricted-imports` 禁止 UI 引用它。
  但 ESLint 规则只覆盖 `src/app/**`、`src/components/**`，**`src/lib` 自身不受约束**，所以 `lib → server` 这条边在规则上是漏网的。
  建议在边界测试里补一条：`src/lib/**` 不得 import `@/server/*`，并把 `engine.ts` 加进白名单。

---

## 3. 热点：耦合集中在哪里

### 3.1 文件级 fan-in（有多少内部模块依赖它）

| 被依赖 | 次数 | 层 |
|---|---|---|
| `src/lib/db/schema.ts` | 71 | lib |
| `src/lib/db/index.ts`（`db` 句柄） | 64 | lib |
| `src/lib/domain/errors.ts` | 39 | lib |
| `src/lib/api/mutation.ts` | 25 | lib |
| `src/lib/demo.ts` | 22 | lib |
| `src/lib/audit.ts` | 21 | lib |
| `src/lib/ids.ts` | 20 | lib |
| `src/components/ui.tsx` | 19 | components |
| `src/contracts/index.ts`（barrel） | 17 | contracts |
| `src/lib/domain/time.ts` | 16 | lib |
| `src/lib/policy/config.ts` | 16 | lib |

`src/` 共 183 个 ts/tsx，**schema.ts 被 39% 的模块直接引用**；加 `db/index.ts` 后，
一次表结构调整的辐射面接近整个后端。这是当前最大的单点耦合。

### 3.2 符号级 fan-in

`db` 163 次、`newId` 38 次、`logAuditTx` 35 次、`toIso` 23 次、`deny` 23 次、
`assertTransition` 21 次、`handleQuery` 12 次。

`codegraph impact logAuditTx -d 3` → **53 个受影响符号**，跨越 `src/lib/audit.ts`、
`council/decide.ts`、`goals.ts`、`reflection.ts`、`api/memories/[id]/route.ts`、`lib/setup.ts` 等。
审计链是事实上的全局横切关注点。

### 3.3 复杂节点

| 文件 | LOC | 说明 |
|---|---|---|
| `src/lib/db/seed.ts` | 1625 | 演示数据，fan-out 93，占全库最大 |
| `src/lib/db/schema.ts` | 725 | 66 个符号，单一 schema 文件 |
| `src/components/actions/task-actions.tsx` | 581 | 22 符号，前端最重的组件文件 |
| `src/server/services/commands/tasks/run.ts` | 565 | 14 个内部依赖，后端最长链路 |
| `src/contracts/dto/entities.ts` | 487 | 58 个 DTO 符号 |
| `src/lib/domain/policy.ts` | 470 | 73 个符号，全部是策略类型 + 3 个纯函数 |

`policy.ts` 是"类型多、函数少"（73 符号 / 3 个决策函数 `decideRun`、`decideAudit`、`decideUpgrade`），
本身不算复杂度问题；真正的执行复杂度集中在两个函数：`runTask`（`tasks/run.ts:32`，55 条出边）
与 `runApprenticeExam`（`apprentice.ts`，43 条出边）。

---

## 4. 索引质量问题（影响后续所有图查询）

| 现象 | 数据 | 影响 |
|---|---|---|
| 引用未解析 | **4,004 条** unresolved（vs 4,152 条已解析边） | 主要为 zod / drizzle 链式方法：`eq` 278、`notNull` 206、`z.string` 201、`where` 181、`text` 167、`z.number` 158 |
| `export … from` 不计边 | 4 个 barrel：`contracts/index.ts`(17 引用)、`server/readmodels/index.ts`(11)、`components/actions.tsx`(5)、`components/actions/index.ts`(1) | 裸索引里会产生 **21 个假孤儿**（`readmodels/*`、`actions/*` 全部"没人引用"） |
| 嵌套箭头函数内调用丢失 | `src/app/api/tasks/[id]/run/route.ts:17` 的 `await runTask(...)` 位于 `handler: async () => {}` 中，**既无 call 边也不在 unresolved 表** | `codegraph callers runTask` 返回 empty，实际有调用方 |
| JSX 渲染不算 call | 组件 fan-in 普遍偏低 | `ui.tsx` / 组件复用度被低估 |
| 类型使用不建模 | 302 个"导出但无引用"符号 | 其中绝大多数是 zod schema / DTO 类型 / route handler，**不能当作死代码清单** |

把 barrel 展开后重新计算，**真正的孤儿只剩 1 个**：`src/lib/auth/session.ts`。
`getSession()` / `requireUser()` 无人引用，`src/lib/auth/context.ts:11` 已经内联了同样的逻辑 —— 可以删除。

---

## 5. 其他发现

1. **文档漂移**：`docs/frontend-backend-separation.md` 写"18 个 route handler"，实际 **34 个**。
2. **路由命名不一致**：读路径用单数、写路径用复数 —— `GET /api/council` 与 `POST /api/councils`，
   以及 `GET /api/memory` 与 `DELETE /api/memories/[id]`。
   `src/contracts/routes.ts:1` 是路径的唯一来源（纯常量白名单，出度为 0 属正常），
   里面已经用 `councilBoard` / `councils` 区分开了，但同一行塞了两个属性（`routes.ts:14` 的
   `memoryItem` 与 `councilBoard` 挤在一行），建议拆行并补一句"单数读 / 复数写"的注释。
3. **测试触达率**：139 个非 API 的 src 模块中，被测试文件直接 import 的只有 **43 个**。
   50 个测试文件 / 5,580 行测试，覆盖重心在 `tests/integration/`（25 个）。
   `readmodels/*`、`services/queries/*` 在图上显示"未覆盖"，实际是通过 `@/server/readmodels` barrel 间接覆盖的
   —— 属于第 4 节的同一处盲区，不能直接当覆盖率结论用。
4. **路由-服务耦合很干净**：34 个 route 平均只 import **0.8 个** `src/server/*` 模块，
   最重的 `agents/[id]/route.ts` 也只 import 2 个（readmodel + command），
   转发逻辑基本都在 `handleQuery` / `handleMutation` 里，抽 `apps/api` 的成本很低。

---

## 6. 建议（按性价比排序）

1. **装 codegraph git 钩子**或 CI 里 `codegraph sync`，否则图会持续过期（当前 110 个文件才刚追平）。
2. **补一条边界测试**：`src/lib/**` 禁止 import `@/server/*`，白名单只留 `lib/engine.ts`
   （`tests/unit/boundary.test.ts:35` 的 `SERVER_ONLY` 目前只作用于 `src/app/**` 与 `src/components/**`）。
3. **删 `src/lib/auth/session.ts`**（唯一真孤儿）。
4. **拆 `schema.ts`**（71 个模块直接依赖）到按域的多个文件 + 统一 `src/lib/db/tables.ts` barrel；
   这是降低"改一处表结构动全站"成本的唯一结构性手段。
5. **修文档**：route 数量 18 → 34；把 `council` / `councils` 的命名规则写进 `contracts/routes.ts`。
6. **查图时用 barrel 展开**：`codegraph callers/impact` 对通过 barrel 的符号会漏，
   跨模块的调用关系以 `scripts/codegraph-analyze.py` 的文本解析结果为准。
