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
import { getReviewData } from "@/server/services/queries/review";

export async function loadReview(userId: string): Promise<ReviewPageDto> {
  const data = await getReviewData(userId);

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
      dissents: data.dissents.map(toDissentDto),
      auditStats: data.auditStats,
      config: data.config,
      weeklyMetrics: data.weeklyMetrics,
    },
    "ReviewPage",
  );
}
