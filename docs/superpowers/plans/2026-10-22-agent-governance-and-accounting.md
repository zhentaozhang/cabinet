# Agent Governance and Accounting Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent budget enforcement, autonomy promotion, and apprenticeship decisions depend on consistent, attributable, concurrency-safe evidence.

**Architecture:** Keep task policy decisions in pure domain functions and persistence in the existing Drizzle service layer. Define model usage and budget-period semantics once — in a persisted period ledger — separate simulated/rule activity from real provider usage, then make autonomy and apprentice gates consume explicitly qualified evidence. `runs.cost_cents` becomes telemetry; the ledger is the only authority for "how much of this week's budget is used".

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM, PostgreSQL, Zod, Vitest.

---

## Revision notes (rev 2, 2026-10-22)

Rev 1 was reviewed line by line against the current source. The following were wrong, unbuildable, or silently breaking. Each note names the verified reason, so future readers do not re-litigate it.

1. **The stated prerequisite did not exist.** Rev 1 said budget eligibility is "identified by the execution mode/provider-attempt fields owned by the data-trust plan". The repo has only `runs.mode` (`demo|rule|live`) and the `source_type` columns added by `drizzle/0016_early_expediter.sql`. There is no `provider`, `model`, attempt reference, or `cost_source`, and `runs.tokens_in/tokens_out/cost_cents` are `NOT NULL DEFAULT 0`, so "unknown usage" is currently unrepresentable. Fix: new **Task 0** pulls the minimum provider-attempt fields forward and explicitly lists what stays in the data-trust plan.
2. **Terminology collision.** `runs.mode` is an *execution channel*, not a provider attempt. Rev 1 used "execution mode" for both. Fix: a terminology table; `runs.mode` is never used to identify a provider attempt.
3. **`autonomy.minAuditSamples` would break every existing workspace.** `getPolicyConfig()` fails closed on a missing or invalid `policy_config` key, and `setupWorkspace` only inserts *missing top-level keys*, so a new nested key never reaches an existing database. Fix: a data-only migration using the same jsonb-merge pattern as `drizzle/0012_cost_caps.sql`, plus nested-default backfill in `src/lib/setup.ts`, plus the DTO change.
4. **Two accounting sources.** `loadSpentCents()` is the shared read seam for `run.ts`, `reflection.ts`, and `council/context.ts` (which feeds `council/positions.ts`). Rev 1 only changed the run path, leaving reflection and council reading `runs.cost_cents`. Fix: the ledger replaces that helper's data source, all consumers are listed, and `runs.cost_cents` is demoted by invariant.
5. **Contract files missing.** Rev 1 asked the UI to display reserved/settled/unresolved, but never touched `agentPageSchema`, `runDtoSchema`, `policyConfigDtoSchema`, `src/server/mappers.ts`, `queries/agent.ts`, or `readmodels/agent.ts`. Fix: complete file map, `budgetViewDto` definition.
6. **UI/backend contradiction.** The Review page "可升级" badge recomputes eligibility from `queries/review.ts` `auditStats` (unfiltered by provenance) while rev 1 gave `queries/review.ts` no role. Fix: Task 3 owns that query and the badge; the badge renders the backend decision object, never its own arithmetic.
7. **`practice_passed` breaks the state machine and existing tests.** `TRANSITIONS.apprentice` has no such stage, and `tests/integration/apprentice-autonomy-audit.test.ts` asserts `lifecycleStage === "active"`, `skill.label === "production"`, `autonomyLevel === 2`, and `{passed: 5, required: 5, promoted: true}`. Fix: explicit transition table and an enumerated list of assertion changes, so an implementer cannot "fix" the tests by quietly keeping the promotion.
8. **Migration/concurrency tests had no harness.** `tests/global-setup.ts` migrates to head only; `tests/helpers/db.ts` only resets. Nothing in `src/` uses `FOR UPDATE`. Fix: `tests/helpers/migrations.ts` contract and an explicit reservation-locking protocol.
9. **Budget basis was undefined.** `agents.budgetCents` (templates: 0/200/800/1200), `config.budget.weeklyLimitCents` (60000), and `agents.spentCents` (monotonic, never reset, yet compared against `budgetCents` in `run.ts`) coexisted with no ruling. Fix: explicit precedence rule and a freeze plan for legacy columns.
10. **A live money-losing branch was not called out.** `run.ts` currently throws `PolicyDenied` *after* a successful provider call when estimated cost exceeds `maxRunCents`; the artifact is discarded and the run is marked failed. Fix: Task 1 names it as an acceptance item to delete.

## Scope and prerequisites

This plan follows the Agent architecture review against the current README and source code. It covers:

1. Consistent Agent budget periods and honest model-use accounting.
2. Autonomy promotion based on adequate, qualified evidence, with race-safe writes.
3. Apprentice exams gated by explicit mentor/apprentice training evidence.
4. Documentation and tests that state what the resulting scores and budgets mean.

It does not add external connectors, independent Agent processes, model-based council positions, or production skill certification.

### Dependencies

| Kind | Dependency | Status |
|---|---|---|
| Hard | Provenance columns `artifacts/memories/runs.source_type` (data-trust Task 2, `drizzle/0016_early_expediter.sql`) | Landed |
| Hard | Provider-attempt fields and nullable usage — provided by **Task 0** of this plan | Not started; Tasks 1–2 steps that touch provider identity are **BLOCKED** until it lands |
| Soft | Everything else in [data trust plan](./2026-10-22-data-trust-and-real-data.md) (source refs, richer cost provenance) | Later; this plan must not duplicate it |

Task 0 moves only the five fields that cannot be substituted. Anything a later data-trust task adds (e.g. full external source references) must extend, not fork, these columns.

### Migration tag allocation

`drizzle/meta/_journal.json` currently ends at `0016_early_expediter`. Tags are reserved per task so parallel branches cannot collide:

| Tag | Owner | Contents |
|---|---|---|
| `0017_provider_attempt` | Task 0 | `runs.provider/model/provider_attempt_id/cost_source`, usage nullable |
| `0018_agent_budget` | Task 1 | `agent_budget_periods`, `agent_budget_reservations` |
| `0019_autonomy_min_samples` | Task 3 | Data-only jsonb merge into `policy_config.autonomy` |
| `0020_apprentice_observations` | Task 4 | `apprentice_observations`, `apprentice_exam_snapshots` |

Data-only migrations follow `drizzle/0012_cost_caps.sql`: hand-written SQL with no `meta/0012_snapshot.json`. Schema migrations use `pnpm exec drizzle-kit generate --name=<tag suffix>` and must commit the generated snapshot. Task 1 and Task 4 migrations stay separate even when implemented in one branch.

Implement in a clean worktree based on the chosen reviewed commit. Do not run migrations or destructive seed commands against production/shared databases. Test databases are created per run by `tests/global-setup.ts`.

## Non-negotiable invariants

These are the rules a future change must not violate. They exist because rev 1's ambiguities produced exactly these regressions.

- **MUST** keep one accounting read seam: period ledger rows. Every budget question (run admission, reflection budget-pressure claims, council budget context, metrics) reads the same ledger.
- **MUST NOT** let `runs.cost_cents` influence any budget decision. It is telemetry only.
- **MUST NOT** write `agents.spent_cents` or `agents.budget_period_start` any more. They are frozen legacy columns (see Task 1 Step 6).
- **MUST NOT** count fixed step/audit placeholder tokens as provider usage. Placeholder trace values must be `null` in usage columns, not `0`.
- **MUST NOT** auto-release a stuck reservation, and **MUST NOT** send a provider request whose reservation is not committed.
- **MUST NOT** let a page or query recompute promotion eligibility. UI renders the decision object returned by the domain function.
- **MUST NOT** promote on simulated evidence (`demo_fixture`, `rule_generated`, `legacy_unknown`) or on user-submitted artifacts.

## Terminology

| Term | Meaning | Field |
|---|---|---|
| Execution channel | How a run was produced: demo template, rule engine, or live provider | `runs.mode` (`demo`/`rule`/`live`) |
| Provider attempt | One actual call to a configured model provider, unique per retry | `runs.provider_attempt_id` (+ `provider`, `model`) |
| Artifact provenance | What produced the artifact content | `artifacts.source_type`, `artifacts.submitted_by` |
| Usage quality | Whether token counts are observed, estimated, or missing | `runs.cost_source` (`actual`/`estimated`/`unknown`), nullable `tokens_*` |
| Period ledger | Per-Agent, per-local-week budget bucket | `agent_budget_periods` |
| Reservation | A pre-call hold against a period bucket | `agent_budget_reservations` |

## File map

| Area | Files |
|---|---|
| Provider attempt | `src/lib/db/schema.ts`, `drizzle/0017_provider_attempt.sql`, `src/lib/llm.ts`, `src/server/services/commands/tasks/run.ts` |
| Budget ledger | `src/lib/db/schema.ts`, `src/lib/domain/agent-budget.ts`, `drizzle/0018_agent_budget.sql`, `drizzle/meta/*` |
| Budget consumers | `src/server/services/commands/tasks/run.ts`, `src/server/services/commands/tasks/execution.ts`, `src/server/services/commands/reflection.ts`, `src/server/services/commands/council/context.ts`, `src/server/services/commands/council/positions.ts`, `src/server/services/queries/metrics.ts` |
| Budget read model | `src/contracts/dto/aggregates.ts`, `src/contracts/dto/entities.ts`, `src/server/mappers.ts`, `src/server/services/queries/agent.ts`, `src/server/readmodels/agent.ts` |
| Telemetry alignment | `src/lib/llm.ts`, `src/server/services/commands/tasks/run.ts`, `src/server/services/commands/tasks/audit.ts` |
| Autonomy evidence | `src/lib/domain/provenance.ts`, `src/lib/domain/policy.ts`, `src/lib/policy/config.ts`, `src/server/services/commands/agents.ts`, `src/server/services/commands/tasks/audit.ts`, `src/server/services/queries/review.ts`, `src/app/review/page.tsx`, `src/lib/setup.ts`, `src/lib/db/seed.ts`, `drizzle/0019_autonomy_min_samples.sql` |
| Apprentice evidence | `src/lib/db/schema.ts`, `src/lib/domain/state.ts`, `src/contracts/templates.ts`, `src/contracts/labels.ts`, `src/contracts/routes.ts`, `src/contracts/dto/entities.ts`, `src/server/mappers.ts`, `src/server/services/commands/apprentice.ts`, `src/server/services/queries/agent.ts`, `src/app/api/apprentice/observations/route.ts`, `src/components/actions/agent-actions.tsx`, `src/app/cabinet/[id]/page.tsx`, `drizzle/0020_apprentice_observations.sql` |
| User-facing explanation | `src/app/cabinet/page.tsx`, `src/app/cabinet/[id]/page.tsx`, `src/app/review/page.tsx`, `README.md`, `docs/superpowers/specs/` (ADR) |
| Test harness | `tests/helpers/migrations.ts` (new), `tests/helpers/db.ts`, `tests/global-setup.ts` |

Do not split the existing command services only to make this work. Extract a narrowly scoped helper only if it is needed to test budget-period arithmetic or evidence eligibility independently.

## Task 0: Provider attempt identity and usage provenance

**Why:** every later task needs to distinguish "a real call happened, usage known", "a real call happened, usage unknown", and "no provider involved". Today that distinction cannot be persisted.

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0017_provider_attempt.sql` + `drizzle/meta/0017_snapshot.json`
- Modify: `src/lib/llm.ts`
- Modify: `src/server/services/commands/tasks/run.ts`
- Create: `tests/integration/provider-attempt.test.ts`

- [ ] **Step 1: Write failing tests for attempt identity**

Assert, against persisted rows:

- A successful live call persists `provider`, `model`, a non-null `provider_attempt_id`, observed `tokens_in/tokens_out`, and `cost_source = 'actual'`.
- A timeout / provider error / empty response persists a non-null `provider_attempt_id` and `cost_source = 'unknown'`, with `tokens_*` null (not `0`).
- A demo or rule run persists `provider_attempt_id` null and `cost_source = 'unknown'` (or a distinct `simulated` value if Task 2 of the data-trust plan defines one) — never `actual`.
- Two retries of the same task produce two distinct `provider_attempt_id` values.
- No run row ever stores `tokens_in = 0` merely because usage was unavailable.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run tests/integration/provider-attempt.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL — the columns do not exist.

- [ ] **Step 3: Add the columns**

```ts
// src/lib/db/schema.ts — runs table additions
provider: text("provider"),                       // e.g. "openai"
model: text("model"),                             // e.g. "gpt-4.1-mini"
providerAttemptId: text("provider_attempt_id"),   // unique per real call
costSource: text("cost_source"),                  // actual | estimated | unknown; null = no provider attempt
tokensIn: integer("tokens_in"),                   // null = unknown (was NOT NULL DEFAULT 0)
tokensOut: integer("tokens_out"),                 // null = unknown (was NOT NULL DEFAULT 0)
```

Add `index("runs_provider_attempt_idx").on(t.providerAttemptId)` and a `check("runs_cost_source_check", sql`${t.costSource} IS NULL OR ${t.costSource} IN ('actual','estimated','unknown')`)`.

Generate the migration with `pnpm exec drizzle-kit generate --name=provider_attempt`, review the SQL, and confirm it only contains `ALTER TABLE ... ADD COLUMN` plus the nullable relaxation of the two token columns. Keep `cost_cents` `NOT NULL DEFAULT 0` in this task — the ledger, not this column, becomes authoritative in Task 1.

- [ ] **Step 4: Thread attempt identity through the model boundary**

In `src/lib/llm.ts`, create the attempt id once per call (before the request, so failures keep it) and return it on every branch:

```ts
type ModelExecutionResult =
  | { status: "success"; attemptId: string; provider: string; model: string;
      draft: { title: string; content: string; tokensIn: number; tokensOut: number; costSource: "actual" } }
  | { status: "not_configured"; attemptId: null }
  | { status: "timeout" | "provider_error" | "empty_response"; attemptId: string;
      provider: string; model: string; error?: string; costSource: "unknown" };
```

Keep error text sanitized exactly as today (only `error.name` reaches the persisted run).

- [ ] **Step 5: Persist attempt identity in the run path**

In `src/server/services/commands/tasks/run.ts`, set `provider`, `model`, `providerAttemptId`, `costSource` on the run from the model result, and stop writing `tokensIn: 120/240` style placeholders (the placeholder removal itself is Task 2 Step 4; here only write the real attempt fields). `not_configured` leaves all attempt fields null.

- [ ] **Step 6: Run the focused test**

Run: `pnpm exec vitest run tests/integration/provider-attempt.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: pass, including the "unknown usage is null, not zero" assertion.

## Task 1: Persistent weekly budget ledger with pre-call reservations

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `src/lib/domain/agent-budget.ts`
- Create: `drizzle/0018_agent_budget.sql` + `drizzle/meta/0018_snapshot.json`
- Modify: `src/server/services/commands/tasks/run.ts`
- Modify: `src/server/services/commands/tasks/execution.ts`
- Modify: `src/server/services/commands/reflection.ts`
- Modify: `src/server/services/commands/council/context.ts`
- Modify: `src/server/services/commands/council/positions.ts`
- Modify: `src/server/services/queries/metrics.ts`
- Create: `tests/helpers/migrations.ts`
- Create: `tests/unit/agent-budget.test.ts`
- Create: `tests/integration/agent-budget.test.ts`
- Create: `tests/integration/agent-governance-migration.test.ts`

- [ ] **Step 1: Write unit tests for the accounting contract**

Add tests around one shared budget predicate: a provider attempt with known usage contributes measured tokens and estimated cost; a failed provider attempt with known usage still contributes; an attempted request with unknown usage contributes conservative unknown exposure; demo, rule-generated, deterministic audit, user-submitted, and legacy-unknown activity creates no reservation. Budget eligibility is determined by the reservation/attempt record (`runs.provider_attempt_id IS NOT NULL` plus the reservation row), never inferred from artifact source fields.

Reuse `src/lib/domain/provenance.ts` types (`SOURCE_TYPES`, `isSimulatedSource`). Do not invent competing string unions.

Also cover, as pure-function tests: settlement (known → settle to estimate, release remainder), unknown (unknown → charge full reserved as unknown, never as measured), release (no provider contact → zero settled, `released` state retained), overrun (estimated > reserved → full estimate recorded, `overrun` flagged, period blocked), and DST week boundaries via the existing `startOfLocalWeek` from `src/lib/domain/time.ts` (do not reimplement week math).

- [ ] **Step 2: Run the new unit test and verify it fails**

Run: `pnpm exec vitest run tests/unit/agent-budget.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because the budget module does not exist.

- [ ] **Step 3: Specify the budget contract in code-level terms**

Use these semantics consistently in code, API, and documentation:

- An Agent budget is a per-Agent **weekly** cap, not a lifetime cap. The effective period limit is `min(agents.budget_cents snapshot at period creation, config.budget.weeklyLimitCents)` when `agents.budget_cents > 0`, else `config.budget.weeklyLimitCents`. Document this rule inline: the per-Agent value is the tighter guard, the policy value is the global ceiling.
- The week starts at the beginning of the user's local week, using the existing `startOfLocalWeek` helper and workspace timezone.
- If a legacy workspace has no confirmed timezone, calculate a clearly labeled UTC fallback without persisting UTC as a user-confirmed personal fact. Store the timezone ID and exact start/end timestamps on each period bucket. A timezone change applies only to the next period: close the current bucket at its already-recorded end, start a transition bucket at that boundary using the newly selected timezone for its next end boundary, then use normal weeks in that timezone. Do not reinterpret or merge already-created period buckets (`period_end` is written once and never recomputed).
- Only provider-backed model execution usage is eligible. Deterministic audit, rule, demo, and legacy-unknown records do not count as provider spend.
- A provider attempt is `runs.provider_attempt_id` (from Task 0). `runs.mode` describes the execution channel and must not be used as an attempt identity.
- Token counts reported by the provider are measured usage; cost calculated from configured token pricing is an estimate, not a provider invoice.
- Missing usage/cost is unknown, not measured zero. A run that may have reached the provider must not disappear from the usage trail merely because it failed.
- Historical usage that cannot be classified remains visible as legacy unknown. Do not backfill it as measured provider usage or silently convert it to zero; the first post-migration budget view reports `legacyUnclassified: true` when no period rows exist for a week that contains pre-migration runs.

- [ ] **Step 4: Add the period ledger and reservation protocol**

Create `agent_budget_periods` and `agent_budget_reservations` exactly as specified in Appendix A. Then implement `src/lib/domain/agent-budget.ts` as pure decision helpers (`planReservation`, `planSettlement`, `remainingCents`, `isPeriodBlocked`) and keep transaction/locking in the service layer.

Admission protocol per run (service layer):

```text
BEGIN
  INSERT INTO agent_budget_periods (agent_id, period_start, ...) VALUES (...)
    ON CONFLICT (agent_id, period_start) DO NOTHING;
  SELECT ... FROM agent_budget_periods
    WHERE agent_id = $1 AND period_start = $2
    FOR UPDATE;                                  -- first FOR UPDATE in this repo
  -- reject when: closed, overrun, or limit - (reserved+settled+unknown) < maxRunCents
  INSERT INTO agent_budget_reservations (run_id/task_id, state='reserved', amount_cents=maxRunCents)
COMMIT                                            -- reservation is durable BEFORE the provider call
```

Rules:

- Reserve the configured `maxRunCents` before every attempt, because whether a request will be sent is only known after it returns. If the remaining allowance is less than this amount, reject the run before the provider request. This is intentionally conservative: small remaining balances may be unusable for a request.
- A hold whose attempt never contacted a provider (no key configured, so the template/demo fallback ran) settles as `released` with zero settled and zero unknown usage. This keeps the trail honest — "attempted, no provider contact" — without charging a simulated run. Durable reservations therefore exist for every attempt, and only released/released-capable rows exist for simulated channels.
- On known provider tokens, settle to the configured price estimate, then release the unused remainder.
- If the provider was not contacted, release the reservation.
- If a request may have reached the provider but usage is unavailable, settle as unknown exposure for the full reserved amount. Never report it as a measured charge.
- If the estimate exceeds the reservation, record the full estimate plus an explicit overrun, and reject later reservations for that period. State in the UI that this is an estimated-usage guard, not a provider invoice guarantee.
- A new week uses a new bucket without erasing history. Bucket update + reservation state + run usage update belong in one transaction where possible.
- A stuck reservation stays `reserved` and visible forever; never auto-release. A reconciliation path, when added, must record who/what resolved it and why (out of scope here; only the non-deletion guarantee is in scope).

- [ ] **Step 5: Route every budget read through the ledger**

- Replace `loadSpentCents(agentId, periodStart)` in `src/server/services/commands/tasks/execution.ts` with `loadWeeklyUsage(agentId, timezone, now)` returning `{ limitCents, reservedCents, settledCents, unknownCents, overrun, legacyUnclassified }`, reading the current period row and creating (without charging) it on read when missing.
- Update `run.ts` to pass `limitCents` and `usedCents = reserved + settled + unknown` into `decideRun`, and delete the post-call overrun branch that currently throws `PolicyDenied` after a paid provider call (acceptance item: a successful generation is never discarded for cost reasons; overruns are recorded and block future reservations instead).
- Update `reflection.ts` (~213–240) and `council/context.ts` (~89–108, feeding `council/positions.ts` ~83–99) to call `loadWeeklyUsage` per agent and sum `settled + unknown` for the ratio; reserved amounts are reported separately, not silently merged.
- Update `metrics.ts` (line ~76 cost sum, line ~213 `costUsd`) to read the ledger; label the value as estimated weekly model spend.

- [ ] **Step 6: Freeze legacy budget columns**

Stop writing `agents.spent_cents` and `agents.budget_period_start` (delete the conditional increment in `run.ts` and the `budgetPeriodStart` write in `setupWorkspace`). Keep the columns and their seeds; do not drop them in this plan. Add a code comment marking them legacy, and change `src/lib/format`/page labels so they are not presented as current-week values. Seeded demo values (`spentCents: 210/340/12`, runs with `costCents: 2.1/3.4/1.8`) are simulated fixtures and must not be migrated into period rows as measured usage.

- [ ] **Step 7: Provide the migration-test harness**

Create `tests/helpers/migrations.ts`:

```ts
export async function applyMigrationsUpTo(client: Sql, tag: string): Promise<void>
// reads drizzle/meta/_journal.json, applies .sql files up to and including `tag`
// via client.unsafe(fileContents), splitting on '--> statement-breakpoint'
export async function createScratchDatabase(): Promise<{ url: string; drop: () => Promise<void> }>
```

`applyMigrationsUpTo` must be used by both `tests/integration/agent-governance-migration.test.ts` and Task 4's migration test. Do not modify `tests/global-setup.ts` behaviour for the shared test database.

- [ ] **Step 8: Add integration tests for periods, provenance, and concurrency**

Create tests that cover:

- A live model run is counted once in the correct user's local week.
- A run from the prior week is retained historically but is not in the current-week total.
- Changing timezone midweek does not reset the current period; the next period stores the new timezone and following periods use its local-week boundaries.
- A demo/rule/audit run does not increase provider usage.
- Unknown legacy usage is not converted to zero actual usage or misclassified as model usage.
- No provider request is sent before the reservation commits (inject a fake model call and assert the reservation row exists at call time).
- Two concurrent reservations at the remaining boundary cannot both reserve: run two `db.transaction` calls under `Promise.all`, set `SET LOCAL statement_timeout` to a short value for the loser, and assert exactly one succeeds with an explicit rejection (not a test timeout).
- A failed provider call with returned usage remains visible in usage records.
- A provider call with unknown usage retains its full reservation as unknown exposure; a failure before provider contact releases its reservation.
- A released reservation has zero settled/unknown usage and remains auditable as `released`, not deleted.
- An overrun is persisted, visible, and blocks subsequent reservations for the same period.
- Applying `0018_agent_budget` to a populated `0017` database preserves all Agents and runs, creates no period rows that invent measured usage, and leaves `agents.spent_cents` untouched.

- [ ] **Step 9: Run the focused budget tests**

Run: `pnpm exec vitest run tests/unit/agent-budget.test.ts tests/integration/agent-budget.test.ts tests/integration/agent-governance-migration.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: all new tests pass; period rollover, reservation settlement, and concurrent reservation are asserted against persisted rows, not only mocks.

## Task 2: Align model execution telemetry and expose budget scope

**Files:**
- Modify: `src/lib/llm.ts`
- Modify: `src/server/services/commands/tasks/run.ts`
- Modify: `src/server/services/commands/tasks/audit.ts`
- Modify: `src/contracts/dto/entities.ts`
- Modify: `src/contracts/dto/aggregates.ts`
- Modify: `src/server/mappers.ts`
- Modify: `src/server/services/queries/agent.ts`
- Modify: `src/server/readmodels/agent.ts`
- Modify: `src/app/cabinet/page.tsx`
- Modify: `src/app/cabinet/[id]/page.tsx`
- Modify: `src/app/review/page.tsx`
- Create: `tests/integration/model-usage-accounting.test.ts`

- [ ] **Step 1: Write failing tests for measured versus simulated usage**

Assert that successful provider usage is persisted with the correct provider/model and measured token counts; deterministic context/plan/audit placeholders do not inflate provider token totals or Agent provider budget. Assert that a demo artifact can still complete its demo workflow but is not represented as provider usage. Also prove a request is not sent until its maximum-run reservation commits, known usage settles the reservation, and unknown usage retains the conservative reserve. Assert the budget view DTO exposes reserved/settled/unknown separately and sets `legacyUnclassified` for a week containing pre-ledger runs.

- [ ] **Step 2: Run the focused test and confirm the current mismatch**

Run: `pnpm exec vitest run tests/integration/model-usage-accounting.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because fixed step/audit counters currently contribute to `runs.tokensIn`, `runs.tokensOut`, or `costCents`.

- [ ] **Step 3: Preserve real provider results in the typed model result**

In `src/lib/llm.ts`, keep provider-returned usage, elapsed time, provider, model, and attempt id separate from deterministic step estimates. Non-success results preserve any usage returned by the SDK; otherwise persist usage as unknown. Keep provider error text sanitized as it is today.

- [ ] **Step 4: Stop presenting placeholder activity as model usage**

In `run.ts` and `audit.ts`, separate trace/display data from provider usage:

- The fixed values currently written (`context` 220, `plan` 380/180, `submit` 40/20 in `run.ts`; `tokensIn: 160, tokensOut: 80, costCents: 0.4` on the auditor run in `audit.ts`) must become `tokens_* = null`, `cost_source = 'unknown'`, and no run-level cost. If the UI needs an illustrative trace, carry it in the step payload/metadata, explicitly labelled illustrative.
- Only provider-returned token counts feed measured usage.
- Pricing-derived cost is stored as estimated on the ledger settlement, never as `runs.cost_cents` truth.
- Rule and demo records cannot increment a real model budget; their reservations do not exist.
- Reserve `maxRunCents` through the Task 1 ledger before contacting the provider; settle/release per Task 1 rules.

- [ ] **Step 5: Make provider failure usage durable**

Persist run outcome, provenance, safe failure category, attempt identity, and any known usage even when generation fails or returns an empty response. Keep failed tasks failed/retryable per the existing state machine. Retries create distinct attempts and never overwrite previous attempt usage. If the process exits before settlement, leave the reservation unresolved and expose it as such.

- [ ] **Step 6: Add the budget view to contracts and read models**

In `src/contracts/dto/entities.ts`:

```ts
export const budgetViewDtoSchema = z.object({
  timezone: z.string(),
  periodStart: isoDateTime,
  periodEnd: isoDateTime,
  limitCents: z.number(),
  reservedCents: z.number(),
  settledCents: z.number(),
  unknownCents: z.number(),
  overrun: z.boolean(),
  legacyUnclassified: z.boolean(),
});
```

Update `runDtoSchema` so `provider`, `model`, `providerAttemptId`, `costSource` are exposed and `tokensIn`/`tokensOut` are `.nullable()`. Add `budget: budgetViewDtoSchema` to `agentPageSchema` and to the cabinet page's per-agent cards. Update `src/server/mappers.ts` (`toRunDto` null-safe pass-through) and `src/server/services/queries/agent.ts` + `src/server/readmodels/agent.ts` to build it. Any page reading `.tokensIn`/`.costCents` for display must handle null explicitly.

- [ ] **Step 7: Show the budget's scope in Agent views**

Label the displayed amount as current-week model usage, with measured-token, estimated-cost, and unknown-exposure semantics derived from the persisted source. Show reserved, settled, and unresolved amounts separately, plus the period start/end with timezone. Do not show `agents.spentCents` as a weekly value. In `img`/text copy, keep the distinction between provider cost estimates and broader run activity.

- [ ] **Step 8: Run model accounting and lifecycle regression tests**

Run: `pnpm exec vitest run tests/integration/model-usage-accounting.test.ts tests/integration/task-lifecycle.test.ts tests/integration/apprentice-autonomy-audit.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: tests pass; demo acceptance remains usable but does not affect real provider spend.

## Task 3: Make trust and autonomy decisions evidence-based and race-safe

**Files:**
- Modify: `src/lib/domain/provenance.ts`
- Modify: `src/lib/domain/policy.ts`
- Modify: `src/lib/policy/config.ts`
- Modify: `src/server/services/commands/agents.ts`
- Modify: `src/server/services/commands/tasks/audit.ts`
- Modify: `src/server/services/queries/review.ts`
- Modify: `src/app/review/page.tsx`
- Modify: `src/contracts/dto/entities.ts` (`policyConfigDtoSchema`)
- Modify: `src/lib/db/seed.ts`
- Modify: `src/lib/setup.ts`
- Create: `drizzle/0019_autonomy_min_samples.sql`
- Create: `tests/integration/autonomy-evidence.test.ts`

- [ ] **Step 1: Add a single eligibility predicate**

In `src/lib/domain/provenance.ts` (extend, do not fork the unions):

```ts
export type AuditSampleInput = {
  artifactSourceType: string;
  artifactSubmittedBy: string;
  executionChannel: string;          // runs.mode
  hasProviderAttempt: boolean;       // runs.provider_attempt_id IS NOT NULL
};
export const isEligibleAuditSample = (input: AuditSampleInput): boolean =>
  input.artifactSubmittedBy === "agent" &&
  input.artifactSourceType === "model_generated" &&
  input.executionChannel === "live" &&
  input.hasProviderAttempt;
```

Unit tests must prove `demo_fixture`, `rule_generated`, `legacy_unknown`, `user_input`, and `submitted_by: "user"` all return false.

- [ ] **Step 2: Add failing tests for autonomy sample eligibility**

Cover these cases:

- No eligible audits cannot unlock a higher autonomy level (`insufficient_samples`).
- Demo, rule-generated, user-submitted, and legacy-unknown artifacts do not count as real model-execution evidence.
- Eligible audit sample size must meet the configured minimum (5 distinct eligible tasks) before a pass rate is considered.
- A pass rate below the configured threshold blocks promotion (`low_pass_rate`).
- A downgrade remains available even if the agent is paused or has no qualifying sample.
- The recorded reason/decision payload includes `samples`, `passRate`, and the denial code; the Review page badge and the command path show the same decision.

- [ ] **Step 3: Run tests and verify missing-sample behavior**

Run: `pnpm exec vitest run tests/integration/autonomy-evidence.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL where the current behavior treats an empty audit window as a zero rate and has no separate minimum-sample requirement.

- [ ] **Step 4: Define autonomy evidence and sample minimum**

Treat trust score, successful task count, and audit pass rate as distinct signals. For a promotion:

- Require the existing status, lifecycle, trust, and success thresholds.
- Calculate the audit window only from eligible, non-simulated Agent output and its corresponding Auditor result, using `isEligibleAuditSample`.
- Add a named `minAuditSamples` policy setting (default 5) rather than overloading `minSuccesses`:

```ts
// src/lib/domain/policy.ts
autonomy: { minTrust: 70, minSuccesses: 3, minAuditPassRate: 0.9, minAuditSamples: 5 }
// src/lib/policy/config.ts — zod
minAuditSamples: z.number().int().min(1)
// src/contracts/dto/entities.ts — policyConfigDtoSchema.autonomy
minAuditSamples: z.number(),
```

- **Backfill existing workspaces** with `drizzle/0019_autonomy_min_samples.sql` (data-only, no snapshot, same pattern as `0012_cost_caps.sql`):

```sql
UPDATE "policy_config"
SET "value_json" = "value_json" || '{"minAuditSamples":5}'::jsonb
WHERE "key" = 'autonomy' AND NOT ("value_json" ? 'minAuditSamples');
```

- **Harden provisioning** in `src/lib/setup.ts`: after the top-level key loop, merge missing nested keys from `SEED_POLICY_CONFIG` into existing rows (deep-merge, never overwrite operator values). Without this, every new or repaired workspace would need the migration again.
- Use the latest audit verdict for each distinct eligible task within the recent window (`config.audit.passRateWindow` distinct tasks), so retrying one task never creates multiple samples.
- Return an explicit denial code from a finite set: `insufficient_samples | low_pass_rate | low_trust | too_few_successes | not_eligible_role | retired | paused`.
- Exclude user-submitted artifacts from Agent performance statistics.

Keep the deterministic nature of the current Auditor explicit in code comments and README: these gates measure success under configured checklist rules, not independent human or LLM quality review.

- [ ] **Step 5: Make promotion check and write one consistent operation**

Move the Agent read, qualified audit sample query, decision, autonomy update, and audit event into one transaction. Lock the Agent row (`SELECT ... FOR UPDATE`) or use an equivalent conditional update that also guards `status`, `lifecycle_stage`, `trust_score`, and `autonomy_level`, so an intervening pause, retirement, level change, or trust change cannot be ignored. Delete the current conditional update that guards only `autonomy_level`. Use the same lock ordering as `auditTask` (agent row first, then audit event insert) to avoid deadlocks.

- [ ] **Step 6: Update Agent counters atomically during audits**

In `auditTask`, replace stale-value writes (`executor.successCount + 1`, `executor.trustScore + …`, streak computed from the stale row) with SQL-atomic increments computed inside the same transaction that holds the agent row lock. Do not increment trust/success counters for demo, rule-generated, user-submitted, or unknown-provenance output; keep the audit decision and its provenance record intact.

- [ ] **Step 7: Align the Review page with the backend decision**

`src/server/services/queries/review.ts` must compute `auditStats` over eligible samples only and expose the sample count, the measured pass rate, and the denial code. `src/app/review/page.tsx` renders "可升级" **only** when the backend decision object allows promotion, and shows the reason otherwise. No page may recompute eligibility from `successCount`/`trustScore`/`passRate` on its own.

- [ ] **Step 8: Test concurrent promotion and audit updates**

Integration tests must prove:

- Two concurrent audits do not lose success/failure increments.
- Concurrent promotion and pause/retire cannot leave a paused or retired Agent promoted.
- Promotion and its audit log either both commit or both roll back.
- The recorded reason includes the eligible sample count and measured pass rate.

- [ ] **Step 9: Run focused policy and concurrency tests**

Run: `pnpm exec vitest run tests/unit/policy.test.ts tests/integration/policy-config.test.ts tests/integration/autonomy-evidence.test.ts tests/integration/apprentice-autonomy-audit.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: all tests pass, including database-backed concurrency cases and the migrated config key.

## Task 4: Bind apprentice qualification to explicit training evidence

**Files:**
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/domain/state.ts`
- Modify: `src/contracts/templates.ts`
- Modify: `src/contracts/labels.ts`
- Modify: `src/contracts/routes.ts`
- Modify: `src/contracts/dto/entities.ts`
- Modify: `src/server/mappers.ts`
- Modify: `src/server/services/commands/apprentice.ts`
- Modify: `src/server/services/queries/agent.ts`
- Create: `src/app/api/apprentice/observations/route.ts`
- Modify: `src/components/actions/agent-actions.tsx`
- Modify: `src/app/cabinet/[id]/page.tsx`
- Modify: `src/lib/validation/schemas.ts`
- Create: `drizzle/0020_apprentice_observations.sql` + `drizzle/meta/0020_snapshot.json`
- Create: `tests/integration/apprentice-training-evidence.test.ts`
- Modify: `tests/integration/apprentice-autonomy-audit.test.ts`
- Modify: `tests/integration/policy-config.test.ts` if the config fixture needs the new key

- [ ] **Step 1: Extend the lifecycle state machine first**

`practice_passed` must exist before any command writes it:

```ts
// src/lib/domain/state.ts
apprentice: {
  shadowing: ["drafting", "retired"],
  drafting: ["examining", "retired"],
  examining: ["active", "drafting", "practice_passed", "retired"],
  practice_passed: ["retired"],
  active: ["retired"],
  retired: [],
}
```

Add `practice_passed` to the exam guard set in `src/server/services/commands/apprentice.ts` (currently `["shadowing", "drafting", "examining"]`) only where it must be re-examined or retired; by default it is terminal except retirement.

- [ ] **Step 2: Write failing tests for qualifying training evidence**

Test that:

- A successful unrelated mentor task does not qualify.
- A demo/simulated/legacy-unknown run does not qualify as real training.
- A run qualifies only when the user explicitly records that the apprentice observed it, and the linked mentor run is successful, has a provider attempt, belongs to the apprentice's configured mentor (or fallback Coach), and its task was accepted/done.
- The same run can be recorded only once for a given apprentice and skill version; retries of that run never count as separate observations.
- The required observation threshold is `APPRENTICE_SKILL.minShadowRuns` (currently 5), tied to the latest skill row selected for examination.
- The apprentice cannot take the exam without the required distinct completed observations.
- A deterministic exam pass is an internal practice result only: it moves the apprentice to `practice_passed`, keeps the skill labelled `draft`/`practice` (never `production`), leaves `autonomyLevel` at 1, does not raise trust, does not set `status = "active"`.

- [ ] **Step 3: Run the new training evidence tests**

Run: `pnpm exec vitest run tests/integration/apprentice-training-evidence.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: FAIL because the current gate counts all succeeded runs for the apprentice and mentor.

- [ ] **Step 4: Persist explicit training evidence**

Create `apprentice_observations` and `apprentice_exam_snapshots` per Appendix A. Both are tenant-scoped (`user_id`) and both are created by `drizzle/0020_apprentice_observations.sql` with a matching snapshot. Preserve historical run rows; never infer observation links from old unlinked runs. This migration stays separate from `0018_agent_budget` even when both ship in one branch.

- [ ] **Step 5: Record eligible observations from the actual training flow**

Add "记录为学徒观摩" on the Apprentice detail surface. The user selects an eligible mentor run from a server-provided list. `POST /api/apprentice/observations` (registered in `src/contracts/routes.ts`, validated in `src/lib/validation/schemas.ts`, handled with the existing `handleMutation` wrapper and `revalidatePath` for `/cabinet`, `/cabinet/<apprenticeId>`, `/review`) must revalidate tenant ownership, apprentice/mentor relationship, provider-backed provenance, accepted/done task status, and eligibility via `isEligibleAuditSample`-style rules extended for training (`execution channel = live`, provider attempt present, artifact not user-submitted). Never trust the client-supplied list. Never qualify a seeded/demo run, failed task, rule-generated run, or deterministic exam artifact. Duplicate submission is idempotent-or-rejected (`409`/`200` with the existing row), driven by the unique constraint.

- [ ] **Step 6: Gate the exam on distinct qualifying observations**

Replace the global role-run count in `runApprenticeExam` (currently `inArray(runs.agentId, [apprentice.id, mentorId]) && eq(runs.status, "succeeded")`) with a tenant-scoped query over `apprentice_observations` for the latest skill row's current version, filtered to `qualification = 'qualified'`. Snapshot the chosen observation IDs into `apprentice_exam_snapshots` when the attempt is created; do not consume them, so the two-attempt retry policy can reuse the same evidence. Include observed and required counts in the response and UI. Serialize attempt creation by locking the apprentice row (`FOR UPDATE`) so two concurrent requests cannot create duplicate attempts. The exam still uses the normal audit path, but a pass only moves the apprentice to `practice_passed` and writes an `apprentice.practice_passed` audit event; real promotion to `active`/L2 remains future work requiring a separately designed, non-simulated evaluation.

- [ ] **Step 7: Update the existing tests that assert the old promotion**

`tests/integration/apprentice-autonomy-audit.test.ts` currently encodes the behaviour this task removes. Change exactly these expectations:

| Location | Old assertion | New assertion |
|---|---|---|
| "promotes the apprentice after enough shadow runs" | `{ passed: 5, required: 5, promoted: true }`, `lifecycleStage === "active"`, `skill.label === "production"` | `{ passed: 5, required: 5, promoted: false, practicePassed: true }`, `lifecycleStage === "practice_passed"`, `skill.label` stays `draft`/`practice`, `autonomyLevel === 1`, `trustScore` unchanged |
| same test | second exam call throws `ConflictError` because the agent is active | second exam call throws `ConflictError` because it is no longer in an exam-eligible stage |
| "promotes a newly registered workspace with random agent ids" | expects `active` + `production` | same new expectations as above |
| "retires the apprentice after two failed exam attempts" | unchanged intent | keep, plus assert both attempts stored an `apprentice_exam_snapshots` row |
| audit-event assertions | `apprentice.promote` | `apprentice.practice_passed` |

Also update the shadow-run seeding helper in that file to create `apprentice_observations` rows via the command path (not raw inserts), so the gate is exercised end to end.

- [ ] **Step 8: Test migration preservation and exam retry lifecycle**

Using `tests/helpers/migrations.ts`, apply migrations up to `0019`, insert an apprentice, mentor, skills, and succeeded runs, then apply `0020`. Assert: all prior runs and skills preserved, **zero** observation links created, apprentice still in its prior stage, and the first exam attempt fails with `insufficient observations`. Then, in the normal test database: practice pass never grants production status/trust/autonomy, second failure retires the apprentice, duplicate observation submission is rejected, and concurrent exam requests cannot create duplicate attempts.

- [ ] **Step 9: Run focused apprentice tests**

Run: `pnpm exec vitest run tests/integration/apprentice-training-evidence.test.ts tests/integration/agent-governance-migration.test.ts tests/integration/apprentice-autonomy-audit.test.ts tests/integration/learning-loop.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: all lifecycle, evidence, migration, and retry assertions pass.

## Task 5: Update documentation and verify the integrated Agent path

**Files:**
- Modify: `README.md`
- Modify: `src/app/cabinet/page.tsx`
- Modify: `src/app/cabinet/[id]/page.tsx`
- Modify: `src/app/review/page.tsx`
- Create: `docs/superpowers/specs/2026-10-22-budget-and-trust-semantics.md`
- Test: relevant integration and contract suites

- [ ] **Step 1: Document the actual budget and trust semantics**

Update README to distinguish:

- Weekly per-Agent provider-usage budget from any personal spending budget.
- Measured provider token usage from estimated model cost and unknown usage.
- Checklist acceptance from independent quality evaluation.
- Real model evidence from demo/rule/user-submitted artifacts.
- Apprentice training observations from deterministic exam simulation.

Do not describe autonomy level as proof of general intelligence or external-action readiness.

- [ ] **Step 2: Record the three irreversible decisions in an ADR**

Write `docs/superpowers/specs/2026-10-22-budget-and-trust-semantics.md` stating, with rationale: (a) the ledger is the only accounting authority and `runs.cost_cents` is telemetry; (b) `agents.spent_cents` / `agents.budget_period_start` are frozen legacy columns scheduled for removal in a later plan; (c) period boundaries are written once and never recomputed, so timezone changes only affect future periods. They are called "irreversible" because rev 1's ambiguity caused rework.

- [ ] **Step 3: Show evidence and period next to Agent controls**

In Cabinet/Agent surfaces, show the budget period (with timezone), usage quality split (reserved/settled/unknown), autonomy promotion eligibility plus sample size, and the source mix behind Agent success metrics. Explain why promotion is unavailable when there is no adequate sample. Keep existing control affordances; this task is reporting and clarity, not redesigning Agent permissions.

- [ ] **Step 4: Run all relevant API contract and integration tests**

Run: `pnpm exec vitest run tests/unit/policy.test.ts tests/unit/validation.test.ts tests/integration/provider-attempt.test.ts tests/integration/agent-budget.test.ts tests/integration/agent-governance-migration.test.ts tests/integration/model-usage-accounting.test.ts tests/integration/autonomy-evidence.test.ts tests/integration/apprentice-training-evidence.test.ts tests/integration/task-lifecycle.test.ts tests/integration/apprentice-autonomy-audit.test.ts tests/integration/learning-loop.test.ts --maxWorkers=1 --no-file-parallelism`

Expected: all selected test files pass; no contract turns unknown usage into zero.

- [ ] **Step 5: Run repository-wide final checks**

Run: `pnpm typecheck && pnpm exec eslint src tests && pnpm test && pnpm build`

Expected: typecheck, lint, all tests, and production build pass.

- [ ] **Step 6: Verify migrations on a populated database**

Run: `pnpm db:migrate` against a scratch database first migrated to `0016`, with seeded rows. Verify `select count(*)` invariants from Task 1 Step 8 and Task 4 Step 8, then run `pnpm db:migrate` again to prove idempotence. Never against a shared/production database.

- [ ] **Step 7: Inspect the final diff**

Run: `git diff --check && git status --short && git --no-pager diff --stat`

Expected: only intended schema, service, contract, UI, docs, migration, and test files are changed. No secrets, real user data, or generated build files are included.

## Release acceptance criteria

- The ledger is the only budget authority: no code path reads `runs.cost_cents` or `agents.spent_cents` to admit, reject, or explain a run.
- One week boundary cannot leave stale lifetime spend blocking the Agent, and concurrent runs cannot double-spend the same weekly allowance (proven by a two-transaction test that yields exactly one winner, not a timeout).
- No provider request is sent before its reservation commits; a successful generation is never discarded because of a cost check.
- Provider usage, estimated cost, unknown usage, and simulated activity are distinguishable in persistence (nullable tokens + `cost_source`) and in the UI.
- Failed provider requests retain any known usage, keep their attempt identity, and never masquerade as successful zero-cost runs.
- `autonomy.minAuditSamples` is present in every existing workspace after migration, and `getPolicyConfig()` still fails closed on genuinely invalid config.
- Demo, rule-generated, user-submitted, and unknown legacy output cannot inflate real Agent autonomy evidence; the Review page and the command path return the same decision.
- Autonomy promotion has a minimum eligible audit sample and cannot race past a pause/retirement.
- Apprentice exams require distinct, explicitly linked qualifying training observations; historical unlinked runs are not silently counted; a practice pass cannot grant production status, trust, or L2.
- `TRANSITIONS.apprentice` contains `practice_passed` and `EXAM_LIFECYCLE_STAGES` matches it.
- README, the ADR, and UI describe the resulting policy limits accurately.
- All release acceptance evidence comes from isolated tests; no production data or credentials are used.

## Appendix A: Schema definitions

```ts
// runs additions (Task 0)
provider: text("provider"),
model: text("model"),
providerAttemptId: text("provider_attempt_id"),
costSource: text("cost_source"),           // actual | estimated | unknown
tokensIn: integer("tokens_in"),            // nullable
tokensOut: integer("tokens_out"),          // nullable

export const agentBudgetPeriods = pgTable("agent_budget_periods", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  timezone: text("timezone").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  limitCents: real("limit_cents").notNull(),
  reservedCents: real("reserved_cents").notNull().default(0),
  settledCents: real("settled_cents").notNull().default(0),
  unknownCents: real("unknown_cents").notNull().default(0),
  overrun: boolean("overrun").notNull().default(false),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("agent_budget_periods_key").on(t.agentId, t.periodStart)]);

export const agentBudgetReservations = pgTable("agent_budget_reservations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  periodId: text("period_id").notNull().references(() => agentBudgetPeriods.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  taskId: text("task_id").references(() => tasks.id),
  runId: text("run_id").references(() => runs.id),
  state: text("state").notNull().default("reserved"), // reserved|settled|released|unknown_charged
  amountCents: real("amount_cents").notNull(),
  settledCents: real("settled_cents").notNull().default(0),
  providerAttemptId: text("provider_attempt_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("agent_budget_reservations_run_key").on(t.runId), // NULLs allowed for pre-run holds
  check("agent_budget_reservations_state_check",
    sql`${t.state} IN ('reserved','settled','released','unknown_charged')`),
]);

export const apprenticeObservations = pgTable("apprentice_observations", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  apprenticeId: text("apprentice_id").notNull().references(() => agents.id),
  mentorId: text("mentor_id").notNull().references(() => agents.id),
  skillId: text("skill_id").notNull().references(() => skills.id),
  skillVersion: integer("skill_version").notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  runId: text("run_id").notNull().references(() => runs.id),
  artifactId: text("artifact_id").references(() => artifacts.id),
  attestedByUserId: text("attested_by_user_id").notNull().references(() => users.id),
  attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  qualification: text("qualification").notNull().default("qualified"),
  reason: text("reason"),
}, (t) => [
  uniqueIndex("apprentice_observations_key").on(
    t.apprenticeId, t.skillId, t.skillVersion, t.runId),
]);

export const apprenticeExamSnapshots = pgTable("apprentice_exam_snapshots", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  apprenticeId: text("apprentice_id").notNull().references(() => agents.id),
  skillId: text("skill_id").notNull().references(() => skills.id),
  skillVersion: integer("skill_version").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  runId: text("run_id").references(() => runs.id),
  observationIds: jsonb("observation_ids").$type<string[]>().notNull().default([]),
  passed: boolean("passed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("apprentice_exam_snapshots_key").on(
    t.apprenticeId, t.skillId, t.skillVersion, t.attemptNo),
]);
```

**Note:** `agent_budget_reservations_run_key` must be a *partial* unique index in SQL (`WHERE run_id IS NOT NULL`) so multiple pre-run holds can coexist; express it in the migration SQL, since Drizzle's `uniqueIndex` builder does not emit partial predicates.

## Appendix B: Test file inventory

| File | Action | Purpose |
|---|---|---|
| `tests/integration/provider-attempt.test.ts` | new | attempt identity, unknown vs zero usage |
| `tests/unit/agent-budget.test.ts` | new | pure budget contract, DST boundaries |
| `tests/integration/agent-budget.test.ts` | new | ledger persistence, concurrency, overrun |
| `tests/integration/agent-governance-migration.test.ts` | new | `0018`/`0020` preservation, no invented usage |
| `tests/integration/model-usage-accounting.test.ts` | new | placeholder removal, budget DTO |
| `tests/integration/autonomy-evidence.test.ts` | new | eligible samples, denial codes, races |
| `tests/integration/apprentice-training-evidence.test.ts` | new | observations, snapshots, practice-only pass |
| `tests/helpers/migrations.ts` | new | `applyMigrationsUpTo`, scratch database |
| `tests/unit/provenance.test.ts` | extend (if present) | `isEligibleAuditSample` truth table |
| `tests/integration/apprentice-autonomy-audit.test.ts` | modify | five assertion groups listed in Task 4 Step 7 |
| `tests/unit/policy.test.ts` | modify | `minAuditSamples` in fixture + `decideUpgrade` |
| `tests/integration/policy-config.test.ts` | modify | migrated nested key loads |
| `tests/integration/reflection.test.ts` | modify | budget pressure reads ledger |
| `tests/integration/tenancy.test.ts` | modify | agent insert no longer needs `budgetPeriodStart` |
