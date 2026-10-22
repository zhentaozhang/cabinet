export function short(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
