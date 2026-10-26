import { z } from "zod";
import { ValidationError } from "@/lib/domain/errors";
import type { PolicyConfig } from "@/lib/domain/policy";

/**
 * 允许"采纳洞察"改写的策略叶子白名单。
 *
 * 为什么是白名单而不是"任意路径"：policy_overrides.key 是 jsonb 形状里的一条
 * 路径，写错一个字（reflection.eveningHours）不会报错，只会让覆盖看似生效而
 * 决策读到的仍是默认值 —— 这类静默失效无法在日志里发现，所以每个键都必须与
 * policyConfigSchema 的真实叶子一一对应，并自带范围校验。
 *
 * 为什么刻意不含 autonomy.* / budget.* / cost.maxRunCents：那些是安全与花钱的
 * 底线。一条"最近驳回率偏高"的洞察没有资格把信任门槛、审批金额或单次成本上限
 * 调松；它们仍只能由运维直接改 policy_config。这里允许的是"节奏类"旋钮：反思
 * 窗口、样本量、提醒时刻、下一任务的粒度与复测间隔。
 */
const OVERRIDE_SCHEMAS = {
  "reflection.windowDays": z.number().int().min(1).max(90),
  "reflection.minRejectEvents": z.number().int().min(0).max(100),
  "reflection.minTaskSample": z.number().int().min(0).max(100),
  "reflection.eveningHour": z.number().int().min(0).max(23),
  "reflection.eveningCompletionThreshold": z.number().min(0).max(1),
  // 精力表是 1–5 分，0 表示"任何精力都算低"，因此下界取 0。
  "reflection.lowEnergyThreshold": z.number().min(0).max(5),
  // 允许超过 1：周预算被突破时阈值逻辑仍然要能表达，2 只是防止明显的手滑。
  "reflection.budgetPressureRatio": z.number().min(0).max(2),
  "reflection.confidence": z.number().min(0).max(1),
  "audit.rejectStreakLimit": z.number().int().min(1).max(20),
  "audit.passRateWindow": z.number().int().min(1).max(200),
  "learning.nextTask.minWords": z.number().int().min(1).max(500),
  "learning.nextTask.retestAfterDays": z.number().int().min(1).max(365),
  "learning.nextTask.minRecallScore": z.number().min(0).max(1),
  "learning.nextTask.estimateMin": z.number().int().min(1).max(480),
  "learning.nextTask.maxErrorTags": z.number().int().min(1).max(20),
  "learning.targetCheckinsPerWeek": z.number().int().min(1).max(21),
} as const satisfies Record<string, z.ZodType<number>>;

export type PolicyOverrideKey = keyof typeof OVERRIDE_SCHEMAS;
export type PolicyOverrideValue = number;

/** 只读导出，键的取值集合就是唯一真相。 */
export const POLICY_OVERRIDE_SCHEMA: Record<
  PolicyOverrideKey,
  z.ZodType<number>
> = OVERRIDE_SCHEMAS;

export function allowedKeys(): PolicyOverrideKey[] {
  return Object.keys(OVERRIDE_SCHEMAS) as PolicyOverrideKey[];
}

export function isAllowedOverrideKey(key: string): key is PolicyOverrideKey {
  return Object.hasOwn(OVERRIDE_SCHEMAS, key);
}

/**
 * 校验一条覆盖值。未知键和非法值都抛 ValidationError 且消息带 key：
 * 调用方（命令服务 / 采纳洞察）会把消息原样回给用户，缺了键名用户无法知道
 * 是哪条覆盖被拒。
 */
export function validateOverrideValue(
  key: string,
  value: unknown,
): PolicyOverrideValue {
  if (!isAllowedOverrideKey(key)) {
    throw new ValidationError(`Policy override key is not allowed: ${key}`);
  }
  const parsed = OVERRIDE_SCHEMAS[key].safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new ValidationError(
      `Invalid value for policy override ${key}: ${describe(value)} (${detail})`,
    );
  }
  return parsed.data;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * 读取一条路径的值。返回 undefined 表示路径不存在 —— 调用方要把它当作
 * "没有这条覆盖/配置漂移"，而不是 0。
 */
export function readOverrideValue(source: unknown, key: string): unknown {
  let cursor: unknown = source;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    const record = cursor as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return undefined;
    cursor = record[segment];
  }
  return cursor;
}

/**
 * 把若干条覆盖逐条 set 到 base 的深拷贝上。纯函数：没有 IO、不改 base，
 * 因此单测可以完全脱离数据库验证"白名单 + 范围 + 落点"三件事。
 *
 * 任何一条非法都整体抛错：半套覆盖生效比完全不生效更难排查。
 */
export function applyOverrides(
  base: PolicyConfig,
  rows: Array<{ key: string; valueJson: unknown }>,
): PolicyConfig {
  const next = structuredClone(base);
  for (const row of rows) {
    const value = validateOverrideValue(row.key, row.valueJson);
    writeLeaf(next, row.key, value);
  }
  return next;
}

function writeLeaf(
  target: PolicyConfig,
  key: string,
  value: PolicyOverrideValue,
): void {
  const segments = key.split(".");
  let cursor: Record<string, unknown> = target as unknown as Record<
    string,
    unknown
  >;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      // 白名单里的键在 schema 里存在，但 base 可能是结构漂移的旧数据；
      // 这时宁可报错，也不要给对象凭空添一条无人读取的字段。
      throw new ValidationError(`Unknown policy override key: ${key}`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (!Object.hasOwn(cursor, leaf)) {
    throw new ValidationError(`Unknown policy override key: ${key}`);
  }
  cursor[leaf] = value;
}
