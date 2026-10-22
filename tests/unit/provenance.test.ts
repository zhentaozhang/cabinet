import { describe, expect, it } from "vitest";
import {
  isEligibleAuditSample,
  isEligibleTrainingObservation,
  isSimulatedSource,
  type AuditSampleInput,
  type TrainingObservationInput,
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

describe("training observation eligibility", () => {
  const trainable: TrainingObservationInput = {
    ...base,
    runStatus: "succeeded",
    taskStatus: "accepted",
  };

  it("accepts a succeeded mentor run on an accepted or done task", () => {
    expect(isEligibleTrainingObservation(trainable)).toBe(true);
    expect(
      isEligibleTrainingObservation({ ...trainable, taskStatus: "done" }),
    ).toBe(true);
  });

  it("rejects runs the mentor did not finish or the user did not accept", () => {
    expect(
      isEligibleTrainingObservation({ ...trainable, runStatus: "failed" }),
    ).toBe(false);
    for (const taskStatus of ["submitted", "rejected", "running", "planned"]) {
      expect(
        isEligibleTrainingObservation({ ...trainable, taskStatus }),
      ).toBe(false);
    }
  });

  it("inherits every audit-evidence requirement", () => {
    expect(
      isEligibleTrainingObservation({
        ...trainable,
        artifactSourceType: "demo_fixture",
      }),
    ).toBe(false);
    expect(
      isEligibleTrainingObservation({ ...trainable, hasProviderAttempt: false }),
    ).toBe(false);
    expect(
      isEligibleTrainingObservation({ ...trainable, executionChannel: "demo" }),
    ).toBe(false);
    expect(
      isEligibleTrainingObservation({ ...trainable, artifactSubmittedBy: "user" }),
    ).toBe(false);
  });
});
