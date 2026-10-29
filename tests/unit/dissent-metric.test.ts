import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  dissentConditionText,
  dissentValueText,
} from "@/lib/domain/dissent-metric";

const ROOT = process.cwd();
function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("dissent condition wording", () => {
  /**
   * 复盘页原来把 metric / operator / threshold 三个字段原样印出来：
   * 种子里 threshold 48000 的 `budget_spend_cents` 显示成
   * `budget_spend_cents >= 48000 · 7 天`——一个内部键，加上把 ¥480 说成 48000 的单位错误。
   */
  it("prints a budget threshold as money instead of cents", () => {
    const text = dissentConditionText({
      metric: "budget_spend_cents",
      operator: ">=",
      threshold: 48000,
      windowDays: 7,
    });
    expect(text).toBe("7 天内支出 ≥ ¥480.00");
    expect(text).not.toContain("48000");
    expect(text).not.toContain("budget_spend_cents");
  });

  it("gives every counted metric a Chinese noun and unit", () => {
    expect(
      dissentConditionText({
        metric: "audit_reject_count",
        operator: ">=",
        threshold: 2,
        windowDays: 7,
      }),
    ).toBe("7 天内驳回 ≥ 2 次");
    expect(
      dissentConditionText({
        metric: "task_failure_count",
        operator: ">",
        threshold: 1,
        windowDays: 3,
      }),
    ).toBe("3 天内失败任务 > 1 个");
    expect(
      dissentConditionText({
        metric: "agent_paused",
        operator: "==",
        threshold: 1,
        windowDays: 7,
      }),
    ).toBe("7 天内暂停 = 1 次");
  });

  it("falls back to the raw key instead of inventing a translation", () => {
    expect(
      dissentConditionText({
        metric: "custom_metric",
        operator: "==",
        threshold: 3,
        windowDays: 7,
      }),
    ).toBe("7 天内 custom_metric = 3");
  });

  it("formats the measured value with the same units as the threshold", () => {
    expect(dissentValueText("budget_spend_cents", 52000)).toBe("¥520.00");
    expect(dissentValueText("audit_reject_count", 2)).toBe("2 次");
    expect(dissentValueText("task_failure_count", 1)).toBe("1 个");
    expect(dissentValueText("custom_metric", 3)).toBe("3");
  });

  /**
   * 判例记忆与证据引文由命令层写，条件句由页面读：两处都必须是这一套词，
   * 否则同一条异议在复盘页与记忆里各说各的。
   */
  it("is the only place that renders a condition", () => {
    const page = read("src/app/review/page.tsx");
    expect(page).toContain("dissentConditionText(dissent.condition)");
    expect(page).not.toContain("dissent.condition.metric}");
    const command = read("src/server/services/commands/council/dissent.ts");
    expect(command).toContain("dissentConditionText(dissent.condition)");
    expect(command).toContain("dissentValueText(dissent.condition.metric, value)");
    expect(command).not.toContain(dissentConditionRawMarker());
  });
});

/** 旧口径留在命令层里的那句「阈值 ${operator} ${threshold}」。 */
function dissentConditionRawMarker(): string {
  return ["阈值 ", "$", "{dissent.condition.operator}"].join("");
}