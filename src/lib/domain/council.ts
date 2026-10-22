import type {
  CouncilMatrix,
  CouncilScore,
  Evidence,
} from "@/lib/db/schema";
import type { CouncilConfig } from "@/lib/domain/policy";

export type CouncilStance = "support" | "oppose" | "neutral";

export type CouncilPositionDraft = {
  agentId: string;
  agentName: string;
  agentTitle: string;
  role: string;
  stance: CouncilStance;
  claim: string;
  evidence: Evidence[];
  risk: string;
  recommendation: string;
  scores: CouncilScore;
};

export type CouncilScoreInput = {
  goalProgress: number;
  trustScore: number;
  budgetSpentRatio: number;
  evidenceCount: number;
  rejectStreak: number;
  paused: boolean;
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function computePositionScores(
  input: CouncilScoreInput,
  config: CouncilConfig,
): CouncilScore {
  const { score } = config;
  return {
    feasibility: clamp(
      score.base +
        (input.goalProgress - score.base) * score.goalWeight +
        (input.trustScore - score.base) * score.trustWeight -
        input.rejectStreak * score.rejectPenalty,
    ),
    costEfficiency: clamp(
      100 - input.budgetSpentRatio * score.budgetPressureWeight,
    ),
    evidenceQuality: clamp(input.evidenceCount * score.evidencePoints),
    robustness: clamp(
      100 -
        input.rejectStreak * score.rejectPenalty -
        (input.paused ? score.pausePenalty : 0),
    ),
  };
}

export function buildCouncilMatrix(
  positions: Array<{
    agentId: string;
    role: string;
    stance: CouncilStance;
    scores: CouncilScore;
  }>,
  config: CouncilConfig,
): CouncilMatrix {
  const dimensions: CouncilScore = {
    feasibility: 0,
    costEfficiency: 0,
    evidenceQuality: 0,
    robustness: 0,
  };

  let roleWeightTotal = 0;
  for (const position of positions) {
    const weight = config.roleWeights[position.role] ?? 1;
    roleWeightTotal += weight;
    for (const key of Object.keys(dimensions) as Array<keyof CouncilScore>) {
      dimensions[key] += position.scores[key] * weight;
    }
  }

  if (roleWeightTotal > 0) {
    for (const key of Object.keys(dimensions) as Array<keyof CouncilScore>) {
      dimensions[key] = Math.round(dimensions[key] / roleWeightTotal);
    }
  }

  const overall = Math.round(
    dimensions.feasibility * config.dimensionWeights.feasibility +
      dimensions.costEfficiency * config.dimensionWeights.costEfficiency +
      dimensions.evidenceQuality * config.dimensionWeights.evidenceQuality +
      dimensions.robustness * config.dimensionWeights.robustness,
  );

  const support = positions.filter((p) => p.stance === "support").length;
  const oppose = positions.filter((p) => p.stance === "oppose").length;
  const neutral = positions.length - support - oppose;

  return {
    dimensions,
    overall,
    support,
    oppose,
    neutral,
    consensus:
      support > oppose ? "support" : oppose > support ? "oppose" : "split",
    dissentAgentIds: positions
      .filter((p) => p.stance === "oppose")
      .map((p) => p.agentId),
  };
}

export function buildCouncilMemo(input: {
  topic: string;
  trigger: string;
  positions: CouncilPositionDraft[];
  matrix: CouncilMatrix;
}): string {
  const { topic, trigger, positions, matrix } = input;
  const labels: Record<keyof CouncilScore, string> = {
    feasibility: "可行性",
    costEfficiency: "成本效率",
    evidenceQuality: "证据质量",
    robustness: "抗风险",
  };

  const rows = (Object.keys(labels) as Array<keyof CouncilScore>)
    .map((key) => `| ${labels[key]} | ${matrix.dimensions[key]} |`)
    .join("\n");

  const summary = positions
    .map(
      (position) =>
        `- **${position.agentName}**（${position.role}）：${position.claim}`,
    )
    .join("\n");

  const dissent = positions.filter((position) => position.stance === "oppose");
  const dissentText =
    dissent.length === 0
      ? "无正式反对立场。"
      : dissent
          .map(
            (position) =>
              `- **${position.agentName}**：${position.risk} 建议：${position.recommendation}`,
          )
          .join("\n");

  const tendency =
    matrix.consensus === "support"
      ? "倾向推进"
      : matrix.consensus === "oppose"
        ? "倾向否决"
        : "内阁分裂，需要你裁决";

  return `## 议题
${topic}

## 触发
${trigger}

## 内阁矩阵
| 维度 | 得分 |
| --- | --- |
${rows}

综合健康度：**${matrix.overall} / 100** · 支持 ${matrix.support} / 反对 ${matrix.oppose} / 中立 ${matrix.neutral}

## 立场摘要
${summary}

## 异议
${dissentText}

## 结论
${tendency}。矩阵不是投票结果，最终决定由你做出。`;
}
