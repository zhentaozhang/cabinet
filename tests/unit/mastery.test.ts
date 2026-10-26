import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOPIC_KEY,
  MAX_EASE_FACTOR,
  MAX_INTERVAL_DAYS,
  MIN_EASE_FACTOR,
  masteryFrom,
  nextSchedule,
  normalizeTopicKey,
} from "@/lib/domain/mastery";
import { buildNextLearningTask } from "@/lib/domain/learning";
import type { LearningConfig } from "@/lib/domain/policy";

const DAY_MS = 86_400_000;

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

describe("normalizeTopicKey", () => {
  it("trims, collapses inner whitespace and lowercases", () => {
    expect(normalizeTopicKey("  Event \t Loop  ")).toBe("event loop");
  });

  it("keeps CJK as written", () => {
    expect(normalizeTopicKey(" 闭包 ")).toBe("闭包");
    expect(normalizeTopicKey("事件  循环")).toBe("事件 循环");
  });

  it("falls back to the base topic when blank", () => {
    for (const raw of ["", "   ", "\t\n ", "\u3000"]) {
      expect(normalizeTopicKey(raw)).toBe(DEFAULT_TOPIC_KEY);
    }
    expect(DEFAULT_TOPIC_KEY).toBe("基础概念");
  });
});

describe("nextSchedule", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("schedules the first successful review one day out", () => {
    const result = nextSchedule({
      attempts: 0,
      intervalDays: 0,
      easeFactor: 2.5,
      correct: true,
      now,
    });
    expect(result.intervalDays).toBe(1);
    expect(result.easeFactor).toBeCloseTo(2.6, 4);
    expect(result.dueAt.getTime()).toBe(now.getTime() + DAY_MS);
  });

  it("moves 1 -> 3 -> 8 days while the answers stay correct", () => {
    const second = nextSchedule({
      attempts: 1,
      intervalDays: 1,
      easeFactor: 2.6,
      correct: true,
      now,
    });
    expect(second.intervalDays).toBe(3);
    expect(second.easeFactor).toBeCloseTo(2.7, 4);

    const third = nextSchedule({
      attempts: 2,
      intervalDays: 3,
      easeFactor: 2.7,
      correct: true,
      now,
    });
    // round(3 * 2.7) = 8
    expect(third.intervalDays).toBe(8);
    expect(third.easeFactor).toBeCloseTo(2.8, 4);
  });

  it("caps the interval and the ease factor", () => {
    const result = nextSchedule({
      attempts: 9,
      intervalDays: 50,
      easeFactor: 2.8,
      correct: true,
      now,
    });
    expect(result.intervalDays).toBe(MAX_INTERVAL_DAYS);
    expect(result.easeFactor).toBe(MAX_EASE_FACTOR);
    expect(result.dueAt.getTime()).toBe(now.getTime() + MAX_INTERVAL_DAYS * DAY_MS);
  });

  it("drops back to one day and shrinks the ease factor on a wrong answer", () => {
    const result = nextSchedule({
      attempts: 4,
      intervalDays: 21,
      easeFactor: 2.6,
      correct: false,
      now,
    });
    expect(result.intervalDays).toBe(1);
    expect(result.easeFactor).toBeCloseTo(2.4, 4);
    expect(result.dueAt.getTime()).toBe(now.getTime() + DAY_MS);
  });

  it("never lets the ease factor fall below the floor", () => {
    const result = nextSchedule({
      attempts: 2,
      intervalDays: 3,
      easeFactor: 1.35,
      correct: false,
      now,
    });
    expect(result.easeFactor).toBe(MIN_EASE_FACTOR);
  });

  it("clamps garbage input instead of throwing", () => {
    const nan = nextSchedule({
      attempts: Number.NaN,
      intervalDays: Number.NaN,
      easeFactor: Number.NaN,
      correct: true,
      now,
    });
    expect(nan.intervalDays).toBe(1);
    expect(nan.easeFactor).toBeCloseTo(2.6, 4);
    expect(Number.isNaN(nan.dueAt.getTime())).toBe(false);

    const negative = nextSchedule({
      attempts: -3,
      intervalDays: -5,
      easeFactor: -1_000,
      correct: true,
      now,
    });
    expect(negative.intervalDays).toBe(1);
    expect(negative.easeFactor).toBeCloseTo(MIN_EASE_FACTOR + 0.1, 4);

    const huge = nextSchedule({
      attempts: 5,
      intervalDays: 1_000_000_000,
      easeFactor: 2.8,
      correct: true,
      now,
    });
    expect(huge.intervalDays).toBe(MAX_INTERVAL_DAYS);
    expect(huge.dueAt.getTime()).toBe(now.getTime() + MAX_INTERVAL_DAYS * DAY_MS);
  });

  it("keeps an invalid clock from producing an invalid due date", () => {
    const result = nextSchedule({
      attempts: 0,
      intervalDays: 0,
      easeFactor: 2.5,
      correct: true,
      now: new Date(Number.NaN),
    });
    expect(Number.isNaN(result.dueAt.getTime())).toBe(false);
    expect(result.intervalDays).toBe(1);
  });
});

describe("masteryFrom", () => {
  it("uses a prior so a single lucky answer is not mastery", () => {
    expect(masteryFrom(0, 0)).toBe(0.5);
    expect(masteryFrom(1, 1)).toBe(0.6667);
    expect(masteryFrom(3, 3)).toBe(0.8);
  });

  it("rounds to four decimals", () => {
    expect(masteryFrom(1, 0)).toBe(0.3333);
  });

  it("clamps counts that disagree with each other", () => {
    expect(masteryFrom(2, 5)).toBe(0.75);
    expect(masteryFrom(-1, -1)).toBe(0.5);
    expect(masteryFrom(Number.NaN, Number.NaN)).toBe(0.5);
  });
});

describe("next learning task with a due topic", () => {
  it("asks for the due topic and judges the explanation in the learner's own words", () => {
    const task = buildNextLearningTask({
      goalTitle: "JavaScript 基础",
      goalTarget: "能解释闭包与事件循环",
      latestRecallScore: 0.4,
      errorTags: ["rerank"],
      retest: false,
      config,
      topic: { key: "闭包", label: "闭包" },
    });

    expect(task.title).toBe("复习：闭包");
    expect(task.template).toBe("learning");
    expect(task.acceptanceChecklist.slice(0, 2)).toEqual([
      expect.objectContaining({ type: "section", value: "答案" }),
      expect.objectContaining({ type: "min_words", value: config.nextTask.minWords }),
    ]);
    expect(task.acceptanceChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "contains", value: "闭包" }),
        {
          type: "judge",
          value: "能用自己的话正确解释「闭包」的核心要点",
          required: true,
        },
      ]),
    );
    // The due topic wins over the leftover error tag: one task, one subject.
    expect(task.acceptanceChecklist).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "contains", value: "rerank" }),
      ]),
    );
  });

  it("keeps the existing naming when no topic is due", () => {
    const plain = buildNextLearningTask({
      goalTitle: "RAG",
      goalTarget: "explain rerank",
      latestRecallScore: 0.4,
      errorTags: ["rerank"],
      retest: false,
      config,
    });
    expect(plain.title).toBe("回炉练习：rerank");
    expect(
      plain.acceptanceChecklist.some((item) => item.type === "judge"),
    ).toBe(false);

    const retest = buildNextLearningTask({
      goalTitle: "RAG",
      goalTarget: "explain rerank",
      latestRecallScore: 0.8,
      errorTags: ["rerank"],
      retest: true,
      config,
    });
    expect(retest.title).toBe("重测：rerank");
    expect(retest.template).toBe("learning_retest");

    const noTags = buildNextLearningTask({
      goalTitle: "RAG",
      goalTarget: "explain rerank",
      latestRecallScore: null,
      errorTags: [],
      retest: false,
      config,
    });
    expect(noTags.title).toBe("下一步练习：基础概念");
  });
});
