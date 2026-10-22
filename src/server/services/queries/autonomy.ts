import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { getPolicyConfig } from "@/lib/policy/config";
import { decideUpgrade, type UpgradeDecision } from "@/lib/domain/policy";
import { ConflictError, NotFoundError } from "@/lib/domain/errors";
import { loadAuditWindow } from "./audit-samples";

export type AutonomyUpgradeResult = {
  allowed: boolean;
  /** Target level the decision was evaluated for. */
  level: number;
  code: UpgradeDecision["code"];
  reason: string;
  /** Eligible audit samples behind the pass rate. */
  samples: number;
  passRate: number;
};

function toUpgradeResult(
  targetLevel: number,
  decision: UpgradeDecision,
): AutonomyUpgradeResult {
  return {
    allowed: decision.effect !== "deny",
    level: targetLevel,
    code: decision.code,
    reason: decision.reason,
    samples: decision.samples,
    passRate: decision.passRate,
  };
}

/**
 * The single authority for "may this Agent be promoted?".
 *
 * The Review page and the command path both call this, so a badge can never
 * disagree with the write. `tx` lets the promotion path evaluate under the same
 * row lock it writes with.
 */
export async function evaluateAutonomyUpgrade(
  agentId: string,
  targetLevel: number,
  userId: string,
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<AutonomyUpgradeResult> {
  const client = tx ?? db;
  const [agent] = await client
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));
  if (!agent) throw new NotFoundError("Agent not found");
  if (targetLevel < 0 || targetLevel > 3) {
    throw new ConflictError("Invalid autonomy level");
  }

  const config = await getPolicyConfig();
  const window = await loadAuditWindow(
    agent.id,
    userId,
    config.audit.passRateWindow,
    tx,
  );
  const decision = decideUpgrade({
    actor: {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      lifecycleStage: agent.lifecycleStage,
      autonomyLevel: agent.autonomyLevel,
      trustScore: agent.trustScore,
      successCount: agent.successCount,
    },
    targetLevel,
    auditPassRate: window.passRate,
    auditSamples: window.eligibleSamples.length,
    config,
  });
  return toUpgradeResult(targetLevel, decision);
}

/** Evaluate every on-duty Agent once, for the Review page. */
export async function loadAutonomyDecisions(
  userId: string,
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
  nextLevelOffset = 1,
): Promise<Record<string, AutonomyUpgradeResult>> {
  const client = tx ?? db;
  const rows = await client
    .select({
      id: agents.id,
      autonomyLevel: agents.autonomyLevel,
    })
    .from(agents)
    .where(eq(agents.userId, userId));

  const entries = await Promise.all(
    rows.map(async (row) => [
      row.id,
      await evaluateAutonomyUpgrade(
        row.id,
        // Promotions are only meaningful one rung at a time.
        Math.min(row.autonomyLevel + nextLevelOffset, 3),
        userId,
        tx,
      ),
    ] as const),
  );
  return Object.fromEntries(entries);
}
