import type {
  agents,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
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
  CheckinDto,
  CouncilDto,
  CouncilPositionDto,
  GoalDto,
  InsightDto,
  MemoryDto,
  ProfileDto,
  ReviewDto,
  RunDto,
  SkillDto,
  StepDto,
  TaskDto,
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

export function toMemoryDto(row: typeof memories.$inferSelect): MemoryDto {
  return {
    ...row,
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

export function toSkillDto(row: typeof skills.$inferSelect): SkillDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}

export function toCouncilDto(row: typeof councils.$inferSelect): CouncilDto {
  return {
    ...row,
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

export function toCheckinDto(row: typeof checkins.$inferSelect): CheckinDto {
  return {
    ...row,
    createdAt: toIso(row.createdAt),
  };
}
