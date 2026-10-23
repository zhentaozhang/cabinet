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
