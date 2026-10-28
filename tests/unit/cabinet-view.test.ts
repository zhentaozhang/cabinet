import { describe, expect, it } from "vitest";
import { tasksPerAgent } from "@/lib/presentation/cabinet-view";

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
