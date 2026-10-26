import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/domain/errors";
import { SEED_POLICY_CONFIG, type PolicyConfig } from "@/lib/domain/policy";
import {
  POLICY_OVERRIDE_SCHEMA,
  allowedKeys,
  applyOverrides,
  readOverrideValue,
  validateOverrideValue,
} from "@/lib/policy/overrides";

const base = (): PolicyConfig => structuredClone(SEED_POLICY_CONFIG);

describe("policy override whitelist", () => {
  it("覆盖需求点名的四组可调项", () => {
    expect(allowedKeys()).toEqual(
      expect.arrayContaining([
        "reflection.windowDays",
        "reflection.minRejectEvents",
        "reflection.minTaskSample",
        "reflection.eveningHour",
        "reflection.eveningCompletionThreshold",
        "reflection.lowEnergyThreshold",
        "reflection.budgetPressureRatio",
        "reflection.confidence",
        "audit.rejectStreakLimit",
        "audit.passRateWindow",
        "learning.nextTask.minWords",
        "learning.nextTask.retestAfterDays",
        "learning.nextTask.minRecallScore",
      ]),
    );
  });

  it("每个白名单键都是真实存在的数字叶子路径", () => {
    // 拼错的路径必须在这里就炸，而不是等到运行时 set 一个不存在的键、
    // 覆盖看起来"生效"了但决策读到的还是默认值。
    for (const key of allowedKeys()) {
      expect(typeof readOverrideValue(SEED_POLICY_CONFIG, key), key).toBe(
        "number",
      );
    }
  });

  it("每个键都有独立的 schema", () => {
    expect(Object.keys(POLICY_OVERRIDE_SCHEMA).sort()).toEqual(
      [...allowedKeys()].sort(),
    );
  });

  it("拒绝白名单外的键（即使它在配置里真实存在）", () => {
    expect(() => validateOverrideValue("cost.maxRunCents", 10)).toThrow(
      ValidationError,
    );
    expect(() => validateOverrideValue("autonomy.minTrust", 10)).toThrow(
      /autonomy\.minTrust/,
    );
    expect(() => validateOverrideValue("reflection.nope", 1)).toThrow(
      /reflection\.nope/,
    );
  });
});

describe("applyOverrides", () => {
  it("把覆盖写到深拷贝上，不动传入的 base", () => {
    const config = base();
    const next = applyOverrides(config, [
      { key: "learning.nextTask.minWords", valueJson: 40 },
      { key: "reflection.eveningHour", valueJson: 18 },
    ]);

    expect(next).not.toBe(config);
    expect(next.learning.nextTask.minWords).toBe(40);
    expect(next.learning.nextTask.estimateMin).toBe(
      config.learning.nextTask.estimateMin,
    );
    expect(next.reflection.eveningHour).toBe(18);
    expect(config.learning.nextTask.minWords).toBe(
      SEED_POLICY_CONFIG.learning.nextTask.minWords,
    );
    expect(config.reflection.eveningHour).toBe(
      SEED_POLICY_CONFIG.reflection.eveningHour,
    );
  });

  it("同一个键出现两行时后一行生效", () => {
    const next = applyOverrides(base(), [
      { key: "audit.rejectStreakLimit", valueJson: 3 },
      { key: "audit.rejectStreakLimit", valueJson: 5 },
    ]);
    expect(next.audit.rejectStreakLimit).toBe(5);
  });

  it("没有覆盖时返回等值但不共享引用的配置", () => {
    const config = base();
    const next = applyOverrides(config, []);
    expect(next).toEqual(config);
    expect(next).not.toBe(config);
  });

  it("遇到未知键直接抛错，且 base 不被改写", () => {
    const config = base();
    expect(() =>
      applyOverrides(config, [
        { key: "learning.nextTask.minWords", valueJson: 40 },
        { key: "budget.weeklyLimitCents", valueJson: 1 },
      ]),
    ).toThrow(/budget\.weeklyLimitCents/);
    expect(config.learning.nextTask.minWords).toBe(
      SEED_POLICY_CONFIG.learning.nextTask.minWords,
    );
  });

  it("遇到越界值直接抛错，消息里带 key", () => {
    expect(() =>
      applyOverrides(base(), [
        { key: "reflection.eveningHour", valueJson: 24 },
      ]),
    ).toThrow(/reflection\.eveningHour/);
  });
});

describe("value ranges", () => {
  const cases: Array<[string, unknown]> = [
    ["reflection.windowDays", 0],
    ["reflection.windowDays", 400],
    ["reflection.minRejectEvents", -1],
    ["reflection.minTaskSample", 2.5],
    ["reflection.eveningHour", 24],
    ["reflection.eveningCompletionThreshold", 1.5],
    ["reflection.lowEnergyThreshold", 6],
    ["reflection.budgetPressureRatio", -0.1],
    ["reflection.confidence", 1.2],
    ["audit.rejectStreakLimit", 0],
    ["audit.passRateWindow", 0],
    ["learning.nextTask.minWords", 0],
    ["learning.nextTask.minWords", 45.5],
    ["learning.nextTask.retestAfterDays", 0],
    ["learning.nextTask.minRecallScore", -0.1],
    ["learning.nextTask.minRecallScore", 1.1],
  ];

  it.each(cases)("拒绝 %s = %s", (key, value) => {
    expect(() => validateOverrideValue(key, value)).toThrow(ValidationError);
    expect(() => validateOverrideValue(key, value)).toThrow(key);
  });

  it("拒绝类型不对的值", () => {
    expect(() =>
      validateOverrideValue("learning.nextTask.minWords", "60"),
    ).toThrow(ValidationError);
    expect(() =>
      validateOverrideValue("reflection.confidence", null),
    ).toThrow(ValidationError);
    expect(() => validateOverrideValue("reflection.confidence", NaN)).toThrow(
      ValidationError,
    );
  });

  it("接受边界内的值", () => {
    expect(validateOverrideValue("reflection.eveningHour", 0)).toBe(0);
    expect(validateOverrideValue("reflection.eveningHour", 23)).toBe(23);
    expect(validateOverrideValue("reflection.confidence", 0.5)).toBe(0.5);
    expect(validateOverrideValue("learning.nextTask.minRecallScore", 1)).toBe(1);
    expect(validateOverrideValue("learning.nextTask.minWords", 20)).toBe(20);
  });
});
