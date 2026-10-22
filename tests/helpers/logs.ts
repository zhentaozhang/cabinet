import { vi } from "vitest";

import type { LogFields } from "@/lib/obs/logger";

export type CapturedLog = LogFields & { event?: string; level?: string };

/**
 * Capture what the logger writes to stdout.
 *
 * The logger's contract is the *line*, not an internal API, so the tests assert
 * on parsed JSON lines rather than mocking the module.
 */
export function captureLog(): {
  records: () => CapturedLog[];
  lines: () => string[];
  restore: () => void;
} {
  const chunks: string[] = [];

  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);

  const lines = () => chunks.join("").split("\n").filter(Boolean);

  const records = () =>
    lines().flatMap((line) => {
      if (!line.startsWith("{")) return [];
      try {
        return [JSON.parse(line) as CapturedLog];
      } catch {
        return [];
      }
    });

  return { records, lines, restore: () => spy.mockRestore() };
}

export function eventsOf(
  records: CapturedLog[],
  event: string,
): CapturedLog[] {
  return records.filter((record) => record.event === event);
}
