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

/**
 * The subject the next task drills. `key` is the normalised lookup key,
 * `label` is what the user reads — and what the answer has to mention.
 */
export type LearningTopic = {
  key: string;
  label: string;
};

export function buildNextLearningTask(input: {
  goalTitle: string;
  goalTarget: string;
  latestRecallScore: number | null;
  errorTags: string[];
  retest: boolean;
  config: LearningConfig;
  /**
   * Set only when spaced repetition says this topic is due. A due topic is a
   * different errand from "drill yesterday's weak point": it was answered
   * correctly before and is being checked for decay, so it gets its own
   * framing and its own acceptance item instead of being folded into the
   * retest naming. Callers that pass nothing keep the old behaviour exactly.
   */
  topic?: LearningTopic;
}): LearningTaskDraft {
  // Tags are trimmed before use: an untrimmed tag can never be `contains`-matched
  // against prose, so "  Promise  " would have made the checklist unpassable and
  // put a double space in the task title.
  const tags = input.errorTags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, input.config.nextTask.maxErrorTags);
  const weakTopic = tags[0] ?? "基础概念";
  const lowRecall =
    input.latestRecallScore !== null &&
    input.latestRecallScore < input.config.nextTask.minRecallScore;

  const title = input.topic
    ? `复习：${input.topic.label}`
    : input.retest
      ? `重测：${weakTopic}`
      : lowRecall
        ? `回炉练习：${weakTopic}`
        : `下一步练习：${weakTopic}`;

  const intro = input.topic
    ? `「${input.topic.label}」到了复习时间。先不查资料，凭记忆讲清它的核心要点，再补一个具体例子。`
    : input.retest
      ? "这是对上次薄弱点的延迟重测。请不要翻看答案，先凭记忆写出判断依据。"
      : lowRecall
        ? "上次回忆正确率偏低。先用一个最小例子讲清楚这个概念，再做一次自测。"
        : "把今天学到的内容用自己的话讲清楚，并给出一个具体例子。";

  const description = [
    `目标：${input.goalTitle}`,
    `验收目标：${input.goalTarget}`,
    "",
    intro,
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
  // A due topic replaces the leftover error tag as the thing the answer must
  // name: demanding both would ask for two subjects in one task and make the
  // `contains` check fail for a reason the title never mentioned.
  const mustMention = input.topic ? input.topic.label : tags[0];
  if (mustMention) {
    checklist.push({ type: "contains", value: mustMention, required: true });
  }
  if (input.topic) {
    // "Can you explain it" is not decidable by a substring or a word count, so
    // it becomes a `judge` item: the model judge rules on it when one is
    // configured, and it stays 未判定 otherwise instead of passing for free.
    checklist.push({
      type: "judge",
      value: `能用自己的话正确解释「${input.topic.label}」的核心要点`,
      required: true,
    });
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
