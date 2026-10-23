import { z } from "zod";

import { ERROR_CODES } from "./error-labels";

export {
  ERROR_CODES,
  ERROR_CODE_LABEL,
  type ErrorCode,
} from "./error-labels";

/**
 * Transport-level error contract shared by the API and the web client.
 *
 * This module must stay dependency-free apart from `zod`: it is the only thing
 * both sides of the frontend/backend boundary are allowed to import.
 */
export const errorCodeSchema = z.enum(ERROR_CODES);

export const apiFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: errorCodeSchema,
});

export type ApiFailure = z.infer<typeof apiFailureSchema>;

export type ApiSuccess<T> = { ok: true; data: T };

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ ok: z.literal(true), data });
}

export function isApiFailure(value: unknown): value is ApiFailure {
  return apiFailureSchema.safeParse(value).success;
}

