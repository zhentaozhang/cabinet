import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  AcceptanceItemDto,
  RetrievedEvidenceDto,
  StepDto,
} from "@/contracts";
import { TASK_STATUSES, type TaskStatus } from "@/contracts/dto/entities";
import { statusLabel, statusTone } from "@/contracts/labels";
import {
  STEP_META,
  TOOL_STATUS_MAP,
  approvalCardHeading,
  classifyEvidence,
  getChecklistRuleLabel,
  getCitationRelationship,
  getCurrentAttempt,
  getNextActionCopy,
  pendingDecisionItems,
  getStatusBannerInfo,
  getStatusNextAction,
  getStatusSummary,
  isKnownTaskStatus,
  pendingApprovalFor,
  pendingApprovalsFirst,
  resolveFailurePresentation,
  resolveRejectionPresentation,
  summarizeTaskCitations,
  tallyChecklist,
  checklistBadge,
  type TaskNextActionCategory,
} from "@/lib/presentation/task-view";

function toolStep(status: string): StepDto {
  return {
    id: "stp_tool",
    runId: "run_1",
    idx: 3,
    type: "tool",
    tool: "search",
    input: {},
    output: { status },
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 120,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function evidence(overrides: Partial<RetrievedEvidenceDto>): RetrievedEvidenceDto {
  return {
    id: "evd_1",
    taskId: "tsk_1",
    runId: "run_1",
    kind: "web",
    url: "https://example.com/a",
    title: "A",
    publisher: "Example",
    quote: "…",
    provider: "tavily",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getStatusBannerInfo says what the status wants from you", () => {
  it("puts a rejection ahead of everything else", () => {
    // A rejected task that also has a pending approval and a failed run must
    // still lead with the rejection: that is the thing the user has to fix.
    const banner = getStatusBannerInfo("rejected", true, true, true);
    expect(banner.badgeLabel).toBe("未通过需修改");
    expect(banner.badgeTone).toBe("danger");
    expect(banner.title).toContain("驳回");
  });

  it("treats a failed run as a failure even while the task still says running", () => {
    const banner = getStatusBannerInfo("running", false, true, false);
    expect(banner.badgeLabel).toBe("执行失败");
    expect(banner.badgeTone).toBe("danger");
  });

  it("asks for approval when an action exceeded the autonomy threshold", () => {
    const banner = getStatusBannerInfo("awaiting_approval", true, false, false);
    expect(banner.badgeLabel).toBe("等待你审核");
    expect(banner.description).toContain("审批");
  });

  it("distinguishes a live retrieval from an idle run", () => {
    const waiting = getStatusBannerInfo("running", false, false, false, toolStep("running"));
    expect(waiting.badgeLabel).toBe("等待检索");
    expect(waiting.title).toContain("连接器");

    const busy = getStatusBannerInfo("running", false, false, false, toolStep("ok"));
    expect(busy.badgeLabel).toBe("执行中");
  });

  it("names the auditor while the product is under review", () => {
    const banner = getStatusBannerInfo("submitted", false, false, false);
    expect(banner.badgeLabel).toBe("等待你发起验收");
    expect(banner.description).toContain("Checklist");
  });

  it("does not claim the review is already running while the product is only queued", () => {
    const queued = getStatusBannerInfo("submitted", false, false, false);
    const inFlight = getStatusBannerInfo("auditing", false, false, false);

    // Both wait on the auditor, but only `auditing` has a review in flight.
    expect(queued.badgeLabel).not.toBe(inFlight.badgeLabel);
    expect(queued.title).toContain("验收还没开始");
    expect(inFlight.title).not.toContain("还没开始");
  });

  /*
    验收没有守护进程：`auditTask` 只由 POST /api/tasks/[id]/audit（那颗
    「提交给 Auditor 验收」按钮）与学徒结业考试调用。横幅曾经写着「Auditor 正在
    对照验收标准裁定，此时无需操作」，而同一屏右边就是那颗唯一的按钮——一句话
    说裁定已经在跑，一句话让读者别动，产物却会一直停在 submitted。
  */
  it("asks the reader to start the review instead of waiting for a scheduler", () => {
    const banner = getStatusBannerInfo("submitted", false, false, false);
    expect(banner.description).toContain("提交给 Auditor 验收");
    expect(banner.description).toContain("没有后台任务");
    expect(banner.description).not.toContain("无需操作");
    expect(getStatusNextAction("submitted")).toMatchObject({
      category: "start_audit",
      label: "发起验收",
    });
    expect(getStatusNextAction("submitted").hint).toContain("没有后台任务");

    // 没有验收者时那颗按钮按不了，横幅不能让人去点一颗点不动的按钮。
    const noAuditor = getStatusBannerInfo("submitted", false, false, false, undefined, false, false);
    expect(noAuditor.description).toContain("没有验收者");
    expect(noAuditor.description).not.toContain("提交给 Auditor 验收");
  });

  it("says the next move once the auditor passed", () => {
    const accepted = getStatusBannerInfo("accepted", false, false, false);
    expect(accepted.badgeTone).toBe("teal");
    expect(accepted.description).toContain("完成");

    const done = getStatusBannerInfo("done", false, false, false);
    expect(done.badgeLabel).toBe("任务已完成");
  });


  it("names whoever actually rejected instead of always crediting the Auditor", () => {
    // 人判驳回（audit.override）也把任务写成 rejected，而同一屏下方那张卡片
    // 写的是「你的驳回理由」。横幅若继续说「Auditor 驳回了当前产物」，同一个
    // 结论就被说成两个人下的。
    const byAuditor = getStatusBannerInfo("rejected", false, false, true);
    expect(byAuditor.title).toContain("Auditor");
    expect(byAuditor.badgeLabel).toBe("未通过需修改");

    const byUser = getStatusBannerInfo(
      "rejected",
      false,
      false,
      true,
      undefined,
      true,
    );
    expect(byUser.title).not.toContain("Auditor");
    expect(byUser.title).toContain("你驳回");
    expect(byUser.badgeLabel).toBe("你的判定：未通过");
    expect(byUser.description).toContain("审计链");
    // 仍然是「改完再交」，不是「等人验收」。
    expect(byUser.nextActionCategory).toBe("fix_and_resubmit");
  });
  it("keeps a cancelled task quiet instead of dressing it as a failure", () => {
    const banner = getStatusBannerInfo("cancelled", false, false, false);
    expect(banner.badgeTone).toBe("neutral");
    expect(banner.badgeLabel).toBe("已取消");
  });

  it("falls back to a ready-to-run state and never returns empty copy", () => {
    for (const status of ["planned", "assigned"] as const) {
      const banner = getStatusBannerInfo(status, false, false, false);
      expect(banner.badgeLabel).not.toBe("");
      expect(banner.title).not.toBe("");
      expect(banner.description).not.toBe("");
    }
    expect(getStatusBannerInfo("assigned", false, false, false).badgeLabel).toBe(
      "准备就绪",
    );
  });

  it("never signals a status with colour alone", () => {
    // Every branch must carry a word, otherwise the banner is a coloured block
    // for anyone who cannot see the colour.
    const statuses = [
      "planned",
      "assigned",
      "suggested",
      "awaiting_approval",
      "running",
      "submitted",
      "auditing",
      "accepted",
      "rejected",
      "failed",
      "done",
      "cancelled",
    ] as const;
    for (const status of statuses) {
      const banner = getStatusBannerInfo(status, false, false, status === "rejected");
      expect(banner.badgeLabel.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("every persisted task status states its next action", () => {
  // Iterate the domain list instead of retyping it. The hand-copied list plus a
  // `Record<string, …>` mapping meant a newly added status could be missing
  // from the copy, absent from the mapping and still pass: tsc said nothing,
  // the banner fell back, and the test celebrated a status it never checked.
  const persisted = TASK_STATUSES;

  // Typed against `TaskStatus`: a status that exists in the database but not
  // here is now a compile error, not a silent fallback.
  const expectedCategory: Record<TaskStatus, TaskNextActionCategory> = {
    planned: "run",
    assigned: "run",
    approved: "run",
    suggested: "adopt_suggestion",
    awaiting_approval: "review_approval",
    running: "wait",
    submitted: "start_audit",
    auditing: "wait_audit",
    needs_review: "review_decision",
    rejected: "fix_and_resubmit",
    failed: "inspect_failure",
    accepted: "mark_done",
    done: "none",
    cancelled: "none",
  };

  it("maps each persisted status to exactly one next-action category", () => {
    for (const status of persisted) {
      const next = getStatusNextAction(status);
      expect(next.category, status).toBe(expectedCategory[status]);
      expect(next.label.trim().length, status).toBeGreaterThan(0);
      expect(next.hint.trim().length, status).toBeGreaterThan(0);
    }
  });

  it("knows which strings are real statuses and refuses to guess", () => {
    for (const status of persisted) {
      expect(isKnownTaskStatus(status), status).toBe(true);
    }
    for (const bogus of ["blocked", "paused", "", "RUNNING", "unknown"]) {
      expect(isKnownTaskStatus(bogus), bogus).toBe(false);
    }
  });

  it("keeps an unknown status visibly unknown instead of dressing it as success", () => {
    const next = getStatusNextAction("blocked");
    expect(next.category).toBe("unknown");
    expect(next.label).toContain("未知");
    // An unrecognised row must not read like a finished task.
    expect(next.label).not.toContain("完成");
    expect(next.label).not.toContain("通过");
  });

  it("does not reuse one category for states that ask for different things", () => {
    // waiting for the auditor and waiting for a human are different moves;
    // collapsing them would tell the reader to do nothing when they must act.
    expect(getStatusNextAction("submitted").category).not.toBe(
      getStatusNextAction("awaiting_approval").category,
    );
    expect(getStatusNextAction("running").category).not.toBe(
      getStatusNextAction("submitted").category,
    );
  });

  it("tells the reader to run a task that is approved but not started", () => {
    // `approved` used to fall through to the generic fallback, which reads like
    // a fresh task. It is a distinct state: a human already cleared the action.
    const banner = getStatusBannerInfo("approved", false, false, false);
    expect(banner.badgeLabel).not.toBe("待执行");
    expect(banner.badgeLabel).toContain("批准");
    expect(banner.description).toContain("执行");
    expect(banner.badgeTone).toBe("blue");
  });

  it("carries the next-action category on the banner so the page cannot drift", () => {
    for (const status of persisted) {
      const banner = getStatusBannerInfo(status, false, false, false);
      expect(banner.nextActionCategory, status).toBe(expectedCategory[status]);
    }
  });

  it("never shows an unknown status as a success banner", () => {
    const banner = getStatusBannerInfo("blocked", false, false, false);
    expect(banner.badgeTone).not.toBe("teal");
    expect(banner.badgeLabel).toContain("未知");
    expect(banner.nextActionCategory).toBe("unknown");
  });
});

describe("tool and step vocabulary", () => {
  it("explains every tool outcome the engine can record", () => {
    const outcomes = [
      "ok",
      "not_connected",
      "skipped",
      "not_configured",
      "unauthorized",
      "rate_limited",
      "timeout",
      "invalid_response",
      "network_error",
      "failed",
    ];
    for (const outcome of outcomes) {
      const meta = TOOL_STATUS_MAP[outcome];
      expect(meta, outcome).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it("does not paint an unconfigured connector as a failure", () => {
    // Nothing was attempted, so red would accuse the wrong party.
    expect(TOOL_STATUS_MAP.not_configured.tone).toBe("neutral");
    expect(TOOL_STATUS_MAP.skipped.tone).toBe("neutral");
    expect(TOOL_STATUS_MAP.unauthorized.tone).toBe("danger");
    expect(TOOL_STATUS_MAP.timeout.tone).toBe("danger");
  });

  it("gives each execution phase a distinct label", () => {
    const phases = ["context", "plan", "tool", "draft", "submit", "audit"];
    const labels = phases.map((phase) => STEP_META[phase].label);
    expect(new Set(labels).size).toBe(phases.length);
  });
});

describe("classifyEvidence separates real sources from demo ones", () => {
  it("marks a demo fixture as simulated even when it has a URL", () => {
    const result = classifyEvidence(
      evidence({ provider: "demo_fixture", url: "https://example.com/a" }),
    );
    expect(result.type).toBe("simulated");
    expect(result.label).toContain("模拟");
    // Simulated must not borrow the success colour.
    expect(result.tone).toBe("neutral");
  });

  it("reserves teal for a source that really came off the network", () => {
    const result = classifyEvidence(evidence({ provider: "tavily" }));
    expect(result.type).toBe("external");
    expect(result.tone).toBe("teal");
  });

  it("calls local memory an internal source, not a web citation", () => {
    const result = classifyEvidence(
      evidence({ kind: "memory", provider: "cabinet", url: "" }),
    );
    expect(result.type).toBe("database");
    expect(result.label).toContain("内部");
  });

  it("falls back to a plain citation when there is no URL at all", () => {
    const result = classifyEvidence(evidence({ provider: "manual", url: "" }));
    expect(result.type).toBe("citation");
    expect(result.tone).toBe("neutral");
  });
});

describe("checklist rules are stated in the user's words", () => {
  it("spells out each machine rule instead of printing its type", () => {
    expect(
      getChecklistRuleLabel({ type: "contains", value: "结论", required: true }),
    ).toBe("包含关键词「结论」");
    expect(
      getChecklistRuleLabel({ type: "min_words", value: 300, required: true }),
    ).toContain("300");
    expect(
      getChecklistRuleLabel({ type: "min_sources", value: 2, required: true }),
    ).toContain("2");
    expect(
      getChecklistRuleLabel({ type: "min_evidence", value: 3, required: true }),
    ).toContain("证据");
    expect(
      getChecklistRuleLabel({ type: "section", value: "风险", required: true }),
    ).toContain("风险");
  });

  it("keeps a manual item honest about needing a human", () => {
    const label = getChecklistRuleLabel({
      type: "manual",
      note: "确认费用",
      required: true,
    });
    expect(label).toContain("人工");
    expect(label).toContain("确认费用");
  });
});

describe("getCurrentAttempt keeps history out of current state", () => {
  function step(overrides: Partial<StepDto>): StepDto {
    return {
      id: "stp_1",
      runId: "run_1",
      idx: 0,
      type: "tool",
      tool: "search",
      input: {},
      output: {},
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  const failedFirstRun = { id: "run_1", status: "failed", error: "检索超时" };
  const retriedOkRun = { id: "run_2", status: "succeeded", error: null };

  it("reports no current failure after a failed attempt is retried", () => {
    // The bug this locks: the banner said 「执行失败」 forever because *some*
    // run in history failed, even though the task had since been retried.
    const attempt = getCurrentAttempt(
      [failedFirstRun, retriedOkRun],
      [
        step({ id: "stp_a", runId: "run_1", output: { status: "failed", error: "检索超时" } }),
        step({ id: "stp_b", runId: "run_2", idx: 1, output: { status: "ok" } }),
      ],
    );

    expect(attempt.latestRun?.id).toBe("run_2");
    expect(attempt.failedRun).toBeUndefined();
    expect(attempt.failedStep).toBeUndefined();
    expect(attempt.failureReason).toBeUndefined();
  });

  it("still reports a failure when the newest attempt is the failed one", () => {
    const attempt = getCurrentAttempt(
      [retriedOkRun, failedFirstRun],
      [
        step({ id: "stp_a", runId: "run_2", output: { status: "ok" } }),
        step({
          id: "stp_b",
          runId: "run_1",
          idx: 1,
          output: { status: "failed", error: "连接器未配置" },
        }),
      ],
    );

    expect(attempt.failedRun?.id).toBe("run_1");
    expect(attempt.failedStep?.id).toBe("stp_b");
    // The run-level error is what the runner recorded; the step error is the
    // detail behind it, so the run wins when both exist.
    expect(attempt.failureReason).toBe("检索超时");
  });

  it("falls back to the failing step's error when the run recorded none", () => {
    const attempt = getCurrentAttempt(
      [{ id: "run_1", status: "failed", error: null }],
      [
        step({
          id: "stp_b",
          runId: "run_1",
          output: { status: "failed", error: "连接器未配置" },
        }),
      ],
    );

    expect(attempt.failureReason).toBe("连接器未配置");
  });

  it("reads the tool step from the newest run, not from the first one listed", () => {
    // `steps` is ordered by idx across all runs, so the oldest attempt's tool
    // step comes first. Reading it under a retried task showed a stale reason.
    const attempt = getCurrentAttempt(
      [failedFirstRun, retriedOkRun],
      [
        step({ id: "stp_old", runId: "run_1", output: { status: "not_configured", reason: "未配置检索" } }),
        step({ id: "stp_new", runId: "run_2", idx: 1, output: { status: "ok", reason: "命中 3 条" } }),
      ],
    );

    expect(attempt.toolStep?.id).toBe("stp_new");
    expect(attempt.toolReason).toBe("命中 3 条");
  });

  it("falls back to a sentence when the run never called a tool", () => {
    const attempt = getCurrentAttempt([retriedOkRun], []);
    expect(attempt.toolStep).toBeUndefined();
    expect(attempt.toolReason).toBe("这次运行没有调用检索工具。");
  });

  it("returns an empty attempt for a task that never ran", () => {
    const attempt = getCurrentAttempt([], []);
    expect(attempt.latestRun).toBeUndefined();
    expect(attempt.failedRun).toBeUndefined();
    expect(attempt.failureReason).toBeUndefined();
    expect(attempt.latestRunSteps).toHaveLength(0);
  });

  it("does not let a stale step from another run decide the current failure", () => {
    const attempt = getCurrentAttempt(
      [{ id: "run_9", status: "running", error: null }],
      [
        step({ id: "stp_other", runId: "run_1", output: { status: "failed", error: "旧错误" } }),
        step({ id: "stp_now", runId: "run_9", idx: 1, output: { status: "ok" } }),
      ],
    );

    expect(attempt.latestRunSteps.map((s) => s.id)).toEqual(["stp_now"]);
    expect(attempt.failedStep).toBeUndefined();
    expect(attempt.failureReason).toBeUndefined();
  });
});

describe("citation relationships between deliverables and evidence", () => {
  const stored = ["evd_a", "evd_b", "evd_c"];

  it("says which stored evidence an artifact body actually cites", () => {
    const relation = getCitationRelationship(
      "结论一 [cite:evd_a]，结论二 [cite:evd_b]。",
      stored,
    );
    expect(relation.cited).toEqual(["evd_a", "evd_b"]);
    expect(relation.unresolved).toEqual([]);
    expect(relation.uncited).toEqual(["evd_c"]);
  });

  it("separates a dangling citation id from a merely uncited evidence row", () => {
    // These are different problems and must not be merged: a dangling id means
    // the text points at something that does not exist (possible fabrication),
    // an uncited row means real material was collected and then ignored.
    const relation = getCitationRelationship(
      "只有一句结论 [cite:evd_a] [cite:evd_ghost]。",
      stored,
    );
    expect(relation.cited).toEqual(["evd_a"]);
    expect(relation.unresolved).toEqual(["evd_ghost"]);
    expect(relation.uncited).toEqual(["evd_b", "evd_c"]);
    expect(relation.unresolved).not.toContain("evd_a");
  });

  it("counts an artifact with no citation markers as uncited, not as grounded", () => {
    const relation = getCitationRelationship("一段没有任何引用标记的结论。", stored);
    expect(relation.cited).toEqual([]);
    expect(relation.unresolved).toEqual([]);
    expect(relation.uncited).toEqual(stored);
  });

  it("does not treat the presence of evidence as proof that a claim is supported", () => {
    // The evidence exists, the artifact is silent about it. Reporting that as
    // "grounded" is exactly the overclaim the design spec forbids.
    const summary = summarizeTaskCitations(
      [{ content: "结论：预算充足。" }],
      stored,
    );
    expect(summary.artifactsWithCitations).toBe(0);
    expect(summary.artifactsWithoutCitations).toBe(1);
    expect(summary.cited).toEqual([]);
    expect(summary.uncited).toEqual(stored);
    // Nothing about this state may be described as verified/supported.
    expect(summary.groundingNote).not.toContain("已支持");
    expect(summary.groundingNote).not.toContain("已验证");
    expect(summary.groundingNote).toContain("未");
  });

  it("merges citations across several artifacts and keeps per-artifact counts", () => {
    const summary = summarizeTaskCitations(
      [
        { content: "A [cite:evd_a]" },
        { content: "B [cite:evd_a] [cite:evd_c] [cite:evd_gone]" },
      ],
      stored,
    );
    expect(summary.cited).toEqual(["evd_a", "evd_c"]);
    expect(summary.unresolved).toEqual(["evd_gone"]);
    expect(summary.uncited).toEqual(["evd_b"]);
    expect(summary.artifactsWithCitations).toBe(2);
    expect(summary.artifactsWithoutCitations).toBe(0);
  });

  it("reports nothing cited when a task has no evidence rows at all", () => {
    const summary = summarizeTaskCitations([{ content: "无来源的结论。" }], []);
    expect(summary.cited).toEqual([]);
    expect(summary.uncited).toEqual([]);
    expect(summary.unresolved).toEqual([]);
    expect(summary.artifactsWithoutCitations).toBe(1);
  });
});

describe("the next-action line follows the banner, not the raw status", () => {
  it("does not tell the reader to wait when the newest run already failed", () => {
    // The task row can still say `running` after a run blew up. The banner
    // reports the failure, so the line beneath it must not say "wait".
    const banner = getStatusBannerInfo("running", false, true, false);
    const next = getNextActionCopy(banner.nextActionCategory);
    expect(banner.badgeLabel).toBe("执行失败");
    expect(next.category).toBe("inspect_failure");
    expect(next.label).not.toContain("等待");
  });

  it("does not tell the reader to wait when an approval is pending", () => {
    const banner = getStatusBannerInfo("running", true, false, false);
    const next = getNextActionCopy(banner.nextActionCategory);
    expect(next.category).toBe("review_approval");
  });

  it("agrees with the status mapping when nothing else is going on", () => {
    for (const status of ["planned", "approved", "submitted", "accepted", "done"]) {
      const banner = getStatusBannerInfo(status, false, false, false);
      expect(getNextActionCopy(banner.nextActionCategory).category, status).toBe(
        getStatusNextAction(status).category,
      );
    }
  });
});

describe("one vocabulary for status words", () => {
  it("does not keep a second, drifting copy of the status labels", () => {
    // contracts/labels.ts is the single source. The presentation layer used to
    // carry its own {label, summary, tone} table, and the two had already
    // diverged: approved read 「已批准待执行」 here and 「已批准」 there.
    for (const status of TASK_STATUSES) {
      const summary = getStatusSummary(status);
      expect(summary.label, status).toBe(statusLabel(status));
      expect(summary.tone, status).toBe(statusTone(status));
    }
  });
});

describe("getStatusSummary refuses anything that is not a persisted status", () => {
  it("does not read inherited object keys as statuses", () => {
    // `TASK_STATUS_META["constructor"]` is truthy on a plain object, so an
    // unguarded lookup reported known:true with every field undefined — an
    // unrecognised row dressed up as a known one.
    for (const bogus of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const summary = getStatusSummary(bogus);
      expect(summary.known, bogus).toBe(false);
      expect(summary.nextActionCategory, bogus).toBe("unknown");
    }
    for (const bogus of ["blocked", "", "RUNNING"]) {
      expect(getStatusSummary(bogus).known, bogus).toBe(false);
    }
  });

  it("still reports every persisted status as known", () => {
    for (const status of TASK_STATUSES) {
      expect(getStatusSummary(status).known, status).toBe(true);
    }
  });
});

describe("the failure banner and the failure panel share one condition", () => {
  it("opens the reason panel when the task itself is failed", () => {
    const presentation = resolveFailurePresentation({
      taskStatus: "failed",
      hasFailedRun: true,
      failureReason: "检索超时",
      isRejected: false,
    });
    expect(presentation.showBanner).toBe(true);
    expect(presentation.showPanel).toBe(true);
    expect(presentation.title).toContain("失败原因");
    expect(presentation.tone).toBe("danger");
  });

  it("still shows the reason after recovery rewound the task to planned", () => {
    // The reachable path: recovery.ts marks the interrupted run failed and
    // rewinds the task row to `planned`. The banner then announced a failure
    // and pointed at a panel that the stricter panel condition skipped, so the
    // reason was only findable by reading the run timeline.
    const presentation = resolveFailurePresentation({
      taskStatus: "planned",
      hasFailedRun: true,
      failureReason: "上游连接器超时",
      isRejected: false,
    });
    expect(presentation.showBanner).toBe(true);
    expect(presentation.showPanel).toBe(true);
    // Wording: the task did not fail, the last run did and was rewound.
    expect(presentation.title).toContain("回退");
    expect(presentation.title).toContain("重试");
    expect(presentation.title).not.toContain("任务执行失败");
  });

  it("does not claim a rewind while the task is still running", () => {
    const presentation = resolveFailurePresentation({
      taskStatus: "running",
      hasFailedRun: true,
      failureReason: "检索超时",
      isRejected: false,
    });
    expect(presentation.showPanel).toBe(true);
    expect(presentation.title).not.toContain("回退");
  });

  it("leaves the reason panel to the rejection card", () => {
    const presentation = resolveFailurePresentation({
      taskStatus: "failed",
      hasFailedRun: true,
      failureReason: "检索超时",
      isRejected: true,
    });
    expect(presentation.showPanel).toBe(false);
  });

  it("claims nothing when no run failed", () => {
    const presentation = resolveFailurePresentation({
      taskStatus: "planned",
      hasFailedRun: false,
      failureReason: undefined,
      isRejected: false,
    });
    expect(presentation.showBanner).toBe(false);
    expect(presentation.showPanel).toBe(false);
    expect(presentation.title).toBe("");
    expect(presentation.tone).toBe("neutral");
  });

  it("does not open an empty panel when there is no reason to show", () => {
    const presentation = resolveFailurePresentation({
      taskStatus: "failed",
      hasFailedRun: true,
      failureReason: undefined,
      isRejected: false,
    });
    expect(presentation.showBanner).toBe(true);
    expect(presentation.showPanel).toBe(false);
  });
});

describe("approval copy does not point at a place the page may lack", () => {
  it("describes the decision itself instead of pointing at a card", () => {
    const next = getNextActionCopy("review_approval");
    expect(next.hint).not.toContain("卡片");
    expect(next.hint).toContain("批准");
    expect(next.hint).toContain("驳回");
    expect(next.label.trim().length).toBeGreaterThan(0);
  });
});

describe("a task that never ran is not described as a run", () => {
  it("says there is no run yet instead of reporting on one", () => {
    // The evidence card printed 「这次运行没有调用检索工具。」 for a task that had no
    // run at all: a claim about a run that does not exist.
    const attempt = getCurrentAttempt([], []);
    expect(attempt.latestRun).toBeUndefined();
    expect(attempt.toolReason).toBe("这个任务还没有运行记录。");
  });
});

describe("pendingDecisionItems lists only what a person still has to settle", () => {
  it("states an undetermined required item exactly as the checklist does", () => {
    // 卡片上的文字必须和验收区那一行一致，否则人去清单里找不到正在判的那一条。
    const pending = pendingDecisionItems([
      {
        item: { type: "contains", value: "结论", required: true },
        passed: true,
        reason: "正文包含「结论」。",
      },
      {
        item: { type: "manual", note: "例子的来源是否真实", required: true },
        passed: false,
        reason: "人工核验项没有判定人。",
        undetermined: true,
      },
    ]);

    expect(pending).toEqual([
      { statement: "人工核验项：例子的来源是否真实", reason: "人工核验项没有判定人。" },
    ]);
  });

  it("keeps the judge wording distinguishable from a manual item", () => {
    const pending = pendingDecisionItems([
      {
        item: { type: "judge", value: "解释为什么闭包能捕获变量", required: true },
        passed: false,
        reason: "没有配置判卷模型。",
        undetermined: true,
      },
    ]);
    expect(pending).toEqual([
      { statement: "模型判卷：解释为什么闭包能捕获变量", reason: "没有配置判卷模型。" },
    ]);
  });

  it("leaves out an optional item nobody judged", () => {
    // 可选条目缺席本来就不挡判定，把它列进"待你判定"是在替清单加要求。
    const pending = pendingDecisionItems([
      {
        item: { type: "manual", note: "有时间可以核一下", required: false },
        passed: false,
        reason: "人工核验项没有判定人。",
        undetermined: true,
      },
    ]);
    expect(pending).toEqual([]);
  });

  it("does not ask for a verdict on an item the auditor already failed", () => {
    // passed=false 而 undetermined 不为真：结论已经有了（不通过），
    // 需要的是改产物，不是人再判一次。
    const pending = pendingDecisionItems([
      {
        item: { type: "min_words", value: 300, required: true },
        passed: false,
        reason: "正文 120 字，少于 300 字。",
      },
    ]);
    expect(pending).toEqual([]);
  });

  it("does not re-open a judge item that already got a ruling", () => {
    const pending = pendingDecisionItems([
      {
        item: { type: "judge", value: "结论有来源支撑", required: true },
        passed: true,
        reason: "判卷模型给出通过。",
        undetermined: false,
      },
    ]);
    expect(pending).toEqual([]);
  });

  it("returns nothing for a task that has no report at all", () => {
    expect(pendingDecisionItems(null)).toEqual([]);
    expect(pendingDecisionItems(undefined)).toEqual([]);
    expect(pendingDecisionItems([])).toEqual([]);
  });

  it("keeps the report's order so the card matches the checklist below it", () => {
    const pending = pendingDecisionItems([
      {
        item: { type: "manual", note: "第一项", required: true },
        passed: false,
        reason: "没人判。",
        undetermined: true,
      },
      {
        item: { type: "min_words", value: 10, required: true },
        passed: true,
        reason: "字数够。",
      },
      {
        item: { type: "manual", note: "第二项", required: true },
        passed: false,
        reason: "也没人判。",
        undetermined: true,
      },
    ]);
    expect(pending.map((entry) => entry.statement)).toEqual([
      "人工核验项：第一项",
      "人工核验项：第二项",
    ]);
  });
});
describe("the page narrates the rejection that is current, not one the window still holds", () => {
  const auditorReject = {
    after: { reason: "缺少 rerank 章节。" } as Record<string, unknown>,
    createdAt: "2026-10-20T02:00:00.000Z",
  };
  const userReject = {
    decision: "rejected",
    reason: "结论对，但证据没标出处。",
    decidedAt: "2026-10-26T03:00:00.000Z",
  };

  it("does not keep calling a resubmitted task rejected", () => {
    // 重新提交不写审计事件，所以十行审计窗口里最新的一条仍是上次的
    // audit.reject；旧判据（status==="rejected" || 窗口里有 audit.reject）
    // 会把"已提交、等待复验"的任务画成"被驳回"。
    const current = resolveRejectionPresentation({
      taskStatus: "submitted",
      override: null,
      auditorReject,
    });
    expect(current).toEqual({
      isRejected: false,
      byUser: false,
      reason: undefined,
      at: null,
    });
  });

  it("credits the user's own rejection instead of an older auditor one", () => {
    const current = resolveRejectionPresentation({
      taskStatus: "rejected",
      override: userReject,
      auditorReject,
    });
    // 窗口里那条 audit.reject 属于上一次尝试，不能拿来当"当前的驳回原因"。
    expect(current).toEqual({
      isRejected: true,
      byUser: true,
      reason: "结论对，但证据没标出处。",
      at: "2026-10-26T03:00:00.000Z",
    });
  });

  it("attributes an auditor rejection to the auditor, with its own timestamp", () => {
    const current = resolveRejectionPresentation({
      taskStatus: "rejected",
      override: null,
      auditorReject,
    });
    expect(current).toEqual({
      isRejected: true,
      byUser: false,
      reason: "缺少 rerank 章节。",
      at: "2026-10-20T02:00:00.000Z",
    });
  });

  it("leaves the reason empty when the event has none, so the page can say so", () => {
    const current = resolveRejectionPresentation({
      taskStatus: "rejected",
      override: null,
      auditorReject: { after: null, createdAt: "2026-10-20T02:00:00.000Z" },
    });
    expect(current.reason).toBeUndefined();
    expect(current.isRejected).toBe(true);
  });
});
describe("the checklist badge tells failures apart from items nobody judged", () => {
  const checklist: AcceptanceItemDto[] = [
    { type: "contains", value: "RAG", required: true },
    { type: "judge", value: "能解释清楚", required: true },
    { type: "min_words", value: 20, required: false },
  ];

  it("does not count an undetermined item as a failure", () => {
    // domain/acceptance.ts 给 undetermined 的条目 `passed: false`：拿 `!passed`
    // 数失败，就会把「没人判过」印成「未通过」，而「需人工复核」永远显示不出来。
    const tally = tallyChecklist(checklist, [
      { item: checklist[0], passed: true, reason: "包含关键词。" },
      {
        item: checklist[1],
        passed: false,
        reason: "需要模型判定。",
        undetermined: true,
      },
      { item: checklist[2], passed: true, reason: "字数够。" },
    ]);

    expect(tally).toEqual({
      total: 3,
      passed: 2,
      failed: 0,
      undetermined: 1,
      pending: 0,
    });
    expect(checklistBadge(tally)).toEqual({
      kind: "undetermined",
      tone: "accent",
      label: "需人工复核 (1 项)",
    });
  });

  it("keeps a real failure and says how many items are still waiting", () => {
    const tally = tallyChecklist(checklist, [
      { item: checklist[0], passed: false, reason: "缺少关键词。" },
      {
        item: checklist[1],
        passed: false,
        reason: "需要模型判定。",
        undetermined: true,
      },
      { item: checklist[2], passed: true, reason: "字数够。" },
    ]);

    expect(tally.failed).toBe(1);
    expect(checklistBadge(tally)).toEqual({
      kind: "failed",
      tone: "danger",
      label: "未通过 (1/3) · 待复核 1 项",
    });
  });

  it("says the audit has not run yet when there is no report", () => {
    const tally = tallyChecklist(checklist, null);
    expect(tally.pending).toBe(3);
    expect(checklistBadge(tally)).toEqual({
      kind: "pending",
      tone: "neutral",
      label: "待验收 (3 项)",
    });
  });

  it("reports a checklist that passed in full, and nothing for an empty one", () => {
    const passed = checklistBadge(
      tallyChecklist(checklist, [
        { item: checklist[0], passed: true, reason: "ok" },
        { item: checklist[1], passed: true, reason: "ok" },
        { item: checklist[2], passed: true, reason: "ok" },
      ]),
    );
    expect(passed).toEqual({
      kind: "passed",
      tone: "teal",
      label: "全部通过 (3/3)",
    });

    expect(checklistBadge(tallyChecklist([], null))).toBeNull();
  });
});

describe("the task page hands the banner its rejection attribution", () => {
  const page = readFileSync(
    join(process.cwd(), "src/app/tasks/[id]/page.tsx"),
    "utf8",
  );

  it("passes the byUser flag that resolveRejectionPresentation computed", () => {
    // 横幅要能分辨「Auditor 判的」和「你自己判的」，而这个事实只有页面手里
    // 有（override 行）。少传这一位，函数本身再对也没用。
    expect(page).toMatch(/getStatusBannerInfo\([\s\S]{0,400}rejection\.byUser/);
  });
});

describe("the approval blocks name the row that is actually waiting", () => {
  // 一条任务会留下多行审批：approvals.ts 只对「还在等」的那行去重，前面那次
  // 运行花掉的批准以 approved 留在表里。页面原来印的是 approvals[0]，而查询
  // 没有 ORDER BY——横幅于是常念上一轮已经批过的动作和它的旧理由。
  const rows = [
    { id: "appr_old", status: "approved", action: "external" },
    { id: "appr_new", status: "pending", action: "spend" },
  ];

  it("picks the pending approval, not whichever row came back first", () => {
    expect(pendingApprovalFor(rows)?.id).toBe("appr_new");
    expect(pendingApprovalFor([rows[0]])).toBeUndefined();
  });

  it("shows the pending row first so a decided one cannot cover it", () => {
    expect(pendingApprovalsFirst(rows).map((row) => row.id)).toEqual([
      "appr_new",
      "appr_old",
    ]);
    expect(pendingApprovalsFirst([rows[0]]).map((row) => row.id)).toEqual(["appr_old"]);
  });

  it("stops calling a fully decided history a request for approval", () => {
    expect(approvalCardHeading(true)).toEqual({
      eyebrow: "Approval Required",
      title: "需要批准",
    });
    expect(approvalCardHeading(false)).toEqual({
      eyebrow: "Approval History",
      title: "审批记录",
    });
  });

  it("wires the page to the pending row and to the labels, not to the raw keys", () => {
    const page = readFileSync(join(process.cwd(), "src/app/tasks/[id]/page.tsx"), "utf8");
    expect(page).toContain("pendingApprovalFor(approvals)");
    expect(page).toContain("actionTypeLabel(pendingApproval.action)");
    expect(page).toContain("actionTypeLabel(approval.action)");
    expect(page).toContain("title={approvalHeading.title}");
    expect(page).not.toContain("approvals[0].action");
  });

  it("does not toast a spend approval as an external action", () => {
    const actions = readFileSync(
      join(process.cwd(), "src/components/actions/task-actions.tsx"),
      "utf8",
    );
    expect(actions).toContain(
      'const actionName = actionType ? actionTypeLabel(actionType) : "这次执行";',
    );
    expect(actions).not.toContain("已批准外部动作");
  });
});
