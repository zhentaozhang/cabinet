import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  APPRENTICE_RETIRED_NOTICE,
  agentHeadcount,
  agentPassRate,
  apprenticeTrainingOpen,
  weeklyBudgetFieldHint,
  escalationPolicyLine,
  tasksPerAgent,
  upgradeRequirementsLine,
} from "@/lib/presentation/cabinet-view";

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

describe("escalationPolicyLine", () => {
  it("prints the limit it is given instead of a hardcoded 2", () => {
    // `audit.rejectStreakLimit` 在洞察的覆盖白名单里（1–20），用户调到 5 之后
    // 制度栏还写「连续 2 次驳回」就是在承诺一个后端不再执行的阈值。
    expect(escalationPolicyLine(5)).toContain("连续驳回 5 次");
    expect(escalationPolicyLine(5)).not.toContain("连续 2 次驳回");
    expect(escalationPolicyLine(1)).toContain("连续驳回 1 次");
  });

  it("says what actually happens: the Agent pauses, retirement is the user's call", () => {
    // 代码里既没有「换人」也没有自动退休评估（audit.ts 只把 Agent 置为
    // paused 并记一条 agent.paused），复盘页的「考虑退休」是另一个判据
    // （驳回次数多于通过次数），与这个上限无关。
    const line = escalationPolicyLine(2);
    expect(line).toContain("暂停这个 Agent");
    expect(line).not.toContain("换人");
    expect(line).not.toContain("进入退休评估");
  });

  it("never prints a limit below 1, whatever the row holds", () => {
    // 覆盖值理论上被 validation 收在 1–20，但页面用的是从 API 反序列化的
    // 数字：0 或 NaN 会让这句话读成「连续驳回 0 次」，比不写更糟。
    expect(escalationPolicyLine(0)).toContain("连续驳回 1 次");
    expect(escalationPolicyLine(Number.NaN)).toContain("连续驳回 1 次");
  });
});
describe("upgradeRequirementsLine", () => {
  it("prints the pass-rate floor the runtime actually enforces", () => {
    // decideUpgrade 的最后一道闸是审计通过率 ≥ config.autonomy.minAuditPassRate
    // （默认 0.9）。原本文案只列了信任分/成功任务/样本数/非试用期四条，
    // 有人把这四条全做到、通过率只有一半时升级会被拒，而页面从没提过。
    const line = upgradeRequirementsLine({
      minTrust: 70,
      minSuccesses: 3,
      minAuditSamples: 5,
      minAuditPassRate: 0.9,
    });
    expect(line).toContain("信任分 ≥70");
    expect(line).toContain("成功任务 ≥3");
    expect(line).toContain("有效审计样本 ≥5");
    expect(line).toContain("审计通过率 ≥90%");
  });

  it("follows the config instead of a copy of its defaults", () => {
    // 四个数都是调用方传进来的门槛，不是页面自带的常量。
    const line = upgradeRequirementsLine({
      minTrust: 85,
      minSuccesses: 6,
      minAuditSamples: 12,
      minAuditPassRate: 0.5,
    });
    expect(line).toContain("信任分 ≥85");
    expect(line).toContain("审计通过率 ≥50%");
    expect(line).not.toContain("≥70");
  });

  it("keeps a non-finite rate inside 0–100", () => {
    // 从 API 反序列化来的数字可能是 NaN：那句话会读成「审计通过率 ≥100%」，
    // 谁也过不了。
    const line = upgradeRequirementsLine({
      minTrust: Number.NaN,
      minSuccesses: 3,
      minAuditSamples: 5,
      minAuditPassRate: 1.4,
    });
    expect(line).toContain("审计通过率 ≥100%");
    expect(line).toContain("信任分 ≥0");
  });
});

describe("agentPassRate", () => {
  it("prints an em dash instead of 0% when nothing has been judged", () => {
    // 同一个 0/0 在复盘页写的是「还没有验收记录」（src/app/review/page.tsx），
    // Agent 详情页却印成「0%」，读起来像「验收全都没过」。没有判定过就没有通过率。
    const empty = agentPassRate({ successCount: 0, failCount: 0 });
    expect(empty.value).toBe("—");
    expect(empty.hint).toBe("还没有验收记录");
  });

  it("rounds a real verdict history to a whole percent", () => {
    const rate = agentPassRate({ successCount: 3, failCount: 1 });
    expect(rate.value).toBe("75%");
    expect(rate.hint).toBe("验收通过率");
    expect(agentPassRate({ successCount: 2, failCount: 1 }).value).toBe("67%");
  });

  it("treats a broken counter as no evidence, not as a pass rate", () => {
    const broken = agentPassRate({ successCount: Number.NaN, failCount: -3 });
    expect(broken.value).toBe("—");
    expect(broken.hint).toBe("还没有验收记录");
  });
});


describe("the Agent list renders the same pass-rate readout as the detail page", () => {
  const page = readFileSync(join(process.cwd(), "src/app/cabinet/page.tsx"), "utf8");

  it("does not compute its own percentage from the raw counters", () => {
    // 列表页原本有一份 local successRate：0 通过 / 0 驳回时返回 0，卡片上印「0%」，
    // 而同一个 Agent 的详情页与复盘页都说「还没有验收记录」。0/0 不是一个比例，
    // 新工作区里 7 个 Agent 全都会显示成「验收全没过」。
    expect(page).toContain("agentPassRate(");
    expect(page).not.toMatch(/function\s+successRate/);
    expect(page).not.toContain(`{rate}%`);
  });
});

describe("weeklyBudgetFieldHint", () => {
  it("says what a zero per-Agent cap actually means", () => {
    // periodLimitCents 把 0 读成「不单独设上限、跟着策略默认上限」——最宽的额度，
    // 与「填 0 让它别花钱」的直觉相反。模板里 chief / treasurer / auditor / critic
    // 四个角色的 budgetCents 就是 0，新建工作区后这个框里显示「0」，
    // 旁边的绩效卡却印着「上限 ¥600.00」。
    const hint = weeklyBudgetFieldHint({ budgetCents: 0, limitCents: 60000 });
    expect(hint).toContain("不单独给这个 Agent 设上限");
    expect(hint).toContain("¥600.00");
    expect(hint).toContain("策略默认上限");
  });

  it("reports whichever cap is actually enforced this week", () => {
    const own = weeklyBudgetFieldHint({ budgetCents: 3000, limitCents: 3000 });
    expect(own).toContain("¥30.00");
    const capped = weeklyBudgetFieldHint({ budgetCents: 90000, limitCents: 60000 });
    expect(capped).toContain("策略默认上限比填的数低");
    expect(capped).toContain("¥600.00");
  });

  it("never prints NaN for a broken number", () => {
    const hint = weeklyBudgetFieldHint({
      budgetCents: Number.NaN,
      limitCents: Number.NaN,
    });
    expect(hint).not.toContain("NaN");
    expect(hint).toContain("¥0.00");
  });
});

describe("the budget box does not save a cleared field as a permission", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/actions/agent-actions.tsx"),
    "utf8",
  );

  it("parses the amount instead of coercing an empty box to zero", () => {
    // 原来的写法是 Math.round(Number(budgetYuan) * 100)：清空输入框后 Number("") === 0，
    // 保存下去正好等于「不单独设上限」——用户以为删掉了上限，实际把额度放到策略默认值。
    expect(source).toContain("yuanToCents(");
    expect(source).not.toContain("Math.round(Number(budgetYuan)");
    expect(source).toContain("if (cents === null)");
  });

  it("explains the field with the cap the page actually enforces", () => {
    expect(source).toContain("weeklyBudgetFieldHint(");
    expect(source).toContain("limitCents,");
    const page = readFileSync(
      join(process.cwd(), "src/app/cabinet/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("limitCents={budget.limitCents}");
  });
});
describe("apprenticeTrainingOpen", () => {
  it("keeps the training controls while the apprentice is still in training", () => {
    // shadowing → drafting → examining 是练习阶段；这三个阶段后端都还真能记录观摩 / 考试。
    expect(apprenticeTrainingOpen("shadowing")).toBe(true);
    expect(apprenticeTrainingOpen("drafting")).toBe(true);
    expect(apprenticeTrainingOpen("examining")).toBe(true);
  });

  it("hides them once there is nothing left to do", () => {
    // active = 已转正，practice_passed = 只剩转正这一个动作。
    expect(apprenticeTrainingOpen("active")).toBe(false);
    expect(apprenticeTrainingOpen("practice_passed")).toBe(false);
    // retired：记录观摩抛「已退休的学徒不能再记录观摩。」、考试抛
    // 「Apprentice is retired and cannot take the exam.」——入口留着就只是两个必然失败的按钮。
    expect(apprenticeTrainingOpen("retired")).toBe(false);
  });
});

describe("the retired apprentice page offers no dead buttons", () => {
  const page = readFileSync(
    join(process.cwd(), "src/app/cabinet/[id]/page.tsx"),
    "utf8",
  );

  it("gates both controls on the lifecycle stage", () => {
    expect(page).toContain("apprenticeTrainingOpen(agent.lifecycleStage)");
    // 原来这里是手写的不等式，正好漏掉了 retired。
    expect(page).not.toContain('agent.lifecycleStage !== "active" &&');
    // 两个入口都必须落在 trainingOpen 里：把条件改回旧写法就会重新出现。
    const gate = page.indexOf("{trainingOpen ? (");
    expect(gate).toBeGreaterThan(-1);
    expect(page.indexOf("<ObservationRecorder")).toBeGreaterThan(gate);
    expect(page.indexOf("<ExamButton />")).toBeGreaterThan(gate);
  });

  it("says it is retired instead of staying silent", () => {
    expect(page).toContain("{APPRENTICE_RETIRED_NOTICE}");
    expect(APPRENTICE_RETIRED_NOTICE).toContain("已退休");
    expect(APPRENTICE_RETIRED_NOTICE).toContain("不再接单");
  });
});
