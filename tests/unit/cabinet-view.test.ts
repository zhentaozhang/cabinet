import { describe, expect, it } from "vitest";
import { agentHeadcount, tasksPerAgent } from "@/lib/presentation/cabinet-view";

describe("tasksPerAgent", () => {
  it("counts every task of an Agent, including the finished ones", () => {
    const counts = tasksPerAgent([
      { assigneeId: "ag_one" },
      { assigneeId: "ag_one" },
      { assigneeId: "ag_one" },
      { assigneeId: "ag_two" },
      { assigneeId: null },
    ]);

    // The status is deliberately not an input: "N 个任务" is a total, and the
    // pass/fail counters printed beside it are totals too.
    expect(counts.get("ag_one")).toBe(3);
    expect(counts.get("ag_two")).toBe(1);
    expect(counts.has("")).toBe(false);
    expect(counts.size).toBe(2);
  });
});
describe("agentHeadcount", () => {
  it("does not count a retired Agent as still growing", () => {
    // `retireAgent` writes status="retired" and lifecycleStage="retired" at
    // once, so `lifecycleStage !== "active"` used to sweep them into "成长中"
    // while the card below showed the badge 已退休.
    const counts = agentHeadcount([
      { status: "active", lifecycleStage: "active" },
      { status: "probation", lifecycleStage: "shadowing" },
      { status: "retired", lifecycleStage: "retired" },
    ]);

    expect(counts).toEqual({ total: 3, onDuty: 1, growing: 1, retired: 1 });
  });
});
