import { taskPageSchema, type TaskPageDto } from "@/contracts";
import { asDto } from "@/server/dto-guard";
import {
  toAgentDto,
  toApprovalDto,
  toArtifactDto,
  toRetrievedEvidenceDto,
  toAuditEventDto,
  toGoalDto,
  toRunDto,
  toStepDto,
  toTaskDto,
} from "@/server/mappers";
import { getTaskData } from "@/server/services/queries/task";

export async function loadTask(
  taskId: string,
  userId: string,
): Promise<TaskPageDto | null> {
  const data = await getTaskData(taskId, userId);
  if (!data) return null;

  return asDto(
    taskPageSchema,
    {
      timezone: data.timezone,
      task: toTaskDto(data.task),
      goal: data.goal ? toGoalDto(data.goal) : null,
      assignee: data.assignee ? toAgentDto(data.assignee) : null,
      auditor: data.auditor ? toAgentDto(data.auditor) : null,
      runs: data.runs.map(toRunDto),
      steps: data.steps.map(toStepDto),
      artifacts: data.artifacts.map(toArtifactDto),
    evidence: data.evidence.map(toRetrievedEvidenceDto),
      approvals: data.approvals.map(toApprovalDto),
      audit: data.audit.map(toAuditEventDto),
    },
    "TaskPage",
  );
}
