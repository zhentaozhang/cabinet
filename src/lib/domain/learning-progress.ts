import type { LearningConfig } from "./policy";

export function computeLearningProgress(input: {
  acceptedLearningTasks: number;
  totalLearningTasks: number;
  latestRecallScore: number | null;
  checkinsThisWeek: number;
  config: LearningConfig;
}): number {
  const { acceptedTasks, recall, checkins } = input.config.progressWeights;
  const weightTotal = acceptedTasks + recall + checkins;
  if (weightTotal <= 0) return 0;

  const taskScore =
    input.totalLearningTasks > 0
      ? Math.min(1, input.acceptedLearningTasks / input.totalLearningTasks)
      : 0;
  const recallScore = Math.min(
    1,
    Math.max(0, input.latestRecallScore ?? 0),
  );
  const checkinScore = Math.min(
    1,
    input.checkinsThisWeek / input.config.targetCheckinsPerWeek,
  );

  const raw =
    (acceptedTasks * taskScore +
      recall * recallScore +
      checkins * checkinScore) /
    weightTotal;

  return Math.min(100, Math.max(0, raw * 100));
}
