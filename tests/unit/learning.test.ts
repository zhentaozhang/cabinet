import { describe, expect, it } from "vitest";
import { buildNextLearningTask } from "@/lib/domain/learning";
import { computeLearningProgress } from "@/lib/domain/learning-progress";
import type { LearningConfig } from "@/lib/domain/policy";

const config: LearningConfig = {
  progressWeights: { acceptedTasks: 0.5, recall: 0.3, checkins: 0.2 },
  targetCheckinsPerWeek: 5,
  nextTask: {
    estimateMin: 25,
    minRecallScore: 0.6,
    minWords: 60,
    maxErrorTags: 3,
    retestAfterDays: 3,
  },
};

describe("learning progress", () => {
  it("uses configured weights", () => {
    expect(
      computeLearningProgress({
        acceptedLearningTasks: 1,
        totalLearningTasks: 1,
        latestRecallScore: 0.4,
        checkinsThisWeek: 1,
        config,
      }),
    ).toBeCloseTo(66);
  });

  it("does not divide by zero", () => {
    expect(
      computeLearningProgress({
        acceptedLearningTasks: 0,
        totalLearningTasks: 0,
        latestRecallScore: null,
        checkinsThisWeek: 0,
        config,
      }),
    ).toBe(0);
  });
});

describe("next learning task", () => {
  it("targets the first weak topic", () => {
    const task = buildNextLearningTask({
      goalTitle: "RAG",
      goalTarget: "explain rerank",
      latestRecallScore: 0.4,
      errorTags: ["rerank", "precision"],
      retest: false,
      config,
    });
    expect(task.title).toContain("rerank");
    expect(task.template).toBe("learning");
    expect(task.acceptanceChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "contains", value: "rerank" }),
      ]),
    );
  });

  it("schedules a retest when requested", () => {
    const task = buildNextLearningTask({
      goalTitle: "RAG",
      goalTarget: "explain rerank",
      latestRecallScore: 0.8,
      errorTags: ["rerank"],
      retest: true,
      config,
    });
    expect(task.template).toBe("learning_retest");
    expect(task.title).toContain("重测");
  });
});
