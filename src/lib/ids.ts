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

/** Stable JSON for hashing: jsonb does not preserve key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
