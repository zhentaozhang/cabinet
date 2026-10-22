/**
 * Only navigate to same-origin, absolute-path targets. Reject protocol-relative
 * URLs, external hosts and malformed values instead of trusting `startsWith`.
 */
export function safeInternalPath(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
