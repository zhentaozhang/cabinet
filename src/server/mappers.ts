import { standingGrantState } from "@/lib/domain/standing-grants";
import type {
  EvidenceRow,
} from "@/lib/db/schema";
import type {
  agentGrants,
  agents,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  dissents,
  goals,
  insights,
  memories,
  profiles,
  reviews,
  runs,
  skills,
  steps,
  tasks,
  users,
} from "@/lib/db/schema";

import type {
  AgentDto,
  ApprovalDto,
  ArtifactDto,
  AuditEventDto,
  BudgetViewDto,
  CheckinDto,
  CouncilDto,
  CouncilPositionDto,
  DissentDto,
  GrantDto,
  RetrievedEvidenceDto,
  GoalDto,
  InsightDto,
  MemoryDto,
  ProfileDto,
  ReviewDto,
  RunDto,
  SkillDto,
  StepDto,
  TaskDto,
  TaskOverrideRecordDto,
  UserDto,
} from "@/contracts";

/**
 * Row → DTO mappers.
 *
 * These are the only functions allowed to touch a database row, and they are
 * what makes the boundary honest: every `Date` becomes an ISO string, every
 * `undefined` becomes `null`, so the payload survives `JSON.stringify` and can
 * be validated against the shared schema on the way out.
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

export function toUserDto(row: typeof users.$inferSelect): UserDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toProfileDto(
  row: typeof profiles.$inferSelect,
): ProfileDto {
  return {
    ...row,
    updatedAt: toIso(row.updatedAt),
  };
}

export function toAgentDto(row: typeof agents.$inferSelect): AgentDto {
  return {
    ...row,
    budgetPeriodStart: toIsoOrNull(row.budgetPeriodStart),
    createdAt: toIso(row.createdAt),
    retiredAt: toIsoOrNull(row.retiredAt),
  };
}

export function toGrantDto(
  row: typeof agentGrants.$inferSelect,
  now = new Date(),
): GrantDto {
  /**
   * A grant with no expiry/budget is a base permission (what the agent may
   * touch). The moment it carries a standing-policy field, its state becomes
   * the thing the user needs to see: live, revoked, expired or used up.
   */
  const isStanding =
    row.createdByApprovalId !== null ||
    row.expiresAt !== null ||
    row.maxRuns !== null;

  const state = isStanding
    ? standingGrantState(
        {
          id: row.id,
          resource: row.resource,
          action: row.action,
          createdByApprovalId: row.createdByApprovalId,
          expiresAt: row.expiresAt,
          maxCents: row.maxCents,
          maxRuns: row.maxRuns,
          useCount: row.useCount,
          revokedAt: row.revokedAt,
        },
        now,
      )
    : "base";

  return {
    id: row.id,
    agentId: row.agentId,
    resource: row.resource,
    scope: row.scope,
    action: row.action,
    label: row.label,
    state,
    createdByApprovalId: row.createdByApprovalId,
    expiresAt: toIsoOrNull(row.expiresAt),
    maxCents: row.maxCents,
    maxRuns: row.maxRuns,
    useCount: row.useCount,
    lastUsedAt: toIsoOrNull(row.lastUsedAt),
    revokedAt: toIsoOrNull(row.revokedAt),
    revokedReason: row.revokedReason,
    createdAt: toIso(row.createdAt),
  };
}

export function toGoalDto(row: typeof goals.$inferSelect): GoalDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

export function toTaskDto(row: typeof tasks.$inferSelect): TaskDto {
  return {
    ...row,
    // `tasks.status` is a text column; `asDto` validates it against the enum,
    // so a value outside the state machine fails the contract test loudly.
    status: row.status as TaskDto["status"],
    dueAt: toIsoOrNull(row.dueAt),
    acceptedAt: toIsoOrNull(row.acceptedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function toRunDto(row: typeof runs.$inferSelect): RunDto {
  return {
    ...row,
    startedAt: toIsoOrNull(row.startedAt),
    endedAt: toIsoOrNull(row.endedAt),
    createdAt: toIso(row.createdAt),
  };
}

/** Ledger row -> DTO. Amounts stay in cents; the page formats them. */
export function toBudgetViewDto(usage: {
  timezone: string;
  periodStart: Date;
  periodEnd: Date;
  limitCents: number;
  reservedCents: number;
  settledCents: number;
  unknownCents: number;
  overrun: boolean;
  legacyUnclassified: boolean;
}): BudgetViewDto {
  return {
    timezone: usage.timezone,
    periodStart: toIso(usage.periodStart),
    periodEnd: toIso(usage.periodEnd),
    limitCents: usage.limitCents,
    reservedCents: usage.reservedCents,
    settledCents: usage.settledCents,
    unknownCents: usage.unknownCents,
    overrun: usage.overrun,
    legacyUnclassified: usage.legacyUnclassified,
  };
}

export function toStepDto(row: typeof steps.$inferSelect): StepDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

export function toArtifactDto(
  row: typeof artifacts.$inferSelect,
): ArtifactDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

export function toRetrievedEvidenceDto(row: EvidenceRow): RetrievedEvidenceDto {
  return {
    ...row,
    retrievedAt: toIso(row.retrievedAt),
  };
}

export function toMemoryDto(row: typeof memories.$inferSelect): MemoryDto {
  return {
    ...row,
    validFrom: toIso(row.validFrom),
    validTo: toIsoOrNull(row.validTo),
    lastConfirmedAt: toIsoOrNull(row.lastConfirmedAt),
    expiresAt: toIsoOrNull(row.expiresAt),
    createdAt: toIso(row.createdAt),
  };
}

export function toInsightDto(row: typeof insights.$inferSelect): InsightDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
    decidedAt: toIsoOrNull(row.decidedAt),
  };
}

export function toReviewDto(row: typeof reviews.$inferSelect): ReviewDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

export function toApprovalDto(
  row: typeof approvals.$inferSelect,
): ApprovalDto {
  return {
    ...row,
    expiresAt: toIsoOrNull(row.expiresAt),
    decidedAt: toIsoOrNull(row.decidedAt),
    consumedAt: toIsoOrNull(row.consumedAt),
    createdAt: toIso(row.createdAt),
  };
}

export function toAuditEventDto(
  row: typeof auditEvents.$inferSelect,
): AuditEventDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

/**
 * 人工判定行 → 记录。读不懂的形态返回 null 而不是填一个默认结论：
 * 一条 after 被改坏或格式不符的审计行，宁可显示"没有记录"，
 * 也不能在页面上凭空显示一个"已通过"。
 */
export function toOverrideRecord(
  row: typeof auditEvents.$inferSelect | null,
): TaskOverrideRecordDto | null {
  if (!row) return null;
  const after = row.after as Record<string, unknown> | null;
  const status = after?.status;
  if (status !== "accepted" && status !== "rejected") return null;
  const reason = typeof after?.reason === "string" ? after.reason : "";
  const artifactId =
    typeof after?.artifactId === "string" ? after.artifactId : null;
  return { decision: status, reason, artifactId, decidedAt: toIso(row.createdAt) };
}

export function toSkillDto(row: typeof skills.$inferSelect): SkillDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

export function toCouncilDto(row: typeof councils.$inferSelect): CouncilDto {
  return {
    ...row,
    resolutionAppliedAt: toIsoOrNull(row.resolutionAppliedAt),
    createdAt: toIso(row.createdAt),
    decidedAt: toIsoOrNull(row.decidedAt),
  };
}

export function toCouncilPositionDto(
  row: typeof councilPositions.$inferSelect,
): CouncilPositionDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

export function toDissentDto(row: typeof dissents.$inferSelect): DissentDto {
  return {
    ...row,
    evaluatedAt: toIsoOrNull(row.evaluatedAt),
    createdAt: toIso(row.createdAt),
  };
}

export function toCheckinDto(row: typeof checkins.$inferSelect): CheckinDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}
