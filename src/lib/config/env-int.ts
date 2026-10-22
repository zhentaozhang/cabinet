/**
 * Reading a number from the environment without ever letting it become `NaN`.
 *
 * `Number(process.env.X ?? 60)` silently yields `NaN` for a typo (`"60/min"`,
 * `"sixty"`), and `NaN` comparison is always false — which turns a rate limit
 * or a budget into "no limit at all" while looking configured.
 */
export function envPositiveInt(
  name: string,
  fallback: number,
  max = 10_000,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.warn(
      `[cabinet] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`,
    );
    return fallback;
  }

  return Math.min(Math.floor(parsed), max);
}
