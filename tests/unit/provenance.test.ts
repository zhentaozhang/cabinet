import { describe, expect, it } from "vitest";
import {
  isEligibleAuditSample,
  isSimulatedSource,
  type AuditSampleInput,
} from "@/lib/domain/provenance";

const base: AuditSampleInput = {
  artifactSourceType: "model_generated",
  artifactSubmittedBy: "agent",
  executionChannel: "live",
  hasProviderAttempt: true,
};

describe("audit sample eligibility", () => {
  it("accepts a live agent artifact with a provider attempt", () => {
    expect(isEligibleAuditSample(base)).toBe(true);
  });

  it("rejects simulated provenance", () => {
    for (const source of ["demo_fixture", "rule_generated", "legacy_unknown", "user_input"]) {
      expect(isEligibleAuditSample({ ...base, artifactSourceType: source })).toBe(false);
      expect(isSimulatedSource(source)).toBe(
        source === "demo_fixture" || source === "rule_generated",
      );
    }
  });

  it("rejects user-submitted artifacts", () => {
    expect(isEligibleAuditSample({ ...base, artifactSubmittedBy: "user" })).toBe(false);
  });

  it("rejects runs without a provider attempt or outside the live channel", () => {
    expect(isEligibleAuditSample({ ...base, hasProviderAttempt: false })).toBe(false);
    expect(isEligibleAuditSample({ ...base, executionChannel: "demo" })).toBe(false);
  });
});
