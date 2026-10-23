import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  agents,
  runs,
  tasks,
} from "@/lib/db/schema";
import { runTask } from "@/lib/engine";
import { resetDb } from "../helpers/db";

const TASK_ID = "tsk_race_claim";

async function makeTask() {
  await db.insert(tasks).values({
    id: TASK_ID,
    userId: DEMO_USER_ID,
    title: "并发认领同一个任务",
    description: "两个请求同时启动它，只有一个应该真的跑起来。",
    assigneeId: "ag_coach",
    auditorId: "ag_auditor",
    status: "planned",
    acceptanceCriteria: "产物存在。",
    estimateMin: 10,
    actionType: "internal",
    resource: "task",
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("run claim", () => {
  it("lets exactly one of two concurrent runs claim the task", async () => {
    await makeTask();

    const settled = await Promise.allSettled([
      runTask(TASK_ID, DEMO_USER_ID),
      runTask(TASK_ID, DEMO_USER_ID),
    ]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const taskRuns = await db.select().from(runs).where(eq(runs.taskId, TASK_ID));
    expect(taskRuns).toHaveLength(1);
  });

  it("leaves no held reservation behind when a run loses the claim", async () => {
    await makeTask();

    await Promise.allSettled([
      runTask(TASK_ID, DEMO_USER_ID),
      runTask(TASK_ID, DEMO_USER_ID),
    ]);

    // The hold now commits with the claim, so the loser's transaction rolled
    // back before it could touch the ledger: one reservation, already settled.
    const holds = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.taskId, TASK_ID));
    expect(holds).toHaveLength(1);
    expect(holds.every((hold) => hold.state !== "reserved")).toBe(true);

    const [period] = await db
      .select()
      .from(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.agentId, "ag_coach"))
      .orderBy(desc(agentBudgetPeriods.periodStart))
      .limit(1);
    expect(period?.reservedCents ?? 0).toBe(0);
  });

  it("holds nothing when policy rejects the run before the claim", async () => {
    await makeTask();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, "ag_coach"));

    await expect(runTask(TASK_ID, DEMO_USER_ID)).rejects.toBeTruthy();

    const holds = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.taskId, TASK_ID));
    expect(holds).toHaveLength(0);
  });
});
