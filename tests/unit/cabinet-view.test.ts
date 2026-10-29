import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  AGENT_LEDGER_NOTE,
  APPRENTICE_RETIRED_NOTICE,
  GRADUATION_EVIDENCE_GAP,
  agentHeadcount,
  agentPassRate,
  apprenticeTrainingOpen,
  budgetPeriodLabel,
  capabilityNote,
  examStatusLabel,
  skillRecordLine,
  skillStatusLabel,
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

describe("the practice-passed page does not promise evidence it cannot get", () => {
  const page = readFileSync(
    join(process.cwd(), "src/app/cabinet/[id]/page.tsx"),
    "utf8",
  );

  it("names the gap between the graduation floor and what a trainee may do", () => {
    // decideRun 在 lifecycleStage !== "active" 处直接 deny，学徒授权又只有 task:read，
    // 所以「真实审计样本」永远不会因为派单而出现。
    expect(GRADUATION_EVIDENCE_GAP).toContain("接不了单");
    expect(GRADUATION_EVIDENCE_GAP).toContain("受监督执行");
    expect(GRADUATION_EVIDENCE_GAP).toContain("唯一能走通的出口是退休");
  });

  it("prints it beside the graduation button", () => {
    const promise = page.indexOf("转正改看真实证据");
    const note = page.indexOf("{GRADUATION_EVIDENCE_GAP}");
    const button = page.indexOf("<GraduateButton />");
    expect(promise).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(promise);
    expect(button).toBeGreaterThan(note);
  });
});

describe("the skill card uses the skill's own words", () => {
  it("never calls a skill 在岗", () => {
    // statusLabel 的 active 是 Agent 的「在岗」；技能转正后 status 也是 active，
    // 直接复用就会把一份技能印成一位在岗的同事。
    expect(skillStatusLabel("draft")).toBe("技能草案");
    expect(skillStatusLabel("active")).toBe("已转正");
    expect(skillStatusLabel("active")).not.toContain("在岗");
    // 未知状态原样返回，别替它编一个词。
    expect(skillStatusLabel("archived")).toBe("archived");
  });

  it("translates the exam status instead of printing the key", () => {
    expect(examStatusLabel("not_started")).toBe("还没考过");
    expect(examStatusLabel("practice_passed")).toBe("练习通过");
    expect(examStatusLabel("failed")).toBe("未通过");
    expect(examStatusLabel("failed")).not.toContain("failed");
    // skills.eval 是 jsonb，行上可能没有这个字段；setup 和种子写的是 not_started。
    expect(examStatusLabel(undefined)).toBe("还没考过");
    expect(examStatusLabel(null)).toBe("还没考过");
  });
});

describe("the skill card does not score a skill nobody has run", () => {
  it("shows the version and nothing else while there is no record", () => {
    // skills.success_count 没有任何写入面（apprentice.ts 只写 failCount 与 eval），
    // 所以「0 通过」不是零分，是没人记过；失败次数 0 也不该印。
    expect(skillRecordLine({ version: 1, failCount: 0 })).toBe("v1");
    expect(skillRecordLine({ version: 1, failCount: 0 })).not.toContain("通过");
  });

  it("names the exam when an attempt failed", () => {
    const line = skillRecordLine({ version: 1, failCount: 1 });
    expect(line).toContain("结业考试失败 1 次");
    expect(line).not.toContain("通过");
  });

  it("does not print NaN or a negative count", () => {
    expect(skillRecordLine({ version: Number.NaN, failCount: 0 })).toBe("v1");
    expect(skillRecordLine({ version: 2, failCount: -3 })).toBe("v2");
    expect(skillRecordLine({ version: 2, failCount: Number.NaN })).toBe("v2");
  });
});

describe("the skill card prints no internal keys", () => {
  const page = readFileSync(
    join(process.cwd(), "src/app/cabinet/[id]/page.tsx"),
    "utf8",
  );

  it("feeds the badge and the exam line from the helpers", () => {
    expect(page).toContain("{skillStatusLabel(skill.status)}");
    expect(page).toContain("{examStatusLabel(skill.eval.status)}");
    // statusLabel 会把技能印成「在岗」；String(...) 还会把 null 印成 "null"。
    expect(page).not.toContain("{statusLabel(skill.status)}");
    expect(page).not.toContain("String(skill.eval.status");
    // label 是内部键（draft / practice / v1），转正后与版本号重复。
    expect(page).not.toContain("{skill.label}");
    // 「通过 / 失败」把没有写入面的成功数和只数考试的失败次数当成技能成绩。
    expect(page).toContain("{skillRecordLine(skill)}");
    expect(page).not.toContain("{skill.successCount}");
    expect(page).not.toContain("{skill.failCount}");
  });
});
describe("the budget card describes the ledger it reads", () => {
  it("prints the last day of a half-open period", () => {
    // period_end 是排他的：queries/budget.ts:58 用 addLocalDays(start, 7) 算它，
    // 查询写的是 period_start <= now < period_end（同文件 :44-46）。
    // 02/02 起的一本账到 02/09 00:00 为止，02/09 那一整天属于下一本。
    expect(
      budgetPeriodLabel(
        new Date("2026-02-02T00:00:00+08:00"),
        new Date("2026-02-09T00:00:00+08:00"),
        "Asia/Shanghai",
      ),
    ).toBe("02/02 – 02/08");
  });

  it("keeps the last day right across a month boundary", () => {
    expect(
      budgetPeriodLabel(
        new Date("2026-02-23T00:00:00+08:00"),
        new Date("2026-03-02T00:00:00+08:00"),
        "Asia/Shanghai",
      ),
    ).toBe("02/23 – 03/01");
  });

  it("does not call the ledger model tokens only", () => {
    // 开 MODEL_TOOL_SELECTION 后，模型每选一次 web_search 会按 3 分预留并结算进
    // agent_budget_periods（tool-loop.ts:668-733），那 3 分不是 token 估算。
    expect(AGENT_LEDGER_NOTE).toContain("每周预算台账");
    expect(AGENT_LEDGER_NOTE).toContain("MODEL_TOOL_SELECTION");
    expect(AGENT_LEDGER_NOTE).toContain("3 分");
    expect(AGENT_LEDGER_NOTE).toContain("不要相加");
    expect(AGENT_LEDGER_NOTE).not.toContain("本周模型用量");
  });

  it("feeds the label and the period line from the same place", () => {
    const page = readFileSync(
      join(process.cwd(), "src/app/cabinet/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("{AGENT_LEDGER_NOTE}");
    expect(page).toContain("budgetPeriodLabel(budget.periodStart, budget.periodEnd, tz)");
    expect(page).not.toContain("本周模型用量（");
    expect(page).not.toContain("本周模型用量占预算比例");
  });
});

// 能力矩阵底部那句话。原来只要 implemented 为空就印「声明的工具一个都没接入」，
// 于是两件事被说错：没声明任何工具的 Agent 被说成「声明了但没接入」；
// 声明了 mcp: 工具的 Agent 右上方刚写着「运行期解析」，下面又说它一步也执行不了。
describe("capabilityNote", () => {
  it("stays quiet when a static tool really runs", () => {
    expect(
      capabilityNote({ declared: ["read_notes", "quiz"], implemented: ["web_search"], mcp: [], unknown: [] }),
    ).toBeNull();
  });

  it("says nothing was declared when the list is empty", () => {
    const note = capabilityNote({ declared: [], implemented: [], mcp: [], unknown: [] });
    expect(note).toContain("没有声明任何工具");
    expect(note).not.toContain("一个都没接入");
  });

  it("does not call a runtime-resolved MCP tool unable to run", () => {
    const note = capabilityNote({
      declared: [],
      implemented: [],
      mcp: ["mcp:github:issue_search", "mcp:docs:read"],
      unknown: [],
    });
    expect(note).toContain("运行期");
    expect(note).not.toContain("只能靠模型自身能力干活");
  });

  it("keeps the plain sentence for declared-only rosters", () => {
    const note = capabilityNote({
      declared: ["read_notes", "quiz", "dispatch"],
      implemented: [],
      mcp: [],
      unknown: [],
    });
    expect(note).toContain("一个都没接入");
    expect(note).toContain("只能靠模型自身能力干活");
  });

  it("feeds the row from one rule instead of an inline ternary", () => {
    const page = readFileSync(join(process.cwd(), "src/app/cabinet/page.tsx"), "utf8");
    expect(page).toContain("capabilityNote(buckets)");
    expect(page).not.toContain("声明的工具一个都没接入");
  });
});
