import { describe, expect, it } from "vitest";

import type { CapabilityState } from "@/contracts/labels";
import {
  ACTION_TYPE_LABELS,
  CAPABILITY_LABELS,
  MEMORY_TYPE_LABELS,
  NOTIFY_KIND_LABEL,
  RESOURCE_LABELS,
  RISK_LABELS,
  STATUS_LABELS,
  STATUS_NEXT_ACTION,
  actionTypeLabel,
  capabilityLabel,
  capabilityTone,
  memoryTypeLabel,
  notifyKindLabel,
  resourceLabel,
  riskLabel,
  statusLabel,
  statusNextAction,
  statusTone,
} from "@/contracts/labels";

import type { NotifyKind } from "@/server/services/commands/notify";

/**
 * 收件箱的 kind 是后端枚举，用户不该看到 "review" 这种原样字符串。
 * 这里的 Record<NotifyKind, true> 是编译期穷举：往 NotifyKind 里加一个 kind
 * 而忘了给中文标签，类型检查就红，而不是等到某天页面上冒出一个英文单词。
 */
const NOTIFY_KINDS: Record<NotifyKind, true> = {
  rejection: true,
  approval: true,
  budget: true,
  conflict: true,
  review: true,
};

/**
 * The rule these tests defend: no screen may print a raw DTO enum at a person.
 * `approval.status` is `pending`, not `待决定`; `memory.type` is `semantic`, not
 * `语义记忆`. Both used to leak. Every value the backend can emit needs a word
 * here, and the fallback must be visibly a fallback rather than a guess.
 */

/** Values that reach a status badge somewhere in the app. */
const WORKFLOW_STATUSES = [
  // agent
  "active",
  "probation",
  "paused",
  "retired",
  // apprentice lifecycle
  "shadowing",
  "drafting",
  "examining",
  "practice_passed",
  // task
  "planned",
  "assigned",
  "awaiting_approval",
  "approved",
  "suggested",
  "running",
  "submitted",
  "auditing",
  "accepted",
  "rejected",
  "done",
  "failed",
  "cancelled",
  // run
  "queued",
  "succeeded",
  // skill
  "draft",
  // approval / insight / council
  "pending",
  "expired",
  "proposed",
  "applied",
  "rolled_back",
  "open",
  "deliberating",
  "degraded",
  "decided",
] as const;

const MEMORY_TYPES = ["episodic", "semantic", "procedural"] as const;

describe("every workflow status has a Chinese label", () => {
  it.each(WORKFLOW_STATUSES)("%s", (status) => {
    const label = statusLabel(status);
    expect(label).not.toBe(status);
    expect(label.trim().length).toBeGreaterThan(0);
    // A label made only of ASCII would still be an enum leaking through.
    expect(label).toMatch(/[\u4e00-\u9fff]/);
  });

  it("covers the whole map, so a new entry cannot skip the check", () => {
    for (const status of Object.keys(STATUS_LABELS)) {
      expect(statusLabel(status), status).not.toBe(status);
    }
  });
});

describe("audit-log kind chips are filtered by the same vocabulary", () => {
  /**
   * `/review/audit` renders one chip per first segment of `audit_events.action`
   * through `statusLabel`. Anything the map misses falls through as the raw
   * English segment, so the filter row read "任务 12 · insight 3 · council 1".
   * The list is the union of action prefixes written to the audit log; it is
   * spelled out here so dropping a mapping fails instead of silently leaking.
   */
  const AUDIT_KINDS = [
    "insight",
    "grant",
    "approval",
    "council",
    "dissent",
    "memory",
    "goal",
    "chief",
    "apprentice",
    "workspace",
    "run",
    "review",
  ] as const;

  it.each(AUDIT_KINDS)("%s has a Chinese chip label", (kind) => {
    const label = statusLabel(kind);
    expect(label, kind).not.toBe(kind);
    expect(label.trim().length, kind).toBeGreaterThan(0);
  });

  it("keeps the four prefixes other screens already rely on", () => {
    // These four are shared with the log lines on other pages; changing them
    // would quietly relabel history there too.
    expect(statusLabel("task")).toBe("任务");
    expect(statusLabel("audit")).toBe("验收");
    expect(statusLabel("checkin")).toBe("打卡");
    expect(statusLabel("autonomy")).toBe("自治");
  });
});

describe("an unknown status stays visibly unknown", () => {
  it("falls back to the raw value rather than inventing a friendly word", () => {
    // Guessing would be worse: an unrecognised state must not borrow the
    // vocabulary of a state we do understand.
    expect(statusLabel("something_new")).toBe("something_new");
    expect(statusTone("something_new")).toBe("neutral");
  });
});

describe("status tone never encodes the only signal", () => {
  it("gives a tone to every known status", () => {
    for (const status of WORKFLOW_STATUSES) {
      expect(["neutral", "accent", "teal", "danger", "blue", "violet"]).toContain(
        statusTone(status),
      );
    }
  });

  it("keeps failure red and success calm", () => {
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("rejected")).toBe("danger");
    expect(statusTone("accepted")).toBe("teal");
    expect(statusTone("done")).toBe("teal");
    // Waiting is not an error: an accent, never danger.
    expect(statusTone("awaiting_approval")).toBe("accent");
    expect(statusTone("pending")).toBe("accent");
    // An expired approval is history, not a failure the user caused.
    expect(statusTone("expired")).toBe("neutral");
  });
});

describe("every actionable status says what the person should do", () => {
  it("offers a next action for states that are waiting on a human", () => {
    for (const status of [
      "awaiting_approval",
      "submitted",
      "rejected",
      "failed",
      "running",
    ]) {
      const action = statusNextAction(status);
      expect(action, status).not.toBeNull();
      expect(action?.trim().length, status).toBeGreaterThan(0);
    }
  });

  it("tells the person a settled state needs nothing, rather than going silent", () => {
    // Silence is ambiguous: it reads the same as a state the UI forgot to
    // handle. A settled state says so.
    expect(statusNextAction("accepted")).toContain("无需操作");
    expect(statusNextAction("done")).toContain("已完成");
    expect(statusNextAction("cancelled")).toContain("重新创建");
  });

  it("returns null only for a state it has never seen", () => {
    expect(statusNextAction("something_new")).toBeNull();
  });

  it("covers every entry in the map", () => {
    for (const status of Object.keys(STATUS_NEXT_ACTION)) {
      expect(statusNextAction(status), status).not.toBeNull();
    }
  });
});

describe("memory kinds read as words, not as a taxonomy", () => {
  it.each(MEMORY_TYPES)("%s", (type) => {
    const label = memoryTypeLabel(type);
    expect(label).not.toBe(type);
    expect(label).toMatch(/[\u4e00-\u9fff]/);
  });

  it("covers the whole map", () => {
    for (const type of Object.keys(MEMORY_TYPE_LABELS)) {
      expect(memoryTypeLabel(type), type).not.toBe(type);
    }
  });

  it("passes an unknown kind through rather than guessing", () => {
    expect(memoryTypeLabel("prospective")).toBe("prospective");
  });
});

describe("capability states are deployment facts, not failures", () => {
  it("labels every state", () => {
    for (const state of Object.keys(CAPABILITY_LABELS) as CapabilityState[]) {
      expect(capabilityLabel(state), state).not.toBe(state);
    }
  });

  it("does not paint a missing connector red", () => {
    // A deployment that has not wired a connector has not failed at anything.
    // Red here would make an entire settings page read as broken.
    expect(capabilityTone("not_configured")).toBe("neutral");
    expect(capabilityTone("unavailable")).toBe("neutral");
    expect(capabilityTone("unknown")).toBe("neutral");
    expect(capabilityTone("configured")).toBe("teal");
    // Simulated data is a warning about provenance, so it is not teal either.
    expect(capabilityTone("simulated")).toBe("violet");
    expect(capabilityTone("degraded")).toBe("accent");
  });
});

describe("task metadata reads as words", () => {
  it("names every action type the API accepts", () => {
    // The set comes from `taskCreateSchema.actionType`; a new value there
    // must not start rendering as `internal_read` on the detail page.
    for (const actionType of [
      "internal",
      "internal_read",
      "external",
      "spend",
      "publish",
      "message",
      "book",
    ]) {
      const label = actionTypeLabel(actionType);
      expect(label, actionType).not.toBe(actionType);
      expect(label, actionType).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("distinguishes a read-only task from one with outside effects", () => {
    // These two are the ones a person must not confuse: one can spend money
    // or touch the outside world, the other cannot.
    expect(actionTypeLabel("internal")).not.toBe(actionTypeLabel("internal_read"));
    expect(actionTypeLabel("internal_read")).toContain("只读");
  });

  it("names every resource", () => {
    for (const resource of Object.keys(RESOURCE_LABELS)) {
      expect(resourceLabel(resource), resource).not.toBe(resource);
    }
  });

  it("names every risk level", () => {
    expect(riskLabel("low")).toBe("低");
    expect(riskLabel("medium")).toBe("中");
    expect(riskLabel("high")).toBe("高");
  });

  it("passes unknown values through instead of guessing", () => {
    expect(actionTypeLabel("teleport")).toBe("teleport");
    expect(resourceLabel("moon")).toBe("moon");
    expect(riskLabel("extreme")).toBe("extreme");
  });

  it("covers the whole action-type map", () => {
    for (const actionType of Object.keys(ACTION_TYPE_LABELS)) {
      expect(actionTypeLabel(actionType), actionType).not.toBe(actionType);
    }
  });

  it("covers the whole risk map", () => {
    for (const risk of Object.keys(RISK_LABELS)) {
      expect(riskLabel(risk), risk).not.toBe(risk);
    }
  });

  it("each notification kind has a word of its own", () => {
    for (const kind of Object.keys(NOTIFY_KINDS)) {
      expect(NOTIFY_KIND_LABEL[kind], kind).toBeTruthy();
      expect(notifyKindLabel(kind), kind).not.toBe(kind);
    }
    // 待判定与驳回必须是两个词：一个请你判断，一个已经有结论了。
    expect(notifyKindLabel("review")).not.toBe(notifyKindLabel("rejection"));
  });
});