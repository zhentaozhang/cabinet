import { z } from "zod";

/**
 * Transport-level error contract shared by the API and the web client.
 *
 * This module must stay dependency-free apart from `zod`: it is the only thing
 * both sides of the frontend/backend boundary are allowed to import.
 */
export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "rate_limited",
  "validation_error",
  "policy_denied",
  "conflict",
  "not_found",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

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

/** Human-facing copy for each transport error code. */
export const ERROR_CODE_LABEL: Record<ErrorCode, string> = {
  unauthorized: "登录状态已失效",
  forbidden: "没有权限执行该操作",
  rate_limited: "操作过于频繁，请稍后再试",
  validation_error: "提交的内容不合法",
  policy_denied: "被当前授权规则拒绝",
  conflict: "该操作已执行或状态已变更",
  not_found: "目标不存在",
  internal_error: "服务端出错了",
};
