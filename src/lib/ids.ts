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
