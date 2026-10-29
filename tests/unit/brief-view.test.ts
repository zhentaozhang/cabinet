import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  briefFreshness,
  briefGoalLine,
  briefOrderList,
  briefTaskLine,
} from "@/lib/presentation/brief-view";

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
describe("briefFreshness", () => {
  it("leaves today's brief alone", () => {
    const state = briefFreshness({ period: "2026-10-29", todayKey: "2026-10-29" });
    expect(state.stale).toBe(false);
    expect(state.label).toBe("");
    expect(state.note).toBe("");
  });

  it("names the day a rolled-over brief actually belongs to", () => {
    // reviews 按 (userId, type, period) 唯一，regenerateBrief 写的是生成那一刻的
    // 本地日期；首页取的是最近一份 daily，所以跨天没重跑时卡里还是上一份。
    const state = briefFreshness({ period: "2026-10-28", todayKey: "2026-10-29" });
    expect(state.stale).toBe(true);
    expect(state.label).toContain("2026-10-28");
    expect(state.note).toContain("2026-10-28");
    expect(state.note).toContain("今天（2026-10-29）");
    expect(state.note).toContain("重新生成");
  });

  it("does not call an undated brief today's", () => {
    const state = briefFreshness({ period: null, todayKey: "2026-10-29" });
    expect(state.stale).toBe(true);
    expect(state.label).toBe("上一份早报");
    expect(state.note).toContain("没有日期标记");
  });
});

describe("the Today page dates the brief it shows", () => {
  const page = source("src/app/page.tsx");

  it("compares the stored period with the user's today and says so when it lags", () => {
    expect(page).toContain("briefFreshness({");
    expect(page).toContain("localDateKey(new Date(), data.user.timezone)");
    expect(page).toContain("{briefState.stale ?");
    expect(page).toContain("{briefState.label}");
  });
});
