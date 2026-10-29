import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  councilPositions,
  councils,
} from "@/lib/db/schema";
import type { CouncilMatrix } from "@/lib/db/schema";
import { logAuditTx } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { buildCouncilMatrix, buildCouncilMemo } from "@/lib/domain/council";
import type { CouncilPositionDraft } from "@/lib/domain/council";
import { ValidationError } from "@/lib/domain/errors";
import {
  assertEvidenceRefs,
  councilConditionForRole,
  loadCouncilContext,
} from "./context";
import { buildCouncilPosition } from "./positions";

export async function createCouncil(
  input: {
    topic: string;
    trigger: string;
  },
  userId: string,
) {
  const topic = input.topic.trim();
  const trigger = input.trigger.trim();
  if (!topic || !trigger) {
    throw new ValidationError("Topic and trigger are required.");
  }

  // 用户级配置：critic 的证伪条件用的是 audit.rejectStreakLimit，而那是洞察
  // 采纳白名单里的键（audit.ts 自己也是按 getPolicyConfigFor 判暂停的）。这里
  // 读全局默认，会议就会替你写下一个和别人不一样的门槛：复盘页写着「>= 2 次
  // 驳回即证伪」，而你的 Agent 到第 5 次才停。
  const config = await getPolicyConfigFor(userId);
  const context = await loadCouncilContext(userId, topic);
  const id = newId("ccl");

  await db.insert(councils).values({
    id,
    userId,
    topic,
    trigger,
    status: "deliberating",
    memo: `## 议题\n${topic}\n\n## 触发\n${trigger}\n\n## 状态\n各方立场正在按规则生成。`,
  });

  let positions: CouncilPositionDraft[];
  let matrix: CouncilMatrix;
  let memo: string;

  try {
    const roles = [
      "chief",
      "researcher",
      "coach",
      "treasurer",
      "critic",
    ] as const;
    const drafts = await Promise.all(
      roles.map(async (role) =>
        buildCouncilPosition({ role, context, config, topic }),
      ),
    );
    positions = drafts.filter(
      (draft): draft is CouncilPositionDraft => draft !== null,
    );
    if (positions.length < config.council.minPositions) {
      throw new ValidationError(
        `Council needs at least ${config.council.minPositions} agents; found ${positions.length}.`,
      );
    }
    await assertEvidenceRefs(userId, positions);
    matrix = buildCouncilMatrix(
      positions.map((position) => ({
        agentId: position.agentId,
        role: position.role,
        stance: position.stance,
        scores: position.scores,
      })),
      config.council,
    );
    memo = buildCouncilMemo({ topic, trigger, positions, matrix });
  } catch (error) {
    await db
      .update(councils)
      .set({
        status: "degraded",
        memo: `## 议题\n${topic}\n\n## 触发\n${trigger}\n\n## 状态\n立场生成失败：${
          error instanceof Error ? error.message : "unknown error"
        }`,
      })
      .where(eq(councils.id, id));
    throw error;
  }

  await db.transaction(async (tx) => {
    await tx.insert(councilPositions).values(
      positions.map((position) => ({
        id: newId("cps"),
        councilId: id,
        agentId: position.agentId,
        stance: position.stance,
        claim: position.claim,
        evidence: position.evidence,
        risk: position.risk,
        recommendation: position.recommendation,
        scores: position.scores,
        isDissent: position.stance === "oppose",
        falsificationCondition:
          position.stance === "oppose"
            ? councilConditionForRole(position.role, config)
            : null,
      })),
    );
    await tx
      .update(councils)
      .set({ status: "open", matrix, memo })
      .where(eq(councils.id, id));

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "council.create",
      target: id,
      before: null,
      after: {
        topic,
        trigger,
        positions: positions.length,
        matrix,
      },
    });
  });

  const [created] = await db
    .select()
    .from(councils)
    .where(eq(councils.id, id));

  return created;
}
