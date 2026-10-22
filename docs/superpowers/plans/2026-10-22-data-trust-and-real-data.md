# Data Trust and Real Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Cabinet distinguishes real user data and real execution from generated, rule-based, demo, and unknown legacy data, then add user-controlled real data inputs and connectors in independently testable stages.

**Architecture:** Add explicit provenance and execution semantics to the existing Drizzle/DTO/service pipeline; make real task runs fail honestly when model/tool execution is unavailable; keep demo fixtures outside real workspaces; then implement file import, web search, and read-only calendar as separate server-side connectors with separate permissions, lifecycle, and acceptance gates. The application owns the model API key through server environment secrets; no BYOK UI is in scope.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM, PostgreSQL, Zod contracts, AI SDK, Vitest.

**Prerequisites:** Execute in a new clean worktree based on the reviewed branch after deciding how to preserve/merge the current uncommitted changes. Do not implement in the currently dirty worktree. Before any migration, inspect the target database and verify backups. Never seed or truncate a production or shared database.

---

## File Map

| Area | Files |
|---|---|
| Trust design and deployment docs | `docs/superpowers/specs/2026-10-22-data-trust-design.md`, `README.md`, `.env.example` |
| Persistence and migrations | `src/lib/db/schema.ts`, `drizzle/00xx_*.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/00xx_snapshot.json`, `tests/helpers/db.ts` |
| Shared data contracts | `src/contracts/dto/entities.ts`, `src/contracts/dto/aggregates.ts`, `src/contracts/dto/common.ts`, `src/server/mappers.ts` |
| Model call and task orchestration | `src/lib/llm.ts`, `src/server/services/commands/tasks/run.ts`, `src/server/services/shared/draft.ts`, `src/server/services/commands/apprentice.ts` |
| Tool and council behavior | `src/server/services/commands/tasks/run.ts`, `src/server/services/commands/council/positions.ts`, `src/server/services/commands/council/create.ts` |
| Setup and demo controls | `src/lib/setup.ts`, `src/app/api/setup/route.ts`, `src/lib/validation/schemas.ts`, `src/app/setup/page.tsx`, `src/components/setup-form.tsx`, `src/lib/auth/context.ts`, `src/lib/auth/mode.ts`, `src/components/login-form.tsx`, `src/components/shell.tsx`, `src/lib/db/seed.ts`, `scripts/seed.ts`, `src/app/api/demo/reset/route.ts` |
| Queries, metrics and UI source labels | `src/server/services/queries/metrics.ts`, `src/server/services/queries/task.ts`, `src/server/services/queries/memory.ts`, `src/app/page.tsx`, `src/app/tasks/[id]/page.tsx`, `src/app/review/page.tsx`, `src/app/memory/page.tsx`, `src/components/markdown.tsx` |
| File import connector (new) | `src/server/connectors/files/*`, `src/app/api/imports/*`, upload UI component(s), `tests/integration/file-import.test.ts` |
| Web search connector (new) | `src/server/connectors/web-search/*`, `src/app/api/search/*` or task execution adapter, `tests/integration/web-search.test.ts` |
| Calendar connector (new) | `src/server/connectors/calendar/*`, `src/app/api/integrations/calendar/*`, `tests/integration/calendar-connector.test.ts` |
| Tests | `tests/unit/*`, `tests/integration/*`, `tests/global-setup.ts`, `.github/workflows/ci.yml` |

Keep the established `contracts` / `app/api` / `server/services` separation. New providers, secret handling, and external calls must stay server-side. Do not split large existing services solely for this work unless a focused seam is necessary to replace a fake integration.

## Task 1: Establish a clean implementation baseline and trust inventory

**Files:**
- Modify: `docs/superpowers/specs/2026-10-22-data-trust-design.md`
- Test: existing focused unit and integration suites; record current baseline in the task/PR, not in product data

- [ ] **Step 1: Create an isolated worktree from the chosen clean base**

After the current work is either committed or intentionally excluded and a clean base is selected, run: `git worktree add ../Cabinet-data-trust -b feat/data-trust HEAD`
Expected: `HEAD` is the explicitly selected reviewed commit; the new worktree is clean and does not include unrelated uncommitted changes from the current workspace.

- [ ] **Step 2: Run baseline checks before editing**

Run: `pnpm typecheck && pnpm exec eslint src tests && pnpm test && pnpm build`
Expected: all commands pass. If the full `pnpm lint` scans nested worktrees or generated files, address the lint ignore scope in this worktree before relying on it.

- [ ] **Step 3: Produce an explicit inventory of simulated paths**

Inspect the exact current implementation of `seed.ts`, `run.ts`, `draft.ts`, `llm.ts`, `positions.ts`, `apprentice.ts`, `setup.ts`, auth demo fallback, and demo reset. Record each path's current behavior, persistence effect, UI surface, and tests in the design document.

- [ ] **Step 4: Add characterization tests for existing demo-only behavior**

Create focused tests that demonstrate the current missing-key fallback, tool-step placeholder output, rules-generated council positions, demo seed behavior, and setup profile defaults. Keep these fixtures in isolated test databases.

- [ ] **Step 5: Run only the new characterization tests**

Run: `pnpm test -- tests/unit/data-provenance.test.ts tests/integration/execution-source.test.ts`
Expected: tests pass against the documented current behavior; these tests are written to be tightened in later tasks.

## Task 2: Define source, run, and measurement semantics

**Files:**
- Modify: `src/lib/db/schema.ts`
- Modify: `src/contracts/dto/entities.ts`
- Modify: `src/contracts/dto/aggregates.ts`
- Modify: `src/server/mappers.ts`
- Create: `src/lib/domain/provenance.ts`
- Create: `tests/unit/provenance.test.ts`
- Create: `tests/integration/provenance-migration.test.ts`
- Create: one additive Drizzle migration and matching metadata files

- [ ] **Step 1: Write failing unit tests for allowed provenance and run states**

Define and test the source categories `user_input`, `system_event`, `external_import`, `model_generated`, `rule_generated`, `demo_fixture`, and `legacy_unknown`; define explicit execution modes and connector states. Reject unknown values at the DTO boundary.

- [ ] **Step 2: Add explicit unknown-value semantics for provider usage**

Make model token counts nullable when the provider does not report them. Define cost metadata that distinguishes `actual`, `estimated`, and `unknown`; never treat missing usage/cost as measured zero.

- [ ] **Step 3: Add additive persistence fields**

Add only the columns needed to trace run mode/source, provider/model identifiers, nullable usage, cost source, source references, and artifact provenance. Add a persisted source category to memories as well as runs and artifacts; preserve each memory's evidence and `sourceEventId` reference. Choose names and defaults in one schema change; do not store secrets or raw authorization tokens in these records.

- [ ] **Step 4: Backfill existing records conservatively**

Backfill existing records to `legacy_unknown` unless a row can be safely identified as an explicit demo fixture. Do not infer that all historical runs are real or demo from a missing field. Make the migration additive and idempotent according to repository migration conventions.

- [ ] **Step 5: Test the migration against populated pre-migration data**

Create an isolated migration-test database at the immediately preceding schema version, insert identifiable demo records and ambiguous legacy records in runs, artifacts, and memories, then apply only the new migration. Assert all rows remain intact, identifiable demo records are tagged `demo_fixture`, ambiguous records are `legacy_unknown`, and the migration is safe to rerun according to Drizzle's migration tracking. Also keep the existing fresh-database migration test.

- [ ] **Step 6: Update DTO schemas and row mappers**

Ensure new fields round-trip through runtime Zod validation; preserve nullability for missing provider usage and unknown legacy sources. Add database-to-DTO round-trip tests for memory provenance, including `legacy_unknown` and `demo_fixture` rows; ensure memory evidence/source references remain tenant-scoped and serializable.

- [ ] **Step 7: Run migration and focused contract tests**

Run: `pnpm test -- tests/unit/provenance.test.ts tests/integration/provenance-migration.test.ts tests/unit/boundary.test.ts`
Expected: migration applies to a fresh isolated test database; existing DTOs fail loudly if a source/status value is invalid.

## Task 3: Stop real task runs from producing simulated success

**Files:**
- Modify: `src/lib/llm.ts`
- Modify: `src/server/services/commands/tasks/run.ts`
- Modify: `src/server/services/shared/draft.ts`
- Modify: `src/server/services/commands/apprentice.ts`
- Modify: task run DTO and task detail UI files in the file map
- Create: `tests/integration/real-run-failure.test.ts`
- Modify: `tests/integration/run-task.test.ts`, `tests/integration/saga.test.ts`

- [ ] **Step 1: Write failing tests for missing key, provider error, timeout, and empty model response**

Assert that each failure produces a non-success run state, no success artifact, a safe error category, and no template fallback in a real run.

- [ ] **Step 2: Replace nullable/silent model failure with a typed result**

Represent `success`, `not_configured`, `provider_error`, `timeout`, and `empty_response` distinctly. Avoid broad catches that erase the underlying error category; do not expose provider secrets or sensitive request details.

- [ ] **Step 3: Update task orchestration to finalize failures honestly**

Use the existing run/task failure handling and transaction/Saga conventions. A failed model request must not set the task to `submitted` or mark the run `succeeded`. Preserve retry and idempotency semantics.

- [ ] **Step 4: Restrict `draftFor()` to explicit simulation flows**

Real task execution must not call `draftFor()` as a fallback. If deterministic drafts are retained for apprentice/demo paths, persist and return `demo_fixture`/simulated provenance and ensure they cannot be counted as real model runs.

- [ ] **Step 5: Make model execution metadata truthful**

Persist provider/model only after a configured invocation; store missing provider token counts as `null`; record elapsed time from actual execution; calculate actual or estimated cost only when its inputs are known and label the result accordingly.

- [ ] **Step 6: Run task lifecycle and failure tests**

Run: `pnpm test -- tests/integration/real-run-failure.test.ts tests/integration/run-task.test.ts tests/integration/saga.test.ts tests/integration/idempotency.test.ts`
Expected: model absence/failure cannot be mistaken for successful real execution; normal live execution and retry behavior remain valid.

## Task 4: Make tool, council, and apprentice provenance explicit

**Files:**
- Modify: `src/server/services/commands/tasks/run.ts`
- Modify: `src/server/services/commands/council/positions.ts`
- Modify: `src/server/services/commands/council/create.ts`
- Modify: `src/server/services/commands/apprentice.ts`
- Modify: task trace, council and apprentice UI surfaces
- Create: focused tests in `tests/integration/tool-provenance.test.ts`, `tests/integration/council-provenance.test.ts`, and `tests/integration/apprentice-provenance.test.ts`

- [ ] **Step 1: Write tests that distinguish planned, unavailable, simulated, and executed tools**

Assert that an unimplemented search, notes, or ledger tool cannot create a `succeeded` external-tool step with fabricated results.

- [ ] **Step 2: Replace placeholder tool outputs in real runs**

Until a real connector exists, show a typed `not_connected`/`unavailable` status or omit the tool result. Explicit demo simulation must be tagged and excluded from real run metrics.

- [ ] **Step 3: Mark rule-generated council positions**

Persist and display that current council positions are `rule_generated`; include which user data/evidence was used. Do not describe these as independently model-researched positions.

- [ ] **Step 4: Keep deterministic apprentice evaluation labeled simulated**

Ensure simulated exam artifacts and outcomes remain visible as simulation, and do not grant claims of validated capability based solely on simulated output. Preserve the existing state machine tests.

- [ ] **Step 5: Run focused domain tests**

Run: `pnpm test -- tests/integration/tool-provenance.test.ts tests/integration/council-provenance.test.ts tests/integration/apprentice-provenance.test.ts tests/integration/council.test.ts tests/integration/apprentice-autonomy-audit.test.ts`
Expected: every non-live capability is visibly and persistently distinguishable from actual execution.

## Task 5: Filter metrics and UI by provenance

**Files:**
- Modify: `src/server/services/queries/metrics.ts`
- Modify: `src/server/services/queries/review.ts`
- Modify: relevant task, memory, council and Today query/read models
- Modify: `src/contracts/dto/aggregates.ts`, `src/server/mappers.ts`
- Modify: `src/app/page.tsx`, `src/app/review/page.tsx`, `src/app/tasks/[id]/page.tsx`, `src/app/memory/page.tsx`
- Create: `tests/integration/metrics-provenance.test.ts`

- [ ] **Step 1: Write failing metrics tests with mixed real, simulated, and legacy rows**

Assert demo fixtures never affect real-user metrics; legacy unknown values are not silently labeled real; sample counts and source labels match the data included.

- [ ] **Step 2: Update metric queries to use explicit source/run criteria**

Define metric eligibility by both source and metric: exclude `demo_fixture` and `legacy_unknown` from verified real metrics; exclude `model_generated` and `rule_generated` from counts of observed user facts/completions; count a model-backed run only as a real execution when a corresponding actual `system_event` records its successful lifecycle and the provider invocation succeeded. Keep user self-reports distinct from measured system events and expose generated outputs in separate generated-content metrics if useful.

- [ ] **Step 3: Represent insufficient samples and unmeasured metrics**

Use `null`/empty state where no real sample exists instead of a fixed zero or demo number. Preserve explicit estimated indicators for proxy metrics such as management time; show the estimate method and sample count.

- [ ] **Step 4: Add source and status labels to result surfaces**

Task traces, artifacts, memory evidence, council positions, and review metrics should identify user input, system-observed, external import, model generated, rule generated, simulated, or unverified history as applicable.

- [ ] **Step 5: Run metric, DTO, and rendering data tests**

Run: `pnpm test -- tests/integration/metrics-provenance.test.ts tests/unit/acceptance.test.ts tests/unit/boundary.test.ts`
Expected: pages can render an empty real workspace without fabricated history; mixed provenance is visibly distinguishable.

## Task 6: Make new workspaces real and isolate demo data

**Files:**
- Modify: `src/lib/setup.ts`
- Modify: `src/app/api/setup/route.ts`
- Modify: `src/lib/validation/schemas.ts`
- Modify: `src/app/setup/page.tsx`, `src/components/setup-form.tsx`
- Modify: `src/lib/auth/context.ts`, `src/lib/auth/mode.ts`, `src/components/login-form.tsx`, `src/components/shell.tsx`
- Modify: `src/lib/db/seed.ts`, `scripts/seed.ts`, `src/app/api/demo/reset/route.ts`
- Modify: `src/lib/account.ts` so newly added import/source records are included in export and account deletion
- Create or update: `tests/integration/blank-workspace.test.ts`, `tests/integration/demo-isolation.test.ts`, `tests/unit/auth-mode.test.ts`

- [ ] **Step 1: Write failing blank-workspace tests**

Register/setup a new user and assert no sample goals, tasks, memories, councils, runs, artifacts, or review history are created.

- [ ] **Step 2: Remove unconfirmed personal-profile defaults**

Keep timezone only if user selected or confirmed it. Persist unprovided constraints, budget, preferences, and energy pattern as unset; update contracts and DTOs to represent nullable/unconfigured values.

- [ ] **Step 3: Preserve explicit product defaults**

Keep default Agent roles/permissions as reviewed product templates, but display them as templates awaiting user acceptance rather than user history. Avoid copying demo account names, trust scores, usage counts, or seed achievements into setup.

- [ ] **Step 4: Gate demo login, seed, and destructive reset**

Production must reject demo login, demo seed, and reset. Ensure the explicit demo environment uses a separate database/configuration and cannot resolve to a real user's fallback session.

- [ ] **Step 5: Convert empty-data screens to honest onboarding states**

Show instructions to create/import the first real goal, task, memory, or check-in. Do not create synthetic rows to fill UI cards.

- [ ] **Step 6: Keep account export and deletion complete**

Extend the existing `exportAccount()` and `deleteAccount()` behavior to include all new provenance, imported file, connector, and integration records. Export source metadata and imported-content references/data according to the retention decision, and ensure delete revokes or removes connector credentials and dependent imports. Preserve the existing user-scoped deletion behavior.

- [ ] **Step 7: Run setup/auth/isolation tests**

Run: `pnpm test -- tests/integration/blank-workspace.test.ts tests/integration/demo-isolation.test.ts tests/integration/setup.test.ts tests/integration/tenancy.test.ts tests/unit/auth-mode.test.ts tests/unit/demo-reset.test.ts`
Expected: a new account has no demo business history; demo tools are unavailable in production configuration.

## Task 7: Operate the model through server-side secrets

**Files:**
- Modify: `src/lib/llm.ts`
- Modify: `src/lib/env.ts` or the existing runtime environment validation module
- Modify: `src/lib/config/*` as appropriate
- Modify: `.env.example`
- Modify: settings UI and server query/API surface
- Create: `tests/unit/llm-config.test.ts`, `tests/integration/model-health.test.ts`

- [ ] **Step 1: Write tests for missing/valid/invalid model configuration**

Prove model keys are read only server-side; invalid configuration yields a clear startup/health error without key values in output.

- [ ] **Step 2: Validate server-side provider configuration**

Validate key presence, model identifier, optional base URL, timeouts, and token caps. Never echo secret values in validation errors.

- [ ] **Step 3: Add a non-secret model status surface**

Expose configured/unconfigured, provider/model, and last safe health/error status. Do not implement a key entry form or store a user key.

- [ ] **Step 4: Distinguish provider-reported usage from missing usage**

Tests must prove `null` provider usage is not converted to `0`; distinguish actual charge, computed estimate, and unknown cost in API and UI.

- [ ] **Step 5: Run configuration and security tests**

Run: `pnpm test -- tests/unit/llm-config.test.ts tests/integration/model-health.test.ts tests/unit/env.test.ts tests/unit/security-headers.test.ts`
Expected: no secret appears in API payloads, logs, errors, or client bundles; model status is useful without exposing credentials.

## Task 8: Add user-controlled file import

**Files:**
- Create: `src/server/connectors/files/*`
- Create: `src/app/api/imports/files/route.ts` and resource-specific routes if required
- Create: file import tables/schema and one additive migration
- Create: upload UI and import status DTOs
- Create: `tests/integration/file-import.test.ts`, `tests/unit/file-parser.test.ts`

- [ ] **Step 1: Define allowed file formats, size limits, retention, and deletion semantics**

Choose a minimal initial allowlist based on the product's learning/work documents. Do not accept executable files. Document whether originals or extracted text are stored and how users delete them.

- [ ] **Step 2: Write failing parser/validation tests**

Cover accepted file, unsupported type, size limit, empty content, malformed input, duplicate import, and user-ownership boundaries.

- [ ] **Step 3: Implement server-side import records and parser adapter**

Store owner, source filename/type, import time, processing state, and content hash/reference. Keep files private; do not expose storage URLs or contents across tenants.

- [ ] **Step 4: Add import list/status/delete UX**

Show processing, ready, failed, and deleted states. Do not create a memory or claim facts automatically without a user confirmation path.

- [ ] **Step 5: Run file import integration and tenancy tests**

Run: `pnpm test -- tests/integration/file-import.test.ts tests/integration/tenancy.test.ts tests/unit/file-parser.test.ts`
Expected: imported content has traceable source, cannot leak across users, and can be deleted.

## Task 9: Add citation-backed web search as a separate connector

**Files:**
- Create: `src/server/connectors/web-search/*`
- Modify: `src/server/services/commands/tasks/run.ts` through a typed connector boundary
- Create: provider config validation and a migration only if persistence is required
- Modify: task trace/artifact DTOs and UI for URL/capture-time citations
- Create: `tests/integration/web-search.test.ts`, `tests/unit/web-citation.test.ts`

- [ ] **Step 1: Select a provider before implementation**

Compare supported search providers for region/language coverage, citations, retention, cost, and server-side credentials. Record the selected provider and configuration in a short decision record; do not guess a provider in code.

- [ ] **Step 2: Define and test a provider-neutral result shape**

Each result includes canonical URL, title, snippet/content reference, retrieval timestamp, provider, and request status. Validate citations before including them in model prompts or artifacts.

- [ ] **Step 3: Implement the provider adapter and rate/error handling**

Distinguish no results, provider error, timeout, rate limit, and success. A provider failure cannot produce a fabricated “N results found” step.

- [ ] **Step 4: Persist evidence references and display them**

Research artifacts cite retrieved URLs and timestamps. Claims with no source are labeled as unsupported/model-generated rather than verified research.

- [ ] **Step 5: Run web search tests**

Run: `pnpm test -- tests/integration/web-search.test.ts tests/unit/web-citation.test.ts tests/integration/run-task.test.ts`
Expected: only provider-returned results appear as external evidence; errors and empty results remain explicit.

## Task 10: Add read-only calendar integration

**Files:**
- Create: `src/server/connectors/calendar/*`
- Create: `src/app/api/integrations/calendar/*`
- Create: integration credential storage using an approved encrypted secret mechanism
- Modify: planning queries only after the connector is connected
- Create: `tests/integration/calendar-connector.test.ts`, `tests/unit/calendar-permissions.test.ts`

- [ ] **Step 1: Choose a calendar provider and authorization model**

Decide supported provider, OAuth scopes, token refresh/revocation, encryption key management, and data retention before adding credential schema. Request read-only minimum scopes.

- [ ] **Step 2: Write tests for consent and connector lifecycle**

Cover not connected, consent denied, connected, expired credential, provider failure, revoked, and deleted integration states.

- [ ] **Step 3: Implement encrypted credential storage and read-only sync**

Never persist access/refresh tokens in plaintext. Restrict all connector operations by authenticated user and connector owner.

- [ ] **Step 4: Display imported schedule data with provenance**

Show provider/source and last sync time. Do not write or book events; imported events are planning evidence, not proof of task completion.

- [ ] **Step 5: Run calendar security and lifecycle tests**

Run: `pnpm test -- tests/integration/calendar-connector.test.ts tests/unit/calendar-permissions.test.ts tests/integration/tenancy.test.ts`
Expected: read-only scopes only, reliable revoke/delete, and no cross-user data access.

## Task 11: End-to-end gates, CI, and documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`, `docs/frontend-backend-separation.md`, and relevant deployment/config docs
- Modify: `src/lib/account.ts` and `tests/integration/setup.test.ts` if final journey reveals export/delete gaps
- Create: `tests/integration/real-user-journey.test.ts` or the repository's browser E2E equivalent
- Modify: `tests/global-setup.ts` only if test fixture isolation needs a focused correction

- [ ] **Step 1: Write end-to-end journey tests**

Cover new user → blank workspace → create real goal/task → model live success (stub provider response) → inspect citations/source → audit → review/memory → export/delete.

- [ ] **Step 2: Add negative E2E paths**

Cover missing model key, provider timeout, unavailable connector, empty dataset, demo fixture exclusion, and second-user isolation.

- [ ] **Step 3: Run migration from the baseline**

Run: `pnpm db:migrate` against both a newly created disposable Postgres database and an isolated populated pre-migration database. Run the full integration suite against the latest schema.
Expected: all additive migrations apply in order without relying on `db:push`; existing records are preserved and conservatively classified.

- [ ] **Step 4: Update product/developer documentation**

Document exact real/demo boundaries, environment Key setup, failure behavior, data provenance labels, connector permissions, and how to run isolated tests. Remove stale statements that contradict current implementation.

- [ ] **Step 5: Run the complete verification suite**

Run: `pnpm typecheck && pnpm exec eslint src tests && pnpm test && pnpm build`
Expected: all checks pass. Run CI's `pnpm lint` too after ensuring generated `.next` and nested worktree files are excluded appropriately.

- [ ] **Step 6: Review the actual product journey**

Manually verify an empty real account and a deliberately configured demo environment. Confirm the UI never makes demo/history/tool output look like user-observed facts.

## Release Gates

- Do not begin connector work until Tasks 2–7 pass and `legacy_unknown`/`demo_fixture` are filtered from real metrics.
- File import, web search, and calendar each ship independently; each has a separate permission, error, deletion, and tenancy gate.
- Do not turn on a connector in production without provider credentials in server-side secret storage and explicit configuration.
- Do not call a run “successful” unless the action actually ran and its required output/evidence was persisted.
- Do not call a metric “measured” unless its source reports the measurement; show unknown/estimated distinctly.
- Keep test fixtures in isolated temporary databases. Do not copy production user content into tests.
- Do not implement BYOK, calendar writes, booking, or payments under this plan.
