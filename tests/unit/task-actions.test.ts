import { describe, expect, it } from "vitest";
import { taskActions } from "@/lib/domain/task-actions";

const base = { hasAssignee: true, hasAuditor: true };

describe("task actions", () => {
  it("lets a planned task run but not audit", () => {
    const actions = taskActions({ ...base, status: "planned" });
    expect(actions.run.allowed).toBe(true);
    expect(actions.audit.allowed).toBe(false);
    expect(actions.audit.reason).toContain("还没有执行");
  });

  it("lets a submitted task be audited but not re-run", () => {
    const actions = taskActions({ ...base, status: "submitted" });
    expect(actions.audit.allowed).toBe(true);
    expect(actions.run.allowed).toBe(false);
    expect(actions.run.reason).toContain("等待验收");
  });

  it("offers a retry after rejection", () => {
    const actions = taskActions({ ...base, status: "rejected" });
    expect(actions.run.allowed).toBe(true);
    expect(actions.audit.allowed).toBe(false);
    expect(actions.audit.reason).toContain("重新执行");
  });

  it("does not let a task awaiting approval be executed", () => {
    const actions = taskActions({ ...base, status: "awaiting_approval" });
    expect(actions.run.allowed).toBe(false);
    expect(actions.run.reason).toContain("批准");
  });

  it("only offers promote while a suggestion is pending", () => {
    expect(taskActions({ ...base, status: "suggested" }).promote.allowed).toBe(true);
    expect(taskActions({ ...base, status: "planned" }).promote.allowed).toBe(false);
  });

  it("never enables an action that has no owner", () => {
    const actions = taskActions({ status: "planned", hasAssignee: false, hasAuditor: false });
    expect(actions.run.allowed).toBe(false);
    expect(actions.run.reason).toBe("任务没有执行者");
    expect(actions.audit.allowed).toBe(false);
    expect(actions.audit.reason).toBe("任务没有验收者");
  });

  it("marks a finished task as neither runnable nor auditable", () => {
    const actions = taskActions({ ...base, status: "done" });
    expect(actions.run.allowed).toBe(false);
    expect(actions.audit.allowed).toBe(false);
  });
});
