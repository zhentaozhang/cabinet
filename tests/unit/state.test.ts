import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminal,
} from "@/lib/domain/state";
import { ConflictError } from "@/lib/domain/errors";

describe("task state machine", () => {
  it.each([
    ["planned", "assigned"],
    ["planned", "suggested"],
    ["assigned", "running"],
    ["assigned", "awaiting_approval"],
    ["awaiting_approval", "approved"],
    ["approved", "running"],
    ["running", "submitted"],
    ["submitted", "auditing"],
    ["auditing", "accepted"],
    ["auditing", "rejected"],
    ["rejected", "running"],
    ["accepted", "done"],
  ])("allows %s → %s", (from, to) => {
    expect(canTransition("task", from, to)).toBe(true);
  });

  it.each([
    ["planned", "accepted"],
    ["accepted", "running"],
    ["done", "running"],
    ["rejected", "accepted"],
    ["awaiting_approval", "running"],
    ["cancelled", "planned"],
  ])("rejects %s → %s", (from, to) => {
    expect(canTransition("task", from, to)).toBe(false);
  });

  it("throws ConflictError for invalid transitions", () => {
    expect(() => assertTransition("task", "planned", "accepted")).toThrow(
      ConflictError,
    );
  });

  it("detects terminal states", () => {
    expect(isTerminal("task", "done")).toBe(true);
    expect(isTerminal("task", "failed")).toBe(false);
    expect(isTerminal("task", "running")).toBe(false);
  });
});

describe("agent / insight / approval state machines", () => {
  it("allows probation → active and active → paused", () => {
    expect(canTransition("agent", "probation", "active")).toBe(true);
    expect(canTransition("agent", "active", "paused")).toBe(true);
    expect(canTransition("agent", "paused", "active")).toBe(true);
  });

  it("does not allow retired agents to return", () => {
    expect(canTransition("agent", "retired", "active")).toBe(false);
  });

  it("does not allow proposed insights to roll back", () => {
    expect(canTransition("insight", "proposed", "rolled_back")).toBe(false);
    expect(canTransition("insight", "applied", "rolled_back")).toBe(true);
  });

  it("does not allow decided approvals to be re-decided", () => {
    expect(canTransition("approval", "approved", "rejected")).toBe(false);
    expect(canTransition("approval", "pending", "approved")).toBe(true);
  });

  it("allows pending dissents to resolve exactly once", () => {
    expect(canTransition("dissent", "pending", "vindicated")).toBe(true);
    expect(canTransition("dissent", "pending", "invalidated")).toBe(true);
    expect(canTransition("dissent", "vindicated", "invalidated")).toBe(false);
    expect(canTransition("dissent", "invalidated", "vindicated")).toBe(false);
  });
});
