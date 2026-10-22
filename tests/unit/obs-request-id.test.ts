import { describe, expect, test } from "vitest";

import {
  newRequestId,
  sanitizeRequestId,
  templateOfPath,
} from "@/lib/obs/request-id";

describe("request identifiers", () => {
  test("mints unique, bounded identifiers", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));

    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^r_[0-9a-f]{16}$/);
    }
  });

  test("accepts an inbound identifier only when it is safe to log", () => {
    expect(sanitizeRequestId("r_0123456789abcdef")).toBe("r_0123456789abcdef");
    expect(sanitizeRequestId("  r_0123456789abcdef  ")).toBe(
      "r_0123456789abcdef",
    );

    expect(sanitizeRequestId(null)).toBeNull();
    expect(sanitizeRequestId("")).toBeNull();
    expect(sanitizeRequestId("short")).toBeNull();
    expect(sanitizeRequestId("has space here")).toBeNull();
    expect(sanitizeRequestId('json"injection')).toBeNull();
    expect(sanitizeRequestId("line\nbreak")).toBeNull();
    expect(sanitizeRequestId("x".repeat(97))).toBeNull();
  });

  test("folds resource ids out of a path so the route stays bounded", () => {
    expect(templateOfPath("/api/tasks/tsk_ab12cd34/run")).toBe(
      "/api/tasks/:id/run",
    );
    expect(templateOfPath("/api/runs/9f8e7d6c-1a2b-3c4d-5e6f-7a8b9c0d1e2f")).toBe(
      "/api/runs/:id",
    );
    expect(templateOfPath("/api/cabinet/12345")).toBe("/api/cabinet/:id");
    expect(templateOfPath("/api/today?deep=1")).toBe("/api/today");
    expect(templateOfPath("/")).toBe("/");
    expect(templateOfPath("")).toBe("/");
  });

  test("never lets a path grow without bound", () => {
    const template = templateOfPath(`/${"segment/".repeat(40)}`);
    expect(template.split("/").length).toBeLessThanOrEqual(9);
  });
});
