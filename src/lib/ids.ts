import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";

const alphabet =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const nano = customAlphabet(alphabet, 12);

export function newId(prefix: string): string {
  return `${prefix}_${nano()}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable JSON for hashing: jsonb does not preserve key order.
 *
 * 取值必须与"这一行落进 jsonb 之后长什么样"一致：对象里值为 undefined 的键
 * 会被 jsonb 丢掉，数组里的 undefined 会变成 null（JSON.stringify 的语义）。
 * 早先这里把 undefined 拼成字面量 "undefined"，于是任何调用方只要在 before/after
 * 里带一个可选字段，写下的哈希就永远无法从存下来的行重新算出来——审计页会把
 * 自己的事件报成篡改。哈希要描述存储，不能描述内存里的临时对象。
 */
export function canonicalJson(value: unknown): string {
  if (isDroppedByJson(value)) {
    // 对象里由调用方过滤；走到这里说明是数组元素或顶层值，jsonb 存的就是 null。
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => !isDroppedByJson(record[key]))
    .sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** 这三个值在 JSON.stringify 里会被丢掉（对象键）或变成 null（数组项）。 */
function isDroppedByJson(value: unknown): boolean {
  return (
    value === undefined || typeof value === "function" || typeof value === "symbol"
  );
}
