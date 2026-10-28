import { describe, expect, it } from "vitest";

import { COUNCIL_RULES } from "@/lib/presentation/council-view";

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
    // council-actions.tsx 在 reject 且 note 为空时直接 return。
    const copy = COUNCIL_RULES.join(" ");
    expect(copy).toContain("必须给证据");
    expect(copy).toContain("必须留下理由");
  });
});
