import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkinReportOnlyNote,
  checkinRowHint,
  checkinTaskBuckets,
} from "@/lib/presentation/checkin-view";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

// saveCheckin 只放行 accepted → done（src/server/services/commands/checkins.ts:85-103），
// 所以卡片必须说清哪一行勾了真的会关任务，哪一行只是自报。
describe("check-in task checkboxes", () => {
  it("only offers to close the tasks the state machine will close", () => {
    const tasks = [
      { id: "tsk_planned", status: "planned" },
      { id: "tsk_accepted", status: "accepted" },
      { id: "tsk_submitted", status: "submitted" },
      { id: "tsk_running", status: "running" },
    ];

    const { closable, reportOnly } = checkinTaskBuckets(tasks);

    expect(closable.map((t) => t.id)).toEqual(["tsk_accepted"]);
    // 顺序保持传入顺序：列表的顺序是用户看到的顺序。
    expect(reportOnly.map((t) => t.id)).toEqual([
      "tsk_planned",
      "tsk_submitted",
      "tsk_running",
    ]);
  });

  it("puts an unknown status in the report-only bucket", () => {
    // 少承诺一个会关闭的任务，比承诺一个不会关闭的好。
    const { closable, reportOnly } = checkinTaskBuckets([
      { id: "tsk_whatever", status: "brand_new_status" },
    ]);
    expect(closable).toEqual([]);
    expect(reportOnly.map((t) => t.id)).toEqual(["tsk_whatever"]);
  });

  it("says nothing on a row that ticking will really close", () => {
    expect(checkinRowHint("accepted")).toBeNull();
  });

  it("names what is still missing on the rows that only get recorded", () => {
    expect(checkinRowHint("submitted")).toBe("待验收 · 只记录");
    expect(checkinRowHint("auditing")).toBe("验收中 · 只记录");
    expect(checkinRowHint("planned")).toBe("还没通过验收 · 只记录");
  });

  it("drops the caveat when every task can be closed", () => {
    expect(checkinReportOnlyNote(0)).toBeNull();
    expect(checkinReportOnlyNote(Number.NaN)).toBeNull();
  });

  it("tells the reader the record and the task state are different things", () => {
    const note = checkinReportOnlyNote(3);
    expect(note).toContain("3 项");
    expect(note).toContain("任务状态不会变");
    expect(note).toContain("check-in");
  });

  it("feeds the form and the page from the same rule", () => {
    // 源码契约：卡片用的是这一层判定，首页也就必须把 status 传下去。
    const form = source("src/components/actions/task-actions.tsx");
    expect(form).toContain("checkinTaskBuckets(tasks)");
    expect(form).toContain("checkinRowHint(t.status)");
    expect(form).toContain("checkinReportOnlyNote(reportOnly.length)");
    const page = source("src/app/page.tsx");
    expect(page).toContain("status: t.status,");
  });
});
