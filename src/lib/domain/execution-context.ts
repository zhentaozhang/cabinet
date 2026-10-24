/**
 * What a run carries besides the task text.
 *
 * Two things were written and never read: `skills` (a passed exam proved the
 * agent could do something the executor never asked it to do) and
 * `profiles.preferences.rules` (reflection produced rules no prompt honoured).
 * This module holds the pure part of closing that loop, so it can be tested
 * without a provider or a database.
 */

/** Deduplicate while keeping the declared order first, then the skill order. */
export function mergeTools(declared: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tool of [...declared, ...extra]) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    merged.push(tool);
  }
  return merged;
}

/**
 * Rules are free text written by reflection, so the read side refuses anything
 * that is not a non-empty string rather than trusting the jsonb shape.
 */
export function readRules(preferences: unknown): string[] {
  if (!preferences || typeof preferences !== "object") return [];
  const rules = (preferences as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((rule): rule is string => typeof rule === "string")
    .map((rule) => rule.trim())
    .filter((rule) => rule.length > 0);
}
