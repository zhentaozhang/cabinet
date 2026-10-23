/**
 * Error codes and their user-facing copy, with no dependencies at all.
 *
 * Split out of `errors.ts` because the browser only needs these two symbols,
 * and importing the schema module would drag zod into every client bundle to
 * print "登录状态已失效". Types and copy here; validation stays in `errors.ts`.
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
