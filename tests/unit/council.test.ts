import { describe, expect, it } from "vitest";
import { SEED_POLICY_CONFIG } from "@/lib/domain/policy";
import {
  buildCouncilMatrix,
  buildCouncilMemo,
  computePositionScores,
} from "@/lib/domain/council";

const config = SEED_POLICY_CONFIG.council;

describe("council scoring", () => {
  it("keeps every score inside 0..100", () => {
    const scores = computePositionScores(
      {
        goalProgress: 120,
        trustScore: -20,
        budgetSpentRatio: 2,
        evidenceCount: 10,
        rejectStreak: 20,
        paused: true,
      },
      config,
    );

    for (const value of Object.values(scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("rewards evidence and penalizes budget pressure", () => {
    const low = computePositionScores(
      {
        goalProgress: 50,
        trustScore: 50,
        budgetSpentRatio: 0,
        evidenceCount: 1,
        rejectStreak: 0,
        paused: false,
      },
      config,
    );
    const high = computePositionScores(
      {
        goalProgress: 50,
        trustScore: 50,
        budgetSpentRatio: 1,
        evidenceCount: 4,
        rejectStreak: 0,
        paused: false,
      },
      config,
    );

    expect(high.evidenceQuality).toBeGreaterThan(low.evidenceQuality);
    expect(high.costEfficiency).toBeLessThan(low.costEfficiency);
  });

  it("weights roles and counts dissent without a hidden majority rule", () => {
    const matrix = buildCouncilMatrix(
      [
        {
          agentId: "a",
          role: "chief",
          stance: "support",
          scores: {
            feasibility: 90,
            costEfficiency: 90,
            evidenceQuality: 90,
            robustness: 90,
          },
        },
        {
          agentId: "b",
          role: "critic",
          stance: "oppose",
          scores: {
            feasibility: 20,
            costEfficiency: 20,
            evidenceQuality: 20,
            robustness: 20,
          },
        },
        {
          agentId: "c",
          role: "coach",
          stance: "neutral",
          scores: {
            feasibility: 50,
            costEfficiency: 50,
            evidenceQuality: 50,
            robustness: 50,
          },
        },
      ],
      config,
    );

    expect(matrix.support).toBe(1);
    expect(matrix.oppose).toBe(1);
    expect(matrix.neutral).toBe(1);
    expect(matrix.consensus).toBe("split");
    expect(matrix.dissentAgentIds).toEqual(["b"]);
    expect(matrix.overall).toBeGreaterThan(0);
    expect(matrix.overall).toBeLessThan(100);
  });
});

describe("council memo", () => {
  it("renders positions, matrix and dissent", () => {
    const positions = [
      {
        agentId: "a",
        agentName: "Atlas",
        agentTitle: "Chief",
        role: "chief",
        stance: "support" as const,
        claim: "推进。",
        evidence: [{ label: "目标", ref: "goal:g1" }],
        risk: "排期。",
        recommendation: "批准。",
        scores: {
          feasibility: 80,
          costEfficiency: 80,
          evidenceQuality: 80,
          robustness: 80,
        },
      },
      {
        agentId: "b",
        agentName: "Cass",
        agentTitle: "Critic",
        role: "critic",
        stance: "oppose" as const,
        claim: "反对。",
        evidence: [{ label: "驳回", ref: "audit:a1" }],
        risk: "会重蹈覆辙。",
        recommendation: "先验证。",
        scores: {
          feasibility: 30,
          costEfficiency: 30,
          evidenceQuality: 30,
          robustness: 30,
        },
      },
    ];

    const matrix = buildCouncilMatrix(positions, config);
    const memo = buildCouncilMemo({
      topic: "测试议题",
      trigger: "测试触发",
      positions,
      matrix,
    });

    expect(memo).toContain("测试议题");
    expect(memo).toContain("内阁矩阵");
    expect(memo).toContain("Atlas");
    expect(memo).toContain("会重蹈覆辙");
  });
});
