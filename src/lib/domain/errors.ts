import type { ErrorCode } from "@/contracts/errors";

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

export function toErrorResponse(error: unknown): {
  status: number;
  body: { ok: false; error: string; code: string };
} {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: { ok: false, error: error.message, code: error.code },
    };
  }

  if (process.env.NODE_ENV !== "production") {
    console.error("[cabinet] unhandled API error", error);
  }

  return {
    status: 500,
    body: {
      ok: false,
      error: "Internal error",
      code: "internal_error",
    },
  };
}
