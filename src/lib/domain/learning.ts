import type { AcceptanceItem } from "@/lib/db/schema";
import type { LearningConfig } from "./policy";

export const LEARNING_TEMPLATES = ["learning", "learning_retest"] as const;

export type LearningTaskDraft = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  acceptanceChecklist: AcceptanceItem[];
  estimateMin: number;
  template: "learning" | "learning_retest";
};

export function buildNextLearningTask(input: {
  goalTitle: string;
  goalTarget: string;
  latestRecallScore: number | null;
  errorTags: string[];
  retest: boolean;
  config: LearningConfig;
}): LearningTaskDraft {
  const tags = input.errorTags.slice(0, input.config.nextTask.maxErrorTags);
  const weakTopic = tags[0] ?? "基础概念";
  const lowRecall =
    input.latestRecallScore !== null &&
    input.latestRecallScore < input.config.nextTask.minRecallScore;

  const title = input.retest
    ? `重测：${weakTopic}`
    : lowRecall
      ? `回炉练习：${weakTopic}`
      : `下一步练习：${weakTopic}`;

  const description = [
    `目标：${input.goalTitle}`,
    `验收目标：${input.goalTarget}`,
    "",
    input.retest
      ? "这是对上次薄弱点的延迟重测。请不要翻看答案，先凭记忆写出判断依据。"
      : lowRecall
        ? "上次回忆正确率偏低。先用一个最小例子讲清楚这个概念，再做一次自测。"
        : "把今天学到的内容用自己的话讲清楚，并给出一个具体例子。",
    tags.length > 0 ? `重点薄弱点：${tags.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const checklist: AcceptanceItem[] = [
    { type: "section", value: "答案", required: true },
    {
      type: "min_words",
      value: input.config.nextTask.minWords,
      required: true,
    },
  ];
  if (tags[0]) {
    checklist.push({ type: "contains", value: tags[0], required: true });
  }

  return {
    title,
    description,
    acceptanceCriteria:
      "用自己的话解释概念，给出具体例子；若为重测，需写出与上次不同的理解。",
    acceptanceChecklist: checklist,
    estimateMin: input.config.nextTask.estimateMin,
    template: input.retest ? "learning_retest" : "learning",
  };
}
