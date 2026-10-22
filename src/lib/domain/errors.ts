import type { ErrorCode } from "@/contracts/errors";

import { logEvent } from "@/lib/obs/context";
import { serialiseError, type LogLevel } from "@/lib/obs/logger";

export type { ErrorCode };

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "Unauthorized") {
    super("unauthorized", message, 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "Forbidden") {
    super("forbidden", message, 403);
  }
}

export class RateLimitError extends DomainError {
  constructor(message = "Too many requests") {
    super("rate_limited", message, 429);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super("validation_error", message, 400);
  }
}

export class PolicyDenied extends DomainError {
  constructor(message: string) {
    super("policy_denied", message, 403);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super("conflict", message, 409);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super("not_found", message, 404);
  }
}

/**
 * A rejection is business, not breakage: refusing a task the policy forbids is
 * the product working correctly. Only 4xx that follow from a caller mistake and
 * every 5xx deserve attention, so the noise floor is deliberately low.
 */
function rejectionLevel(code: string, status: number): LogLevel {
  if (status >= 500) return "error";
  if (
    code === "policy_denied" ||
    code === "conflict" ||
    code === "rate_limited" ||
    code === "forbidden"
  ) {
    return "info";
  }
  return "debug";
}

export function toErrorResponse(error: unknown): {
  status: number;
  body: { ok: false; error: string; code: string };
} {
  if (error instanceof DomainError) {
    logEvent(rejectionLevel(error.code, error.status), "http.rejected", {
      code: error.code,
      status: error.status,
      fault: "client",
    });

    return {
      status: error.status,
      body: { ok: false, error: error.message, code: error.code },
    };
  }

  // Unconditional. Gating this on `NODE_ENV` meant production ran blind: every
  // 5xx disappeared before anyone could see it, and the only record of the
  // failure was a user saying "it broke".
  logEvent("error", "http.error", {
    ...serialiseError(error),
    status: 500,
    fault: "server",
  });

  return {
    status: 500,
    body: {
      ok: false,
      error: "Internal error",
      code: "internal_error",
    },
  };
}
