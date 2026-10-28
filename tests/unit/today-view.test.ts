import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TASK_STATUSES } from "@/contracts";
import {
  briefTaskSnapshot,
  buildTodayActionQueue,
  formatPercentValue,
  formatRatioAsPercent,
  getProvenanceLabel,
  getTaskTypeLabel,
  inFlightTasks,
  needsAttention,
  pickLearningTask,
  queuedTaskIds,
  secondaryTasks,
  weeklyMetricRows,
} from "@/lib/presentation/today-view";

/**
 * The demo reader lives in Asia/Shanghai, so every queue below is built for
 * that zone. The zone is a required input of the builder precisely because
 * omitting it once cost every approval its "when".
 */
const TZ = "Asia/Shanghai";

describe("weekly metrics are formatted by their own unit", () => {
  // The bug this guards against: `recallAvg` is a 0–1 ratio while `adherence`
  // and `retestPassRate` are already 0–100. Applying one helper to both shows
  // "6250%" on a page people trust.
  it("multiplies a ratio but never an already-percent value", () => {
    expect(formatRatioAsPercent(0.4)).toBe("40%");
    expect(formatPercentValue(63)).toBe("63%");
    expect(formatPercentValue(0.63)).toBe("1%");
  });

  it("keeps 'no samples' distinct from zero", () => {
    expect(formatRatioAsPercent(null)).toBe("—");
    expect(formatPercentValue(null)).toBe("—");
    expect(formatRatioAsPercent(0)).toBe("0%");
    expect(formatPercentValue(0)).toBe("0%");
  });

  it("renders a realistic week without inventing impossible numbers", () => {
    const rows = weeklyMetricRows({
      studyMinutes: 40,
      recallAvg: 0.4,
      adherence: 63,
      learningTasks: 2,
      retestPassRate: null,
      goalProgress: 38,
    });
    const byLabel = new Map(rows.map((row) => [row.label, row.value]));
    expect(byLabel.get("学习专注")).toBe("40m");
    expect(byLabel.get("回忆正确率")).toBe("40%");
    expect(byLabel.get("计划遵从率")).toBe("63%");
    expect(byLabel.get("复测通过率")).toBe("—");
    expect(byLabel.get("目标总进度")).toBe("38%");

    for (const row of rows) {
      const numeric = Number(row.value.replace(/[^0-9.]/g, ""));
      if (row.value !== "—") {
        expect(numeric).toBeLessThanOrEqual(100);
      }
    }
  });

  it("emits a stable key per metric so the grid never reshuffles", () => {
    const rows = weeklyMetricRows({
      studyMinutes: 0,
      recallAvg: null,
      adherence: null,
      learningTasks: 0,
      retestPassRate: null,
      goalProgress: 0,
    });
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.key)).size).toBe(6);
    expect(rows.map((row) => row.key)).toEqual([
      "study",
      "recall",
      "adherence",
      "learning",
      "retest",
      "goal",
    ]);
  });

  it("explains each number instead of leaving a bare label", () => {
    const rows = weeklyMetricRows({
      studyMinutes: 1,
      recallAvg: 0.5,
      adherence: 50,
      learningTasks: 1,
      retestPassRate: 50,
      goalProgress: 50,
    });
    for (const row of rows) {
      expect(row.hint.length).toBeGreaterThan(0);
      expect(row.label.length).toBeGreaterThan(0);
    }
  });
});

describe("pickLearningTask offers exactly one next step", () => {
  const task = (id: string, template: string | null, status: string) => ({
    id,
    template,
    status,
  });

  it("picks the first open learning task in list order", () => {
    const picked = pickLearningTask([
      task("a", "learning", "planned"),
      task("b", "learning", "planned"),
    ]);
    expect(picked?.id).toBe("a");
  });

  it("skips learning tasks that are already closed", () => {
    const picked = pickLearningTask([
      task("a", "learning", "done"),
      task("b", "learning_retest", "accepted"),
      task("c", "learning", "failed"),
      task("d", "learning", "cancelled"),
      task("e", "learning_retest", "assigned"),
    ]);
    expect(picked?.id).toBe("e");
  });

  it("returns nothing rather than a non-learning task", () => {
    expect(
      pickLearningTask([task("a", null, "planned"), task("b", "audit", "planned")]),
    ).toBeUndefined();
  });

  it("still offers a retest task while it waits for approval", () => {
    // Awaiting approval is not closed: the human still has a move to make.
    const picked = pickLearningTask([task("a", "learning_retest", "awaiting_approval")]);
    expect(picked?.id).toBe("a");
  });

  it("handles an empty list", () => {
    expect(pickLearningTask([])).toBeUndefined();
  });
});

describe("task descriptions use words a reader understands", () => {
  it("names the learning templates rather than printing their ids", () => {
    expect(getTaskTypeLabel({ template: "learning", actionType: "internal" })).toBe(
      "针对性学习",
    );
    expect(
      getTaskTypeLabel({ template: "learning_retest", actionType: "internal" }),
    ).toBe("间隔复测");
  });

  it("labels every action type the API can actually store", () => {
    // The enum lives in `taskCreateSchema.actionType`. If a value is added
    // there, this test fails until it has words.
    const actionTypes = [
      "internal",
      "internal_read",
      "external",
      "spend",
      "publish",
      "message",
      "book",
    ];
    const labels = actionTypes.map((actionType) =>
      getTaskTypeLabel({ template: null, actionType }),
    );
    for (const label of labels) {
      // Chinese, not the raw enum value.
      expect(label).not.toBe("");
      expect(label).toMatch(/[\u4e00-\u9fa5]/);
    }
    // A read-only task and a normal task are not the same thing.
    expect(
      getTaskTypeLabel({ template: null, actionType: "internal" }),
    ).not.toBe(getTaskTypeLabel({ template: null, actionType: "internal_read" }));
  });

  it("falls back to a plain label when there is no metadata at all", () => {
    expect(getTaskTypeLabel({ template: null, actionType: "" })).toBe("常规任务");
  });

  it("never renders an internal identifier verbatim", () => {
    // A template is an internal name; showing `custom_flow` to the reader is
    // the same bug as showing `internal_read`.
    const label = getTaskTypeLabel({
      template: "custom_flow",
      actionType: "internal",
    });
    expect(label).not.toContain("custom_flow");
    expect(label).toBe("内部任务");
  });

  it("says who created the task", () => {
    expect(getProvenanceLabel("user")).toBe("用户手动");
    expect(getProvenanceLabel("agent")).toBe("Agent 自主");
    expect(getProvenanceLabel("system")).toBe("系统调度");
    expect(getProvenanceLabel("import")).toContain("import");
  });
});

describe("the action queue puts interventions first, in a fixed order", () => {
  const approval = (
    id: string,
    taskId: string | null,
    payload: Record<string, unknown> = {},
  ) => ({ id, taskId, action: "book_session", payload });
  const task = (id: string, status: string, dueAt: string | null = null) => ({
    id,
    title: `任务 ${id}`,
    status,
    dueAt,
  });

  it("orders approvals, then the council, then attention tasks", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [approval("appr_1", "tsk_1")],
      council: { id: "cnc_1", topic: "是否继续投入英语", trigger: "预算超出" },
      tasks: [
        task("tsk_ok", "running"),
        task("tsk_failed", "failed"),
        task("tsk_rejected", "rejected"),
        task("tsk_wait", "awaiting_approval"),
      ],
    });

    expect(queue.items.map((item) => item.kind)).toEqual([
      "approval",
      "council",
      "task",
      "task",
      "task",
    ]);
    expect(queue.items.map((item) => item.refId)).toEqual([
      "appr_1",
      "cnc_1",
      "tsk_wait",
      "tsk_rejected",
      "tsk_failed",
    ]);
  });

  it("keeps that order stable regardless of the input order", () => {
    const input = {
      timeZone: TZ,
      approvals: [approval("appr_1", null)],
      council: { id: "cnc_1", topic: "议题", trigger: "触发" },
      tasks: [task("tsk_failed", "failed"), task("tsk_wait", "awaiting_approval")],
    };
    const forward = buildTodayActionQueue(input);
    const shuffled = buildTodayActionQueue({
      ...input,
      tasks: [...input.tasks].reverse(),
    });
    expect(shuffled.items.map((item) => item.key)).toEqual(
      forward.items.map((item) => item.key),
    );
  });

  it("breaks ties inside one status by due date, then by id", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [
        task("tsk_c", "failed", "2030-01-03T00:00:00.000Z"),
        task("tsk_a", "failed", "2030-01-01T00:00:00.000Z"),
        task("tsk_b", "failed", null),
      ],
    });
    expect(queue.items.map((item) => item.refId)).toEqual([
      "tsk_a",
      "tsk_c",
      "tsk_b",
    ]);
  });

  it("leaves active tasks out of the queue", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [
        task("tsk_running", "running"),
        task("tsk_planned", "planned"),
        task("tsk_done", "done"),
      ],
    });
    expect(queue.items).toHaveLength(0);
    expect(queue.counts.task).toBe(0);
  });

  it("treats a task status as the only thing that makes a task an action", () => {
    // The grouping is a presentation concept. It must never leak into the
    // domain status list, or the API would start reporting a status that no
    // transition knows how to leave.
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [task("tsk_wait", "awaiting_approval")],
    });
    for (const item of queue.items) {
      expect(item.status === null || TASK_STATUSES.includes(item.status as never)).toBe(
        true,
      );
    }
    expect(TASK_STATUSES.includes("action" as never)).toBe(false);
    expect(TASK_STATUSES.includes("needs_attention" as never)).toBe(false);
  });

  it("points every category at a route the app already serves", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [approval("appr_1", "tsk_1")],
      council: { id: "cnc_1", topic: "议题", trigger: "触发" },
      tasks: [task("tsk_wait", "awaiting_approval")],
    });
    const hrefs = queue.items.map((item) => item.href);
    for (const href of hrefs) {
      expect(href.startsWith("/")).toBe(true);
      expect(href).not.toContain("//");
    }
    expect(hrefs).toEqual(["/tasks/tsk_1", "/council", "/tasks/tsk_wait"]);
  });

  it("names what is blocked and what the reader should do next", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [approval("appr_1", "tsk_1", { title: "预约外教课", costCents: 18000 })],
      council: { id: "cnc_1", topic: "是否继续投入英语", trigger: "预算超出" },
      tasks: [task("tsk_failed", "failed")],
    });
    const [first] = queue.items;
    expect(first.title).toContain("预约外教课");
    expect(first.detail).toContain("180.00");
    for (const item of queue.items) {
      expect(item.hint.length).toBeGreaterThan(0);
      expect(item.title.length).toBeGreaterThan(0);
    }
    const failed = queue.items.find((item) => item.refId === "tsk_failed");
    expect(failed?.hint).toBe("执行失败，需要你判断是否重试。");
  });

  it("returns an explicit empty view model, not undefined or a bare array", () => {
    const queue = buildTodayActionQueue({ timeZone: TZ, approvals: [], council: null, tasks: [] });
    expect(queue).toBeDefined();
    expect(Array.isArray(queue.items)).toBe(true);
    expect(queue.items).toEqual([]);
    expect(queue.isEmpty).toBe(true);
    expect(queue.counts).toEqual({ approval: 0, council: 0, task: 0, total: 0 });
    expect(queue.empty.title.length).toBeGreaterThan(0);
    expect(queue.empty.hint.length).toBeGreaterThan(0);
  });

  it("reports the same emptiness for tasks that need nothing", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [task("tsk_running", "running"), task("tsk_done", "done")],
    });
    expect(queue.isEmpty).toBe(true);
    expect(queue.empty.title).toBe(
      buildTodayActionQueue({ timeZone: TZ, approvals: [], council: null, tasks: [] }).empty.title,
    );
  });

  it("counts each category and never double counts", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [approval("appr_1", "tsk_1"), approval("appr_2", "tsk_2")],
      council: { id: "cnc_1", topic: "议题", trigger: "触发" },
      tasks: [task("tsk_wait", "awaiting_approval"), task("tsk_failed", "failed")],
    });
    expect(queue.counts).toEqual({ approval: 2, council: 1, task: 2, total: 5 });
    expect(new Set(queue.items.map((item) => item.key)).size).toBe(queue.items.length);
  });

  it("does not turn an open council meeting into a task", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: { id: "cnc_1", topic: "议题", trigger: "触发" },
      tasks: [],
    });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].kind).toBe("council");
    expect(queue.items[0].status).toBeNull();
    expect(queue.counts.task).toBe(0);
    expect(queuedTaskIds(queue).size).toBe(0);
  });

  it("treats cancelled and finished work as needing nothing", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [
        task("tsk_cancelled", "cancelled"),
        task("tsk_accepted", "accepted"),
        task("tsk_done", "done"),
      ],
    });
    expect(queue.isEmpty).toBe(true);
  });

  it("flags exactly the attention statuses and nothing else", () => {
    for (const status of [
      "needs_review",
      "awaiting_approval",
      "rejected",
      "failed",
      "suggested",
    ]) {
      expect(needsAttention(status)).toBe(true);
    }
    for (const status of ["planned", "assigned", "running", "submitted", "done"]) {
      expect(needsAttention(status)).toBe(false);
    }
  });

  /*
    A `suggested` task is not progress: the agent wrote a draft and stopped, and
    the task page says so in as many words ("等待你审核…由主理人确认采纳后方可继续").
    It used to be listed under "其他推进中的任务" while the header counted it as
    neither 待处理 nor 推进中 — one task, three different claims.
  */
  it("queues a suggestion that is waiting to be adopted", () => {
    const tasks = [
      { id: "tsk_suggested", status: "suggested", title: "重写周报结构", dueAt: null },
      { id: "tsk_running", status: "running", title: "整理笔记", dueAt: null },
    ];
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks,
    });

    expect(queue.items.map((item) => item.refId)).toEqual(["tsk_suggested"]);
    expect(queue.items[0].hint).toContain("采纳或驳回");
    expect(queue.items[0].href).toBe("/tasks/tsk_suggested");
    expect(queue.counts.task).toBe(1);
    expect(inFlightTasks(tasks).map((task) => task.id)).toEqual(["tsk_running"]);
    expect(secondaryTasks(tasks, queue).map((task) => task.id)).toEqual(["tsk_running"]);
  });
});

describe("the secondary list never repeats the action queue", () => {
  const task = (id: string, status: string) => ({
    id,
    status,
    title: id,
    dueAt: null,
  });

  it("drops tasks that are already in the queue", () => {
    const tasks = [
      task("tsk_wait", "awaiting_approval"),
      task("tsk_running", "running"),
      task("tsk_failed", "failed"),
    ];
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks,
    });
    const rest = secondaryTasks(tasks, queue);
    expect(rest.map((t) => t.id)).toEqual(["tsk_running"]);
    expect(queuedTaskIds(queue)).toEqual(new Set(["tsk_wait", "tsk_failed"]));
  });

  it("keeps every task when the queue is empty", () => {
    const tasks = [task("tsk_a", "running"), task("tsk_b", "planned")];
    const queue = buildTodayActionQueue({ timeZone: TZ, approvals: [], council: null, tasks });
    expect(secondaryTasks(tasks, queue).map((t) => t.id)).toEqual([
      "tsk_a",
      "tsk_b",
    ]);
  });

  it("does not mutate the list it was given", () => {
    const tasks = [task("tsk_wait", "awaiting_approval"), task("tsk_run", "running")];
    const queue = buildTodayActionQueue({ timeZone: TZ, approvals: [], council: null, tasks });
    secondaryTasks(tasks, queue);
    expect(tasks.map((t) => t.id)).toEqual(["tsk_wait", "tsk_run"]);
  });
});

describe("the next step never repeats the action queue either", () => {
  const learning = (id: string, status: string) => ({
    id,
    template: "learning_retest",
    status,
  });

  it("skips a learning task the queue already surfaced", () => {
    const tasks = [
      learning("tsk_wait", "awaiting_approval"),
      learning("tsk_next", "planned"),
    ];
    const picked = pickLearningTask(tasks, {
      excludeIds: new Set(["tsk_wait"]),
    });
    expect(picked?.id).toBe("tsk_next");
  });

  it("still returns the task when nothing is excluded", () => {
    expect(pickLearningTask([learning("tsk_wait", "awaiting_approval")])?.id).toBe(
      "tsk_wait",
    );
  });
});

describe("an approval always says when it is due", () => {
  const approvalAt = (payload: Record<string, unknown>) => ({
    id: "appr_when",
    taskId: "tsk_1",
    action: "book_session",
    payload,
  });
  const detailOf = (payload: Record<string, unknown>) =>
    buildTodayActionQueue({
      timeZone: TZ,
      approvals: [approvalAt(payload)],
      council: null,
      tasks: [],
    }).items[0].detail;

  it("renders dueAt in the reader's zone, never as its UTC date", () => {
    // 21:00Z is 05:00 on Jan 2 in Shanghai. "01-01" means the UTC date leaked.
    const detail = detailOf({
      title: "预约外教课",
      dueAt: "2030-01-01T21:00:00.000Z",
    });
    expect(detail).toContain("01/02 05:00");
    expect(detail).not.toContain("01/01");
    expect(detail).not.toContain("2030-01-01");
  });

  it("falls back to the human-written time when the approval has no dueAt", () => {
    // src/lib/db/seed.ts:1259 writes exactly this shape.
    expect(detailOf({ title: "周会", time: "周三 20:00" })).toContain(
      "周三 20:00",
    );
  });

  it("says nothing about time when neither field is set", () => {
    const detail = detailOf({ title: "没有时间的审批" });
    expect(detail).not.toContain("未设置");
    expect(detail).toBe("");
  });

  it("keeps the cost and the reason next to the time", () => {
    const detail = detailOf({
      title: "预约",
      dueAt: "2030-01-01T21:00:00.000Z",
      estimatedCostCents: 18000,
      reason: "外教排期",
    });
    expect(detail).toContain("01/02 05:00");
    expect(detail).toContain("180.00");
    expect(detail).toContain("外教排期");
  });
});

describe("inFlightTasks keeps only the work that is actually moving", () => {
  const status = (id: string) => ({
    id,
    title: `任务 ${id}`,
    status: id,
    dueAt: null as string | null,
  });
  const ids = (statuses: string[]) =>
    inFlightTasks(statuses.map(status)).map((task) => task.id);

  it("keeps every status where an Agent still owes the next move", () => {
    expect(
      ids(["planned", "assigned", "approved", "running", "submitted", "accepted"]),
    ).toEqual(["planned", "assigned", "approved", "running", "submitted", "accepted"]);
  });

  it("drops failed and awaiting_approval, which the queue already owns", () => {
    const kept = inFlightTasks(
      ["failed", "awaiting_approval", "running"].map(status),
    );
    expect(kept.map((task) => task.status)).toEqual(["running"]);
  });

  it("treats rejected, suggested, cancelled, done and auditing as not in flight", () => {
    expect(
      ids(["rejected", "suggested", "cancelled", "done", "auditing"]),
    ).toEqual([]);
  });

  it("defaults an unknown status to not in flight", () => {
    // A new status must not silently inflate the "推进中" counter.
    expect(ids(["brand_new"])).toEqual([]);
  });

  it("keeps the given order and does not mutate the list", () => {
    const tasks = [status("running"), status("failed"), status("planned")];
    expect(inFlightTasks(tasks).map((task) => task.id)).toEqual([
      "running",
      "planned",
    ]);
    expect(tasks).toHaveLength(3);
  });
});

describe("the brief badge quotes the snapshot it was generated from", () => {
  it("reads the task count stored with the brief", () => {
    expect(briefTaskSnapshot({ metrics: { tasks: 5, decisions: 2 } })).toBe(5);
  });

  it("refuses to borrow a number it was not given", () => {
    // Rows written before the metric existed, and rows whose jsonb holds a
    // string, must not make the card print today's count as the brief's basis.
    expect(briefTaskSnapshot({ metrics: {} })).toBeNull();
    expect(briefTaskSnapshot({ metrics: { tasks: "5" } })).toBeNull();
    expect(briefTaskSnapshot(null)).toBeNull();
    expect(briefTaskSnapshot(undefined)).toBeNull();
  });
});

describe("a queued task's deadline is a local date", () => {
  const failed = (dueAt: string | null) => ({
    id: "tsk_late",
    title: "补交作业",
    status: "failed",
    dueAt,
  });

  it("formats the due date in the reader's zone instead of slicing UTC", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [failed("2030-01-01T21:00:00.000Z")],
    });
    // 21:00Z is Jan 2 in Shanghai; "2030-01-01" is the UTC slice this replaced.
    expect(queue.items[0].detail).toBe("截止 01/02");
  });

  it("still says a task has no deadline when it has none", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [failed(null)],
    });
    expect(queue.items[0].detail).toBe("未设置截止时间");
  });
});

describe("the empty queue describes everything it can hold", () => {
  it("mentions the council meeting it always shows", () => {
    const queue = buildTodayActionQueue({
      timeZone: TZ,
      approvals: [],
      council: null,
      tasks: [],
    });
    expect(queue.empty.hint).toContain("内阁");
  });
});

/**
 * The Today page is a server component that needs a live database, so its
 * composition rules are guarded as source contracts. "Which list feeds the
 * counter" and "the empty state must not contradict the queue above it" are
 * exactly the rules a rendering test would otherwise be the only way to catch.
 */
describe("the Today page renders the view model it was handed", () => {
  const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");

  it("never counts every open task as progress", () => {
    // data.tasks carries failed and awaiting_approval tasks too.
    expect(page).not.toContain("data.tasks.length");
  });

  it("offers only in-flight tasks as something to check off", () => {
    expect(page).toContain("tasks={inFlight");
  });

  it("does not claim there is no learning task while one waits in the queue", () => {
    expect(page).toContain("待处理队列");
  });
});

