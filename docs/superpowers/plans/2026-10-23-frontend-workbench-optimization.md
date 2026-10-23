# Cabinet Frontend Workbench Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Today and task detail clearly communicate what needs attention, what actually happened, what is supported by persisted evidence, and what the user can do next.

**Architecture:** Preserve the existing Cabinet shell, routes, dark visual tokens, API/DTO boundary, and command semantics. Improve the task-detail journey first, then extend Today’s read-only task set to include failures and present an action queue; use existing presentation helpers and only add small server-rendered components where they clarify page composition.

**Tech Stack:** Next.js 16 App Router, React 19 Server Components, TypeScript, Tailwind CSS 4, Zod DTOs, Vitest.

---

## Scope and prerequisites

Design source: [2026-10-23-frontend-workspace-design.md](../specs/2026-10-23-frontend-workspace-design.md).

The agreed direction is **Cabinet workbench first**, not chat-first. The first implementation covers:

1. Task detail hierarchy and state/action clarity (P0).
2. Today action queue and failed-task visibility (P1).
3. Shared consistency, narrow-screen and keyboard/accessibility polish (P2).

Do not implement a new Inbox, chat surface, meeting capture, live run progress, worker, new domain `blocked` state, or a full redesign of Cabinet/Memory/Council in this plan.

### Worktree safety gate

At plan creation, the repository has user changes in many UI files and separate untracked work. Before implementation:

- Inspect `git status --short` and the diff of every target file.
- Do not discard, overwrite, stage, or commit unrelated user changes.
- Select a clean base/worktree that contains the desired current UI changes, or have the owner preserve those changes before choosing the implementation base.
- If the intended current UI changes cannot be included safely, stop and ask which baseline to use. Do not guess.

## File map

| File | Responsibility |
|---|---|
| `src/app/tasks/[id]/page.tsx` | Server-rendered task detail composition; retain it as the page owner and reorganize existing information rather than rewriting its data flow. |
| `src/lib/presentation/task-view.tsx` | Pure task-state, attempt, evidence and next-action presentation rules; extend only where the page needs a shared, testable mapping. |
| `tests/unit/task-view.test.ts` | Unit coverage for task state, evidence relationship and next-action mappings. |
| `src/server/services/queries/today.ts` | User-scoped, read-only Today query; include failed tasks so the page can present them. |
| `src/server/readmodels/today.ts` | Maps query results into the existing `TodayPageDto`; change only if the current DTO cannot carry the required persisted data. |
| `src/contracts/dto/aggregates.ts` | Today aggregate schema; preserve the existing task DTO shape unless a strictly necessary field is missing. |
| `src/app/page.tsx` | Today page composition; place user-actionable items ahead of secondary metrics. |
| `src/lib/presentation/today-view.ts` | Pure action grouping, ordering and empty-state helpers. |
| `tests/unit/today-view.test.ts` | Unit coverage for action grouping, prioritization, and empty data. |
| `tests/integration/page-contracts.test.ts` | Runtime DTO contract coverage for Today and task pages. |
| `src/components/ui.tsx` | Existing shared primitives; extend only if a repeated primitive is missing. |
| `src/components/tasks/` and `src/components/today/` | Optional focused server-rendered display components, created only when extracting markup materially improves page composition. Do not create a generic design-system layer. |

The frontend must continue to use `@/contracts` and `@/lib/api`; pages and components must not import `@/server`, `@/lib/db`, or service code.

## Priority and dependency order

```text
Preflight / baseline
  → P0 Task status and detail composition
  → P1 Today failed-task read model and action queue
  → P2 cross-page consistency and accessibility
  → focused + repository-wide verification
```

P0 and P1 are separable, but execute P0 first because task detail is the destination for Today’s actions. P2 must not block delivery of the core task journey if no specific inconsistency is found.

## Task 0: Establish a safe implementation baseline

**Files:**
- No source modifications.
- Inspect target files listed above and the current worktree.

- [ ] **Step 1: Record worktree status**

Run:

```bash
git status --short
```

Expected: identify all pre-existing modified and untracked files. Do not stage or remove them.

- [ ] **Step 2: Confirm the implementation base**

Inspect the current diffs for `src/app/page.tsx`, `src/app/tasks/[id]/page.tsx`, `src/lib/presentation/task-view.tsx`, `src/lib/presentation/today-view.ts`, `src/components/ui.tsx`, and `tests/unit/*view.test.ts`.

Expected: the owner’s intended UI changes are either present in the chosen clean base or explicitly preserved for integration. If not clear, stop for owner direction.

- [ ] **Step 3: Run the focused baseline**

Run:

```bash
pnpm exec vitest run tests/unit/task-view.test.ts tests/unit/today-view.test.ts tests/unit/ui.test.ts tests/integration/page-contracts.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
```

Expected: record pass/failure before implementation. Existing failures must not be attributed to this plan without reproducing a changed test.

## Task 1 (P0): Make task state and next action explicit

**Files:**
- Modify: `src/lib/presentation/task-view.tsx`
- Modify: `tests/unit/task-view.test.ts`
- Reference: `src/contracts/dto/entities.ts` for the authoritative task status set.

- [ ] **Step 1: Add characterization tests for persisted states**

Add tests for the current actionable/non-actionable task statuses: `planned`, `assigned`, `awaiting_approval`, `approved`, `running`, `submitted`, `rejected`, `accepted`, `done`, `failed`, `suggested`, and `cancelled`.

Expected: tests establish each state’s human-readable summary and next-action category without inventing a `blocked` status.

- [ ] **Step 2: Run the focused tests**

Run:

```bash
pnpm exec vitest run tests/unit/task-view.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: any test for a newly requested presentation helper fails because the mapping does not exist yet.

- [ ] **Step 3: Implement the minimal presentation mapping**

Add a pure helper in `task-view.tsx` only if existing `getStatusBannerInfo` and current markup cannot provide a consistent summary. The result should be a typed status label, concise explanation, tone, and next-action category; actual action URLs and permission checks remain owned by existing UI/API patterns.

Expected: no database status is inferred from styling, and unknown strings remain visibly unknown rather than being treated as success.

- [ ] **Step 4: Verify the state mapping**

Run the focused task-view test command from Step 2.

Expected: all listed statuses have stable, explicit expectations.

## Task 2 (P0): Reorder task detail as one execution workflow

**Files:**
- Modify: `src/app/tasks/[id]/page.tsx`
- Modify: `src/lib/presentation/task-view.tsx` only if Task 1’s helper is needed by the page.
- Modify: `tests/unit/task-view.test.ts` and/or `tests/integration/page-contracts.test.ts` for changed derived behavior.
- Optional create: a focused component under `src/components/tasks/` only if it reduces page complexity and takes DTO-shaped props.

- [ ] **Step 1: Add tests for evidence-to-artifact relationships**

Cover artifacts that cite valid evidence, artifacts with no citations, and dangling citation IDs. Reuse `citedEvidenceIds` and existing evidence classification; do not build a second citation parser.

Expected: the test distinguishes cited, uncited, and unresolved evidence and does not treat evidence presence as proof that a claim is supported.

- [ ] **Step 2: Verify the new test fails for any missing presentation contract**

Run:

```bash
pnpm exec vitest run tests/unit/task-view.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: failures identify only the new behavior that still needs to be represented.

- [ ] **Step 3: Recompose the page in this order**

1. Task identity and goal.
2. Current status, latest attempt outcome, blocker/failure explanation, and state-appropriate action.
3. Execution/tool timeline using only persisted steps.
4. Deliverable(s) with an adjacent source-mode label.
5. Evidence panel with citation relationship and retrieval metadata.
6. Acceptance checklist, keeping failed, passed, and undetermined/manual items distinct.
7. Ownership, metadata, approvals, and audit history as supporting detail.

Keep existing handlers and server DTO data flow. Preserve approval, run, audit, submit and done behavior; this task changes presentation, not permissions or lifecycle semantics.

- [ ] **Step 4: Remove or correct unsupported UI claims encountered in the touched sections**

Review copy in the task details being reorganized. Replace claims such as guaranteed replayability or sandbox reproduction unless the current DTO and backend actually provide those capabilities. Keep wording bounded to persisted run steps, evidence and audit history.

- [ ] **Step 5: Verify task presentation and contract**

Run:

```bash
pnpm exec vitest run tests/unit/task-view.test.ts tests/integration/page-contracts.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
```

Expected: the task page still validates against its DTO and all state/evidence assertions pass.

## Task 3 (P1): Include failed tasks in Today’s read model

**Files:**
- Modify: `src/server/services/queries/today.ts`
- Test: `tests/integration/page-contracts.test.ts`
- Reference: `src/server/readmodels/today.ts`, `src/contracts/dto/aggregates.ts`

- [ ] **Step 1: Add an integration fixture for a failed task**

Create a failed task for the test user and a separate failed task for a second user through the established test database pattern. Assert the first appears in `loadToday(userId).tasks` and the second does not.

Expected: the inclusion assertion fails because `getTodayData()` currently filters out `failed`; the tenancy assertion passes and remains a regression guard.

- [ ] **Step 2: Run the focused integration test**

Run:

```bash
pnpm exec vitest run tests/integration/page-contracts.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: the new assertion fails while existing page DTO contracts remain unaffected.

- [ ] **Step 3: Add `failed` to the user-scoped Today query**

Extend the existing `inArray(tasks.status, ...)` in `getTodayData()` to include `failed`. Do not add a new domain status or load all historical failed tasks without a product rule; preserve the query’s existing ordering and scope.

- [ ] **Step 4: Verify Today’s DTO contract**

Run the focused integration test from Step 2.

Expected: a failed task is included and passes through the current task DTO schema; no DTO change is needed unless the test proves otherwise.

## Task 4 (P1): Build an action-first Today view model

**Files:**
- Modify: `src/lib/presentation/today-view.ts`
- Modify: `tests/unit/today-view.test.ts`
- Modify: `src/app/page.tsx`
- Optional create: `src/components/today/action-queue.tsx` if it receives typed DTO props and meaningfully simplifies page markup.

- [ ] **Step 1: Add unit tests for Today action grouping**

Cover pending approvals, tasks requiring attention (`awaiting_approval`, `rejected`, `failed` as applicable), active tasks, no tasks, and no pending actions. Assert stable grouping/order, that the UI grouping is not represented as a new task status, and that each action category maps to a route/mutation already supported by the application.

Expected: task-state items and approval items appear in the correct user-action group; empty data yields an explicit empty view model.

- [ ] **Step 2: Run the focused unit tests**

Run:

```bash
pnpm exec vitest run tests/unit/today-view.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: new action-queue behavior fails until implemented.

- [ ] **Step 3: Implement pure grouping and prioritization**

Extend `today-view.ts` with typed pure helpers using `TodayPageDto`-compatible data. Reuse current DTO fields. Do not duplicate API/server permission logic, infer unsaved state, or treat an open council meeting as a task.

- [ ] **Step 4: Reorder Today content**

In `src/app/page.tsx`, prioritize:

1. Items needing user intervention.
2. One next action or clear task-creation path.
3. Goal progress.
4. Weekly metrics and secondary Cabinet pulse.

Keep stable empty-state regions. Avoid a second copy of the same task in the action queue and secondary task lists unless the visual distinction is explicit.

- [ ] **Step 5: Verify Today helper and read-model contract**

Run:

```bash
pnpm exec vitest run tests/unit/today-view.test.ts tests/integration/page-contracts.test.ts --maxWorkers=1 --no-file-parallelism
pnpm typecheck
```

Expected: helper tests pass and Today’s runtime DTO validation accepts the read-model result.

## Task 5 (P2): Align state language, mobile layout and accessibility

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/tasks/[id]/page.tsx`
- Modify: `src/lib/presentation/today-view.ts`
- Modify: `src/lib/presentation/task-view.tsx`
- Modify: `src/components/ui.tsx` only if a missing shared primitive is demonstrated.
- Test: `tests/unit/ui.test.ts`, `tests/unit/task-view.test.ts`, `tests/unit/today-view.test.ts`

- [ ] **Step 1: Add assertions for meaningful labels and actionable empty states**

Test helpers for user-facing task states, provenance and empty action queues. Do not snapshot entire pages; assert the key state labels and action text.

- [ ] **Step 2: Verify narrow view and keyboard interaction in the browser**

Check desktop, tablet/narrow mobile widths for horizontal overflow, readable evidence URLs, visible primary action, focus visibility, and access to the existing mobile menu. Confirm headings and status regions remain in logical reading order.

Expected: no required action or status disappears below the fold without a reachable scroll path; no status relies on color alone.

- [ ] **Step 3: Make only targeted presentation corrections**

Use existing Tailwind tokens and shared UI primitives. Do not add a theme, design-system package, animation layer, or global navigation redesign.

- [ ] **Step 4: Run focused UI tests**

Run:

```bash
pnpm exec vitest run tests/unit/ui.test.ts tests/unit/task-view.test.ts tests/unit/today-view.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: all focused UI/presentation tests pass.

## Task 6: Final verification and handoff

**Files:**
- No additional source changes unless a verification failure exposes a defect introduced in this plan.

- [ ] **Step 1: Run all affected tests**

Run:

```bash
pnpm exec vitest run tests/unit/task-view.test.ts tests/unit/today-view.test.ts tests/unit/ui.test.ts tests/integration/page-contracts.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: all selected tests pass.

- [ ] **Step 2: Run typecheck and lint**

Run:

```bash
pnpm typecheck
pnpm exec eslint src/app/page.tsx 'src/app/tasks/[id]/page.tsx' src/lib/presentation/task-view.tsx src/lib/presentation/today-view.ts src/server/services/queries/today.ts src/server/readmodels/today.ts tests/unit/task-view.test.ts tests/unit/today-view.test.ts tests/integration/page-contracts.test.ts
```

Expected: typecheck and targeted lint pass with no new boundary violations.

- [ ] **Step 3: Run the production build**

Run:

```bash
pnpm build
```

Expected: Next.js production build succeeds.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git --no-pager diff --stat
```

Expected: changed files are limited to Today/task presentation, the Today read-only query, related tests and any narrowly justified component extraction. Pre-existing changes remain untouched.

## Release acceptance

- Today surfaces failures from the read model without inventing a `blocked` task status.
- Task detail gives a clear current state and state-appropriate next action.
- Tool steps, evidence, source provenance and acceptance outcomes are shown according to persisted DTO data.
- Valid citations, uncited evidence and dangling citations remain distinguishable; no UI claims citation existence proves claim correctness.
- No fake real-time run progress or unsupported backend capability is presented.
- Existing API write behavior, auth, permissions, idempotency, acceptance and route boundaries are unchanged.
- Desktop and narrow-screen layouts preserve readable hierarchy and keyboard access.
- Focused tests, typecheck, targeted lint and production build pass.
