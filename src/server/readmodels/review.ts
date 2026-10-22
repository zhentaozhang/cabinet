import { reviewPageSchema, type ReviewPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import {
  toAgentDto,
  toAuditEventDto,
  toDissentDto,
  toInsightDto,
  toProfileDto,
  toReviewDto,
  toTaskDto,
  toUserDto,
} from "@/server/mappers";
import {
  getReviewData,
  type ReviewPageOptions,
} from "@/server/services/queries/review";

export async function loadReview(
  userId: string,
  options: ReviewPageOptions = {},
): Promise<ReviewPageDto> {
  const data = await getReviewData(userId, options);

  return asDto(
    reviewPageSchema,
    {
      user: toUserDto(data.user),
      profile: data.profile ? toProfileDto(data.profile) : null,
      weekly: data.weekly ? toReviewDto(data.weekly) : null,
      insights: data.insights.map(toInsightDto),
      agents: data.agents.map(toAgentDto),
      tasks: data.tasks.map(toTaskDto),
      audit: data.audit.map(toAuditEventDto),
      auditTotal: data.auditTotal,
      dissents: data.dissents.map(toDissentDto),
      insightTotal: data.insightTotal,
      insightProposedTotal: data.insightProposedTotal,
      dissentTotal: data.dissentTotal,
      dissentPendingTotal: data.dissentPendingTotal,
      insightOffset: data.insightOffset,
      dissentOffset: data.dissentOffset,
      limit: data.limit,
      auditStats: data.auditStats,
      autonomyDecisions: data.autonomyDecisions,
      config: data.config,
      weeklyMetrics: data.weeklyMetrics,
    },
    "ReviewPage",
  );
}
