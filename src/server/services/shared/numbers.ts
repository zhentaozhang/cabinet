export function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}
