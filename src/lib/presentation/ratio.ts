/**
 * Ratios vs percentages.
 *
 * This codebase carries both units, and mixing them has already produced real
 * bugs: `adherence` (0–100) was multiplied by 100 again and rendered 6250%, and
 * the apprenticeship bar passed a 0–1 ratio to `Progress`, which reads 0–100, so
 * four of five observations showed as 1%.
 *
 * The DTOs are not going to converge on one unit soon — `checkins.recallScore`
 * is a `real` constrained to 0–1 by the database, while `weeklyMetrics.adherence`
 * is computed as `(completed / planned) * 100` in SQL. So the conversion lives
 * here, named, instead of being an operator someone has to notice.
 */

/** Convert a 0–1 ratio to the 0–100 percentage `Progress` expects. */
export function ratioToPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

/**
 * Convert an observed/required pair to a 0–100 percentage.
 *
 * `required <= 0` yields 0 rather than NaN: a target of zero is "nothing to
 * collect", not a division the bar should try to draw.
 */
export function completionPercent(observed: number, required: number): number {
  if (!Number.isFinite(observed) || !Number.isFinite(required)) return 0;
  if (required <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((observed / required) * 100)));
}
