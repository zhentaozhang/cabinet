import { z } from "zod";
import { ValidationError } from "@/lib/domain/errors";

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ValidationError(`${path}${issue?.message ?? "Invalid body"}`);
  }
  return result.data;
}
