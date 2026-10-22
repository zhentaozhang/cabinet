# ADR 2026-10-22: Budget and trust semantics

- **Status:** Accepted (rev 2, 2026-10-22)
- **Scope:** `agent_budget_periods`, `agent_budget_reservations`, `runs.cost_source` / provider
  attempt columns, autonomy promotion evidence, apprentice training evidence.
- **Supersedes:** the implicit semantics of `agents.spent_cents`, `agents.budget_period_start`
  and `runs.cost_cents` as they behaved before this change.

## Context

Before this change the codebase had three overlapping accounting stories:

1. `agents.spent_cents` was a lifetime counter clamped against `agents.budget_cents`. When a
   week rolled over nothing reset it, so an Agent that had spent its allowance once stayed
   blocked forever.
2. `runs.cost_cents` was written on every run but nothing reconciled it with the Agent counter,
   so the two could disagree, and a failed provider call could persist `0` cost as if it were a
   successful free run.
3. The "budget" wording mixed three different things: how much model usage this Agent may
   consume per week, what the provider actually measured, and what the demo rules pretended to
   consume.

The same ambiguity existed on the trust side: the Review page recomputed an upgrade badge from
unfiltered audit counts while the command path had its own (differently computed) view, so the
badge and the button could disagree. Apprentice promotion had a similar shape: the exam produced
a deterministic template artifact and treated passing it as production readiness.

Revision 1 of the plan papered over this with prose. Revision 2 replaced prose with three
decisions that are recorded here because reversing them would require a data migration and a
coordinated UI change.

## Decision 1: the ledger is the only accounting authority

`agent_budget_periods` (one row per Agent per week) plus `agent_budget_reservations` (one row per
provider attempt) are the single source of truth for "how much of this week's allowance is
used". Admission, denial, approval thresholds, the reflection rationale, the council context and
every UI surface read the ledger and nothing else.

`runs.cost_cents`, `runs.tokens_in` and `runs.tokens_out` remain as **telemetry**: useful for
inspecting one run, never used to admit or reject work.

**Rationale.** A single authority makes "spent" and "allowed" provably the same number; two
authorities require reconciliation code that no test can prove correct across crashes. The
reservation row also gives the pre-call hold an auditable identity, which the old conditional
`UPDATE ... WHERE spent + cost <= budget` never had.

**Consequences.**

- A hold is written **before** the provider request; a run that never contacts a provider
  settles its hold as `released` with zero usage.
- Unknown usage (provider error, timeout, or a response without a usage block) keeps the full
  hold as `unknown_charged` rather than pretending the call was free.
- A successful generation is never discarded because of a cost check: the old post-call
  `throw new PolicyDenied(...)` on `cost > maxRunCents` was deleted, because it burned money and
  then threw the artifact away.

## Decision 2: `agents.spent_cents` and `agents.budget_period_start` are frozen

The columns stay (dropping them would break readers during a rolling deploy) but no code writes
them. `setupWorkspace` provisions them once and the ledger takes over from there.

**Rationale.** Freezing is reversible; a `DROP COLUMN` is not, and the plan allows a later
cleanup migration once nothing has read them for a release.

**Consequences.** Removing them is a separate plan. Any new code that reads them for a budget
decision is a bug against this ADR.

## Decision 3: period boundaries are written once

A period row pins `timezone`, `period_start` and `period_end` at creation. Changing the user's
timezone afterwards affects the **next** period, never the current one.

**Rationale.** Recomputing boundaries from the current timezone would move already-settled usage
into a different bucket and could either double-count or erase spend mid-week. A written boundary
is auditable: the row explains itself.

**Consequences.** A mid-week timezone change keeps the old bucket until it closes; the UI prints
the period's own timezone so the user is not surprised.

## Related, deliberately narrower decisions

- **Autonomy evidence is real provider evidence.** A sample counts only when the artifact is
  `model_generated`, submitted by the agent, the run was on the `live` channel and it carries a
  provider attempt id. Demo fixtures, rule output, user submissions and legacy rows are excluded,
  and promotion requires `autonomy.minAuditSamples` (seed 5) *before* the pass-rate check, so
  "no evidence" is never reported as "0% pass rate".
- **Practice is not production.** Passing the deterministic apprentice exam moves the lifecycle to
  `practice_passed` and labels the skill `practice`; it does not grant production status, trust,
  or autonomy level. Promotion still needs a separately designed evaluation (not in this plan).
- **Observations are explicit.** The exam requires `APPRENTICE_SKILL.minShadowRuns` recorded
  observation rows, each pointing at a mentor run the user explicitly attested. Historical
  mentor runs are never silently counted, so upgrading a workspace cannot fabricate training
  history.
- **`minAuditSamples` reaches existing workspaces.** `policy_config.autonomy` is validated
  fail-closed, so a missing nested key would break every pre-existing workspace; migration
  `0019_autonomy_min_samples` merges the key with `jsonb ||`, and `setupWorkspace` deep-merges
  missing nested keys for workspaces created before the seed changed.

## Evidence

- `tests/integration/agent-budget.test.ts` — reservation/settlement, unknown usage, overrun,
  concurrent holds (exactly one winner), timezone change, legacy-week detection.
- `tests/integration/agent-governance-migration.test.ts` — 0018/0020 land on populated databases
  without inventing usage or training evidence.
- `tests/integration/autonomy-evidence.test.ts`, `tests/integration/policy-config.test.ts`,
  `tests/integration/autonomy-min-samples-migration.test.ts` — one decision, both call paths.
- `tests/integration/apprentice-training-evidence.test.ts` — eligibility, duplication, practice
  pass without promotion, retirement, concurrent exams.
- `tests/integration/model-usage-accounting.test.ts` — measured vs unknown vs demo usage reaches
  persistence and the contract unchanged.
