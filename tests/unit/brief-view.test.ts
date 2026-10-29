import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { briefGoalLine, briefOrderList, briefTaskLine } from "@/lib/presentation/brief-view";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("briefGoalLine", () => {
  it("prints the computed percentage for learning goals and a dash for the rest", () => {
    const line = briefGoalLine([
      { title: "6 周学会 RAG", domain: "learning", progress: 62, status: "active" },
      { title: "每周 3 次运动", domain: "health", progress: 60, status: "active" },
    ]);
    expect(line).toBe("6 周学会 RAG（62%） · 每周 3 次运动（—）");
  });

  it("ignores goals that are not in play", () => {
    const line = briefGoalLine([
      { title: "暂停的目标", domain: "learning", progress: 42, status: "paused" },
      { title: "完成的目标", domain: "learning", progress: 100, status: "completed" },
    ]);
    expect(line).toBe("没有进行中的目标");
  });
});

describe("briefTaskLine", () => {
  it("counts only the tasks still in play", () => {
    const line = briefTaskLine([
      { status: "planned", title: "a", estimateMin: 25 },
      { status: "submitted", title: "b", estimateMin: 25 },
      { status: "failed", title: "c", estimateMin: 25 },
      { status: "awaiting_approval", title: "d", estimateMin: 25 },
    ]);
    expect(line).toBe("今天有 2 个待推进任务，优先处理已提交待验收的。");
  });

  it("says there is nothing when every task is waiting or over", () => {
    const line = briefTaskLine([
      { status: "failed", title: "c", estimateMin: 25 },
      { status: "done", title: "e", estimateMin: 25 },
    ]);
    expect(line).toBe("今天没有待推进任务，适合复盘或补弱项。");
  });
});

describe("briefOrderList", () => {
  it("never recommends a task that already failed", () => {
    const list = briefOrderList([
      { status: "failed", title: "失败的那条", estimateMin: 25 },
      { status: "planned", title: "该先做的", estimateMin: 20 },
    ]);
    expect(list).toEqual(["1. 该先做的（20 分钟）"]);
  });
});

describe("both brief writers use these rules", () => {
  it("the service and the Today fallback share the same sentences", () => {
    const service = source("src/server/services/commands/brief.ts");
    const page = source("src/app/page.tsx");
    for (const file of [service, page]) {
      expect(file).toContain("briefGoalLine(");
      expect(file).toContain("briefTaskLine(");
    }
    // 服务端不能自己再 map 一遍目标进度（那份会把非学习目标印成百分比）。
    expect(service).not.toContain("Math.round(g.progress)");
    expect(service).toContain("briefOrderList(");
  });
});