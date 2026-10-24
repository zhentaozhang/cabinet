import { describe, expect, it } from "vitest";
import { mergeTools, readRules } from "@/lib/domain/execution-context";

describe("mergeTools", () => {
  it("keeps the agent's declared order and appends what the skill brought", () => {
    expect(mergeTools(["read_notes", "write_task"], ["quiz"])).toEqual([
      "read_notes",
      "write_task",
      "quiz",
    ]);
  });

  it("does not offer the same tool twice", () => {
    // A skill that declares a tool the agent already has must not make the run
    // look like it has two tools to choose from.
    expect(
      mergeTools(["read_notes", "quiz"], ["quiz", "calendar_read", "read_notes"]),
    ).toEqual(["read_notes", "quiz", "calendar_read"]);
  });

  it("is a no-op when nothing extra is declared", () => {
    expect(mergeTools(["read_notes"], [])).toEqual(["read_notes"]);
    expect(mergeTools([], [])).toEqual([]);
  });
});

describe("readRules", () => {
  it("reads the rules reflection wrote", () => {
    expect(
      readRules({ language: "zh-CN", rules: ["先给例子", "别超过 25 分钟"] }),
    ).toEqual(["先给例子", "别超过 25 分钟"]);
  });

  it("refuses a row that never had rules", () => {
    expect(readRules(null)).toEqual([]);
    expect(readRules(undefined)).toEqual([]);
    expect(readRules({})).toEqual([]);
    expect(readRules({ rules: "先给例子" })).toEqual([]);
  });

  it("drops entries that are not usable text", () => {
    // preferences is free-form jsonb; a half-written rule must not put
    // "undefined" into a prompt.
    expect(readRules({ rules: ["先给例子", "", "   ", 42, null] })).toEqual([
      "先给例子",
    ]);
  });
});
