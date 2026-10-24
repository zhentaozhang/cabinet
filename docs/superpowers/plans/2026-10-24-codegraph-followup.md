# Codegraph 后续整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 codegraph 探索暴露出来的五类问题（规则漏网、死代码、巨型模块、巨型函数、文档口径失真）逐条落到代码与测试上。

**Architecture:** 先补"测试能挡住的约束"（边界规则），再删死代码，再用脚本驱动的机械拆分降低 `schema.ts` 的耦合，最后把文档数字改成与仓库现状一致。每一步都由 `bash scripts/verify.sh`（migrate on fresh DB → typecheck → lint → vitest → build）作为唯一验收闸门，失败即回滚该步。

**Tech Stack:** Next.js 16.4.2 / React 19.3 / TypeScript 5 / Drizzle ORM 0.45 (postgres-js) / vitest 5 / pnpm 11。

---

## 基线（2026-10-24，执行前实测）

```
== db:migrate (fresh cabinet_verify_70502) ==
== typecheck ==
== lint ==
== test ==
 Test Files  97 passed (97)
      Tests  851 passed (851)
   Duration  66.28s (tests 80%, import 18%, transform 1%)
== build ==
verify: ok
EXIT=0
```

注：README 声称 "792 个测试通过"，实测 **851**，本身就是一处口径漂移。

## 文件结构（本计划涉及的模块职责）

| 文件 | 职责 |
|---|---|
| `tests/unit/boundary.test.ts` | 分层规则的唯一执法者；本次新增 lib 层规则 |
| `src/lib/auth/session.ts` | **删除**。`getSession`/`requireUser` 零引用，逻辑已在 `src/lib/auth/context.ts:11` 内联 |
| `scripts/codegraph-analyze.py` | 图分析器；修正把 `import type` 当运行时边的假环 |
| `src/lib/db/schema.ts` | 从 1,128 行单体降级为 barrel
| `src/lib/db/schema/{core,agents,goals,tasks,runs,memory,councils,governance,ops,types}.ts` | 按域承载 35 张表与共享类型 |
| `README.md` / `docs/frontend-backend-separation.md` / `docs/codegraph-analysis.md` | 数字改真值 |

### schema 拆分的分层依据（已用脚本验证 FK 图无环）

```
core      users, sessions, accounts, verifications, profiles            refs: users
agents    agents, agent_grants, agent_templates, skills                 refs: users
goals     goals, checkins                                               refs: users
tasks     tasks, approvals                                             refs: agents,goals,users
runs      runs, steps, artifacts                                        refs: agents,tasks
memory    memories, insights, reviews, apprentice_observations,
          apprentice_exam_snapshots                                     refs: agents,users,runs,tasks,artifacts,skills
councils  councils, council_positions, dissents                         refs: agents,councils,tasks,users
governance audit_events, policy_config, agent_budget_periods,
          agent_budget_reservations, evidence, retrieval_calls          refs: users,agents,tasks,runs,agent_budget_periods
ops       idempotency_keys, user_actions, rate_limits, outbox, run_jobs  refs: users,tasks
```

模块导入严格按上面书写顺序单向：后一个只能 import 前一个。FK 全部是 `references(() => x.id)` 的惰性箭头，加上单向加载顺序，运行期不存在 TDZ 风险。

---

## Task 1: 让边界规则覆盖 `src/lib`

**Files:**
- Modify: `tests/unit/boundary.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/boundary.test.ts` 的 "the backend never reaches into the UI" 之后插入：

```ts
/**
 * `src/lib` was the one layer the rule did not cover, and the one
 * violation lived exactly there: `src/lib/engine.ts` re-exports the
 * server implementation behind a @deprecated shim. Keep the exemption
 * explicit and dated so it cannot grow silently.
 */
const LIB_TO_SERVER_ALLOWED = new Set<string>(["src/lib/engine.ts"]);

test("the shared layer never imports the server", () => {
  const violations = walk(join(SRC, "lib")).flatMap((file) =>
    importsOf(file)
      .filter((spec) => SERVER_ONLY.some((pattern) => pattern.test(spec)))
      .filter((spec) => !LIB_TO_SERVER_ALLOWED.has(rel(file)))
      .map((spec) => `${rel(file)} → ${spec}`),
  );

  expect(violations).toEqual([]);
});
```

- [ ] **Step 2: 先跑一次，确认白名单是必要的**

把 `LIB_TO_SERVER_ALLOWED` 临时改成 `new Set()`，运行：

```bash
./node_modules/.bin/vitest run tests/unit/boundary.test.ts
```

Expected: FAIL，且失败信息恰好是 `src/lib/engine.ts → @/server/services/engine`。
这证明规则真的能抓到那条已知边，而不是一条永远为真的空断言。

- [ ] **Step 3: 恢复白名单，确认通过**

```bash
./node_modules/.bin/vitest run tests/unit/boundary.test.ts
```

Expected: PASS（5 tests）。

- [ ] **Step 4: 在 engine.ts 上写明豁免理由**

`src/lib/engine.ts` 已有的 `@deprecated` 注释后补一行，说明它被 `tests/unit/boundary.test.ts` 的 `LIB_TO_SERVER_ALLOWED` 显式列入白名单。

- [ ] **Step 5: Commit**

```bash
git add tests/unit/boundary.test.ts src/lib/engine.ts
git commit -m "test(boundary): cover src/lib and pin the engine shim as the only exemption"
```

---

## Task 2: 删除零引用模块 `src/lib/auth/session.ts`

**Files:**
- Delete: `src/lib/auth/session.ts`

- [ ] **Step 1: 再确认一次它是死的**

```bash
grep -rn "auth/session\|getSession\b\|requireUser\b" src tests scripts | grep -v "^src/lib/auth/session.ts"
```

Expected: 只有 `src/proxy.ts`（用的是 better-auth 的 `getSessionCookie`，不是这个）与 `src/lib/auth/context.ts:11`（内联实现）。无 import。

- [ ] **Step 2: 删除并验证**

```bash
git rm src/lib/auth/session.ts
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint && ./node_modules/.bin/vitest run tests/unit
```

Expected: 全部 exit 0。

- [ ] **Step 3: 在 docs/codegraph-analysis.md 里勾掉这条待办**（与 Task 8 合并提交）

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(auth): drop the orphaned session helpers"
```

---

## Task 3: 图分析器不再把 `import type` 算成运行时依赖

**Files:**
- Modify: `scripts/codegraph-analyze.py`

- [ ] **Step 1: 复现假环**

```bash
python3 scripts/codegraph-analyze.py | grep -A3 "Import cycles"
```

Expected: 报 1 个环，`policy.ts ↔ standing-grants.ts`。

- [ ] **Step 2: 改解析逻辑**

在建边处跳过 type-only 导入（`import type {...}` 以及 `{ type X }` 这种 inline 形式），因为 TypeScript 编译期擦除它们，运行期不存在这条边。

- [ ] **Step 3: 验证环归零**

```bash
python3 scripts/codegraph-analyze.py | grep -A3 "Import cycles"
```

Expected: `Import cycles (SCC > 1): 0`。

- [ ] **Step 4: Commit**

```bash
git add scripts/codegraph-analyze.py
git commit -m "fix(analyze): type-only imports are erased, so they are not edges"
```

---

## Task 4: 把 `src/lib/db/schema.ts` 拆成十个域文件

**Files:**
- Modify: `src/lib/db/schema.ts`（1,128 行 → barrel）
- Create: `src/lib/db/schema/{types,core,agents,goals,tasks,runs,memory,councils,governance,ops}.ts`

**约束：** 不改任何一张表的定义、不改任何导出的名字。110 个 import `@/lib/db/schema` 的模块一行都不用动。

- [ ] **Step 1: 用脚本机械切分（不要手抄 1,128 行）**

脚本按 `^export const (\w+) = pgTable\(` 切块，按上面的域表把块分到目标文件；每个目标文件的 import 由该文件实际用到的符号决定（`drizzle-orm/pg-core` 的构造器、`sql`、跨域表引用、`./types` 里的类型）。

- [ ] **Step 2: `schema.ts` 变成 barrel**

```ts
// Domain modules, ordered so that every `references(() => x.id)` points
// at a table from an earlier file. Nothing here may import `./schema`
// back: the barrel is a leaf.
export * from "./schema/types";
export * from "./schema/core";
export * from "./schema/agents";
...
```

- [ ] **Step 3: 类型检查**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: exit 0。任何缺失的 import 都会在这里暴露。

- [ ] **Step 4: 数据库仍然能从零建起**

```bash
psql postgres://localhost:5432/postgres -qc 'create database cabinet_split_check'
DATABASE_URL=postgres://localhost:5432/cabinet_split_check ./node_modules/.bin/drizzle-kit migrate
DATABASE_URL=postgres://localhost:5432/cabinet_split_check ./node_modules/.bin/drizzle-kit push --strict=false
psql postgres://localhost:5432/postgres -qc 'drop database cabinet_split_check'
```

Expected: migrate 无破坏性变更提示（`drizzle-kit push` 若报 "No changes detected" 则说明 schema 与迁移链完全一致）。

- [ ] **Step 5: 全量测试**

```bash
./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
```

Expected: 97 files / 851 tests 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts src/lib/db/schema
git commit -m "refactor(db): split the 1128-line schema into domain modules"
```

---

## Task 5: `runTask` 相位化（827 行单函数）

**Files:**
- Modify: `src/server/services/commands/tasks/run.ts:52-878`

- [ ] **Step 1: 读全文，标出相位边界**（suggest 分支 / 审批分支 / 排队 worker / 同步执行 / 收尾落账）
- [ ] **Step 2: 每个相位抽成同文件内的 `async function phaseXxx(...)`，不跨文件**
- [ ] **Step 3: 行为不变由现有 5 个测试文件守住**（`run-task` / `task-lifecycle` / `agent-budget` / `evidence` / `provider-attempt`）
- [ ] **Step 4: `tsc --noEmit` + 全量 vitest**
- [ ] **Step 5: Commit**

---

## Task 6: 文档口径改真值

**Files:**
- Modify: `README.md`（33 张表 → 35，补 `retrieval_calls` / `run_jobs`；34 个 route → 44；792 → 851 测试）
- Modify: `docs/frontend-backend-separation.md`（route 计数）
- Modify: `docs/codegraph-analysis.md`（按 Task 8 的数据重写）

- [ ] **Step 1: 用命令现取真值，不凭记忆**
- [ ] **Step 2: 逐处替换**
- [ ] **Step 3: `grep` 复核没有残留的旧数字**
- [ ] **Step 4: Commit**

---

## Task 7: 全量验证

- [ ] `bash scripts/verify.sh` → `verify: ok`，测试数 ≥ 851（Task 1 新增 1 个）
- [ ] `python3 scripts/codegraph-analyze.py` → 环 0、孤儿 0
- [ ] `codegraph init .` 重新索引，节点数应与新文件数一致

---

## 不做的事（以及为什么）

- **不拆 `seedDemo`（1,611 行）**：它是 demo 数据字面量，拆开只是把同一堆数据分装，没有降低理解成本；真正的改进是让 CI 用 SQL fixture，那是另一个议题。
- **不拆 `TaskPage` / `TodayPage` / `QuickCreate`**：它们是大 JSX 单返块，改动风险高于收益，且需要先有组件级视觉回归测试才安全。
- **不删 `src/lib/engine.ts`**：它仍被 18 个模块 import，删除需要一次跨模块迁移，超出本次范围；本次只把它钉死为唯一豁免。
