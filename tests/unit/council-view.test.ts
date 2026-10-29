import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  COUNCIL_RULES,
  resolutionDissentLine,
} from "@/lib/presentation/council-view";

/**
 * 内阁页的「会议规则」是对用户的行为承诺，所以测试问的是「这句能不能兑现」。
 * 为了确认它会红，先把 COUNCIL_RULES 换回页面原来那五句跑一遍。
 */
describe("council rules", () => {
  it("does not claim the meeting convenes itself for high-risk decisions", () => {
    // createCouncil 只在用户点「发起会议」时被调用（POST /api/councils），
    // trigger 是用户手填的自由文本；同一页的空状态也写着「自动触发尚未接入」。
    const copy = COUNCIL_RULES.join(" ");
    expect(copy).not.toContain("只在高风险决策时召开");
    expect(copy).toContain("不自动召集");
  });

  it("does not claim a meeting without a dissenting critic is invalid", () => {
    // Critic 的立场确实固定为 oppose，但没有任何地方判「会议无效」：
    // 唯一门槛是 config.council.minPositions（默认 3）的人数。
    const copy = COUNCIL_RULES.join(" ");
    expect(copy).not.toContain("否则会议无效");
    expect(copy).toContain("Critic 的立场固定为反对");
  });

  it("says where the auditor actually stands", () => {
    // create.ts 的 roles 白名单是 chief/researcher/coach/treasurer/critic，
    // Auditor 不在其中——它不是「旁听」，是根本不参加。
    const copy = COUNCIL_RULES.join(" ");
    expect(copy).not.toContain("只旁听");
    expect(copy).toContain("Auditor 不参加内阁");
  });

  it("keeps the rules the command layer really enforces", () => {
    // assertEvidenceRefs + 每个立场分支至少一条 evidence；
    // council-actions.tsx 在 reject / conditions 且 note 为空时直接 return。
    const copy = COUNCIL_RULES.join(" ");
    expect(copy).toContain("必须给证据");
    expect(copy).toContain("必须留下理由");
  });

  it("asks for the conditions behind a conditional approval", async () => {
    // 传「有条件批准」却什么都不写，决议卡会印出一个没有条件的「有条件批准」，
    // 跟进任务的验收标准也没有条件可抄。
    const page = readFileSync(
      join(process.cwd(), "src/components/actions/council-actions.tsx"),
      "utf8",
    );
    expect(page).toContain('decision !== "approve" && !note.trim()');
    expect(page).toContain("有条件批准必须写出条件");
    expect(page).toContain("disabled={busy !== null || !note.trim()}");
    expect(COUNCIL_RULES.join(" ")).toContain("有条件批准");
  });
});

/**
 * 决议卡上那句异议说明也要能兑现：`decideCouncil` 只在批准的路径里插
 * `dissents` 行，所以否决的会议不该说「已归档」。
 */
describe("the dissent line on a decided council", () => {
  it("files dissents only when the decision created a task to observe", () => {
    expect(resolutionDissentLine("approve", 2)).toContain("2 条正式异议已登记");
    expect(resolutionDissentLine("conditions", 1)).toContain("自动判定");
    expect(resolutionDissentLine("approve", 2)).not.toContain("已归档");
  });

  it("does not say a rejected council filed dissents", () => {
    const line = resolutionDissentLine("reject", 2) ?? "";
    expect(line).toContain("2 位 Agent 当时持反对意见");
    expect(line).toContain("没有登记证伪条件");
    expect(line).not.toContain("已登记");
    expect(line).not.toContain("已归档");
  });

  it("says nothing when nobody dissented", () => {
    expect(resolutionDissentLine("approve", 0)).toBeNull();
    expect(resolutionDissentLine("reject", 0)).toBeNull();
  });

  it("renders the line instead of the old fixed sentence", () => {
    const page = readFileSync(
      join(process.cwd(), "src/app/council/page.tsx"),
      "utf8",
    );
    expect(page).toContain("resolutionDissentLine(");
    expect(page).not.toContain("条正式异议已归档");
  });
});