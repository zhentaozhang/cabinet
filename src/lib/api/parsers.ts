import type { ConnectorTestDto } from "@/contracts";
import type { ErrorCode } from "@/contracts/error-labels";

/**
 * Hand-written response checks for the browser.
 *
 * Deliberately not zod: one or two small payloads do not justify shipping a
 * schema library to every visitor. These validate the fields the UI actually
 * reads — enough to turn contract drift into a clear message instead of
 * `undefined is not an object` three components later.
 */

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what} 不是数字`);
  }
  return value;
}

export function parseAuditVerification(value: unknown): {
  verified: boolean;
  checked: number;
  firstMismatch: string | null;
} {
  const row = record(value, "审计校验结果");
  if (typeof row.verified !== "boolean") throw new Error("verified 不是布尔值");
  const firstMismatch = row.firstMismatch;
  if (firstMismatch !== null && typeof firstMismatch !== "string") {
    throw new Error("firstMismatch 既不是字符串也不是 null");
  }
  return {
    verified: row.verified,
    checked: count(row.checked, "checked"),
    firstMismatch,
  };
}

const CONNECTOR_STATUS: ReadonlySet<string> = new Set([
  "ok",
  "not_configured",
  "unauthorized",
  "rate_limited",
  "timeout",
  "invalid_response",
  "network_error",
]);

export function parseConnectorTest(value: unknown): ConnectorTestDto {
  const row = record(value, "连接器测试结果");
  const status = row.status;
  if (typeof status !== "string" || !CONNECTOR_STATUS.has(status)) {
    throw new Error("status 不在已知集合里");
  }
  const sample = row.sample ?? null;
  const dto: ConnectorTestDto = {
    status: status as ConnectorTestDto["status"],
    provider: typeof row.provider === "string" ? row.provider : null,
    latencyMs: count(row.latencyMs, "latencyMs"),
    hits: count(row.hits, "hits"),
    sample:
      sample === null
        ? null
        : {
            title: String(record(sample, "sample").title ?? ""),
            url: String(record(sample, "sample").url ?? ""),
            publisher:
              typeof record(sample, "sample").publisher === "string"
                ? (record(sample, "sample").publisher as string)
                : null,
          },
    message: typeof row.message === "string" ? row.message : null,
  };
  return dto;
}

/** Kept for symmetry with the client failure envelope. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    value === "unauthorized" ||
    value === "forbidden" ||
    value === "rate_limited" ||
    value === "validation_error" ||
    value === "policy_denied" ||
    value === "conflict" ||
    value === "not_found" ||
    value === "internal_error"
  );
}
