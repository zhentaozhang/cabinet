import { describe, expect, it } from "vitest";
import { safeInternalPath } from "@/lib/safe-redirect";

const ORIGIN = "https://cabinet.example";

describe("safeInternalPath", () => {
  it("keeps same-origin absolute paths", () => {
    expect(safeInternalPath("/review?tab=1#x", ORIGIN)).toBe(
      "/review?tab=1#x",
    );
  });

  it("rejects external, protocol-relative and malformed targets", () => {
    expect(safeInternalPath("https://evil.example", ORIGIN)).toBe("/");
    expect(safeInternalPath("//evil.example/path", ORIGIN)).toBe("/");
    expect(safeInternalPath("/\\evil.example", ORIGIN)).toBe("/");
    expect(safeInternalPath("review", ORIGIN)).toBe("/");
    expect(safeInternalPath(null, ORIGIN)).toBe("/");
  });
});
