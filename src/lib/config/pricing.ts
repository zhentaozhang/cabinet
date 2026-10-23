/**
 * What one outbound retrieval costs, in cents.
 *
 * Read at call time on purpose: the operator can change the number between
 * deploys and old calls keep the price they were charged at. Unset or invalid
 * means "not priced", which the UI reports as 未计价 rather than guessing 0.
 */
export function retrievalUnitPriceCents(): number {
  const raw = Number(process.env.SEARCH_COST_CENTS_PER_REQUEST ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Weekly retrieval ceiling, in cents. 0 means "no ceiling configured".
 *
 * Model spend has had a hard cap since the budget ledger landed; retrieval did
 * not, which made it the one place a misconfigured cron could spend without
 * limit. A ceiling of 0 is not "spend nothing" — it is "nobody set a number",
 * and the UI says so instead of pretending there is a budget.
 */
export function retrievalWeeklyBudgetCents(): number {
  const raw = Number(process.env.RETRIEVAL_WEEKLY_BUDGET_CENTS ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
