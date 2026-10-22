import { describe, expect, it } from "vitest";

import { needsSetup } from "@/lib/api/page-guard";

describe("setup gate", () => {
  it("sends a user with no agents to /setup", () => {
    expect(needsSetup([])).toBe(true);
  });

  it("does not redirect a user who already has a cabinet", () => {
    expect(needsSetup([{ id: "ag_chief" }])).toBe(false);
  });
});
