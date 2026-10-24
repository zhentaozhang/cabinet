# CodeGraph 索引与架构分析（2026-10-24）

> 工具：`codegraph` 本地索引（SQLite / node:sqlite，WAL），DB 在 `.codegraph/codegraph.db`
> 分析脚本：`scripts/codegraph-analyze.py`（barrel 感知 + type-only 感知的分层统计）
> 数据来源：**脚本直读 DB**。MCP 的 `codegraph_status` 会返回缓存的旧数字（见 §5.1），不要用它当口径。

---

## 1. 索引现状

| 项 | 值 |
|---|---|
| 文件 | **387**（其中 `src/lib/db/schema/` 10 个域模块） |
| 节点 | **3,952** |
| 边 | **8,697** |
| DB 体积 | 7.52 MB |
| 幽灵文件（索引里有、磁盘上没有） | **0** |
| 语言 | typescript 303 · tsx 69 · yaml 4 · python 1 · javascript 1 |

仓库规模：`src` 35,349 行，`tests` 97 个 `.test.ts` / 852 个测试，`src/app` 44 个 `route.ts` + 13 个 `page.tsx`，数据库 35 张表。

---

## 2. 本次（2026-10-24）修掉的问题

上一版（2026-10-22）列了 6 条建议，这次执行了其中 5 条：

| # | 问题 | 处理 |
|---|---|---|
| 1 | 边界规则漏掉 `src/lib` | `tests/unit/boundary.test.ts` 新增 "the shared layer never imports the server"，先跑红再跑绿；随后把唯一的豁免也删了（见 #7），规则现在是**零例外** |
| 2 | `src/lib/auth/session.ts` 是零引用真孤儿 | 删除（`src/lib/auth/context.ts:11` 早已内联同样逻辑） |
| 3 | 分析器把 `import type` 当运行时边 | 新增 `is_type_only()`，拆 `deps` / `type_deps`；环检测只看 `deps`。**假环 policy.ts ↔ standing-grants.ts 归零** |
| 4 | `src/lib/db/schema.ts` 1,128 行单体 | 拆成 10 个域模块 + 25 行 barrel，`drizzle-kit generate` 报 "No schema changes" 证明零语义漂移 |
| 5 | `runTask` 827 行单函数 | 抽出 `resetForRetry` / `suggestInsteadOfRunning` / `awaitApproval`，主函数降到 701 行 |
| 6 | 文档口径失真 | README 的 33 张表 / 34 个 route / 792 个测试，以及 separation 文档的 18 个 route，全部改真值 |
| 7 | `src/lib/engine.ts` 是 `lib → server` 的唯一越界点 | 20 个集成测试改为 import `@/server/services/engine`，删文件、删白名单、删 eslint 里的死 pattern。`lib → server` 现在是 **0 条边** |

**当前状况：循环依赖 0、真孤儿 0。**

---

## 3. 分层是被遵守的

模块级依赖矩阵（行 = 引用方，列 = 被引用方；只统计 `import` / `export … from`，且不含编译期擦除的 type-only 边）：

| from \ to | contracts | lib | server | components | app/api | app/pages | proxy | scripts | tests | config |
|---|---|---|---|---|---|---|---|---|---|---|
| **contracts** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **lib** | 8 | 0 | **1** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **server** | 14 | 228 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **components** | 7 | 31 | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **app/api** | 2 | 84 | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **app/pages** | 5 | 36 | **0** | 53 | 0 | 0 | 0 | 0 | 0 | 0 |
| **proxy** | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **scripts** | 0 | 12 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **tests** | 8 | 230 | 48 | 2 | 3 | 0 | 0 | 1 | 0 | 1 |
| **config** | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

结论：

- `contracts` 出度为 0（只依赖 zod），是真正的叶子层。
- `components` / `app/pages` 对 `server` **0 条边** —— 前端只经 `@/lib/api/*` 走 HTTP。
- `server` 不反向引用 UI（0 条）；`app/api` 是唯一入口，44 个 route 全部声明了 handler。
- `lib → server` **0 条边**。2026-10-24 之前还有 1 条（`src/lib/engine.ts` 的 @deprecated 垫片），现在已删除；边界测试同步去掉了白名单，越界就必须改规则本身。

---

## 4. 耦合热点

### 4.1 文件级 fan-in

| 被依赖 | 次数 | 层 |
|---|---|---|
| `src/lib/db/index.ts`（`db` 句柄） | 104 | lib |
| `src/lib/db/schema.ts`（barrel） | 104 | lib |
| `src/lib/domain/errors.ts` | 48 | lib |
| `tests/helpers/db.ts` | 45 | tests |
| `src/lib/demo.ts` | 40 | lib |
| `src/lib/api/mutation.ts` | 31 | lib |
| `src/lib/format.ts` / `src/lib/ids.ts` | 29 | lib |
| `src/components/ui.tsx` | 27 | components |
| `src/lib/audit.ts` | 24 | lib |

`schema.ts` 的 104 里有 6 个是 type-only（被新口径排除），拆分前按旧口径是 110。**关键是这个数字不再随表数量增长**：加一张记忆相关的表只改 `schema/memory.ts`。

真正的辐射面仍是 `db/index.ts`（104，全站直接拿 `db` 句柄）与 `domain/errors.ts`（48，所有命令层都抛它们）。

### 4.2 barrel

4 个：`src/components/actions.tsx`(8)、`src/components/actions/index.ts`(1)、`src/contracts/index.ts`(19)、`src/server/readmodels/index.ts`(13)。

### 4.3 路由与服务的耦合

**36 of 44** route 文件直接 import `src/server/*`，平均每个 route 只 import 不到 1 个 server 模块 —— 转发逻辑都在 `handleQuery` / `handleMutation` 里，物理拆分 `apps/api` 的成本仍然很低。

---

## 5. 索引质量问题（会误导判断，务必知道）

### 5.1 `codegraph_status` 返回缓存值

重建索引之后，MCP 的 `codegraph_status` 仍报 379 files / 3,899 nodes / 8,398 edges，而 DB 实测是 **387 / 3,952 / 8,697**。判断"索引新不新"要看脚本直读的结果，或者看分析器有没有打 `### Index is stale` 警告。

### 5.2 索引不会自动刷新

`codegraph init .` 在已初始化时是 **no-op**。删了文件、加了文件，索引都不会变。要刷新只有一条路：`rm -rf .codegraph && codegraph init .`（约 1.5 s）。分析器现在会检测"索引里有、磁盘上没有"的幽灵文件并打印警告，但**新增文件不会被发现** —— 所以改完代码就先重建。

### 5.3 嵌套箭头函数里的调用丢边

`src/app/api/tasks/[id]/run/route.ts` 的 `await runTask(...)` 位于 `handler: async () => {}` 里，图上既没有 call 边也不在 unresolved 表 —— `codegraph callers runTask` 返回空。跨模块的调用关系以 `scripts/codegraph-analyze.py` 的文本解析为准。

### 5.4 符号级 fan-in 有噪声

对象字面量的属性名会被当成同名符号：旧版索引里 `email.ts:17` 的 property `from` 报了 293 次 fan-in，`limit` 报了 67/37 次。**文件级 fan-in 可信，符号级要人工过滤。**

---

## 6. 还没做的（按性价比排序）

1. ~~首屏 JS 偏大~~ **已测量，不是问题**：787.8 KB 原始 / **252.1 KB gzip**，其中 499 KB 原始（153 KB gzip）是 Next/Turbopack + React 运行时，应用代码约 135 KB gzip，markdown 依赖不进客户端。详见 `docs/caching-decision.md`。继续砍它的收益在 10 KB 量级。
2. **`db` 句柄收口**：104 个模块直接 `import { db }`。按域提供 repository 会让事务边界看得见，但这是个大迁移。
3. **`seedDemo` 1,611 行**：它是 demo 数据字面量，拆开只是分装。真正的改进是让 CI 用 SQL fixture，那是另一个议题。
4. **页面巨型组件**（`TaskPage` 1,105 行、`TodayPage` 773 行、`QuickCreate` 829 行）：需要先有组件级视觉回归测试，否则改动风险高于收益。
5. **CI 里加一步** `rm -rf .codegraph && codegraph init . && python3 scripts/codegraph-analyze.py`，并在循环数 / 孤儿数不为 0 时失败。图表能长期可信的前提是它每次都被重新生成。
