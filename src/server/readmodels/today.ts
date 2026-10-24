import { and, count, eq } from "drizzle-orm";

import { todayPageSchema, type TodayPageDto } from "@/contracts";
import { db } from "@/lib/db";
import { insights } from "@/lib/db/schema";
import { asDto } from "@/server/dto-guard";
import {
  toAgentDto,
  toApprovalDto,
  toCheckinDto,
  toCouncilDto,
  toGoalDto,
  toProfileDto,
  toReviewDto,
  toTaskDto,
  toUserDto,
} from "@/server/mappers";
import { getTodayData } from "@/server/services/queries/today";

export async function loadToday(userId: string): Promise<TodayPageDto> {
  const [data, proposed] = await Promise.all([
    getTodayData(userId),
    db
      .select({ value: count() })
      .from(insights)
      .where(and(eq(insights.userId, userId), eq(insights.status, "proposed"))),
  ]);

  return asDto(
    todayPageSchema,
    {
      user: toUserDto(data.user),
      profile: data.profile ? toProfileDto(data.profile) : null,
      agents: data.agents.map(toAgentDto),
      goals: data.goals.map(toGoalDto),
      tasks: data.tasks.map(toTaskDto),
      approvals: data.approvals.map(toApprovalDto),
      council: data.council ? toCouncilDto(data.council) : null,
      checkin: data.checkin ? toCheckinDto(data.checkin) : null,
      yesterdayCheckin: data.yesterdayCheckin
        ? toCheckinDto(data.yesterdayCheckin)
        : null,
      brief: data.brief ? toReviewDto(data.brief) : null,
      weeklyMetrics: data.weeklyMetrics,
      topSpender: data.topSpender,
      counts: {
        agents: data.agents.length,
        pendingApprovals: data.approvals.length,
        proposedInsights: proposed[0]?.value ?? 0,
      },
    },
    "TodayPage",
  );
}
