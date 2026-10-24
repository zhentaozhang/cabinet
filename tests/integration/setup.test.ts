import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentBudgetPeriods,
  agentBudgetReservations,
  agentGrants,
  agents,
  councils,
  dissents,
  goals,
  evidence,
  profiles,
  retrievalCalls,
  runs,
  steps,
  tasks,
  users,
} from "@/lib/db/schema";
import { setupWorkspace } from "@/lib/setup";
import { exportAccount, deleteAccount } from "@/lib/account";
import { exportAccountNdjson } from "@/lib/account-export";
import { ConflictError } from "@/lib/domain/errors";
import { resetDb } from "../helpers/db";

const NEW_USER = "usr_setup_test";

beforeEach(async () => {
  await resetDb();
  await db.insert(users).values({
    id: NEW_USER,
    email: "setup-test@cabinet.local",
    name: "Setup Test",
    emailVerified: true,
    timezone: "Asia/Shanghai",
    updatedAt: new Date(),
  });
});

describe("workspace setup", () => {
  it("creates a profile, 7 agents, grants and a goal", async () => {
    const result = await setupWorkspace({
      userId: NEW_USER,
      timezone: "Asia/Shanghai",
      name: "Setup Test",
      goal: {
        title: "准备系统设计面试",
        why: "换工作",
        target: "完成 20 道题",
        horizon: "8 weeks",
        domain: "learning",
      },
    });

    expect(result.agentCount).toBe(7);
    expect(result.goalId).toBeTruthy();

    const createdAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, NEW_USER));
    expect(createdAgents).toHaveLength(7);

    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, NEW_USER));
    expect(profile).toBeTruthy();

    const createdGoals = await db
      .select()
      .from(goals)
      .where(eq(goals.userId, NEW_USER));
    expect(createdGoals).toHaveLength(1);

    const grants = await db
      .select()
      .from(agentGrants)
      .where(eq(agentGrants.agentId, createdAgents[0].id));
    expect(grants.length).toBeGreaterThan(0);
  });

  it("refuses to set up the same workspace twice", async () => {
    await setupWorkspace({ userId: NEW_USER, timezone: "Asia/Shanghai" });
    await expect(
      setupWorkspace({ userId: NEW_USER, timezone: "Asia/Shanghai" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("serialises two concurrent setup calls into one workspace", async () => {
    const results = await Promise.allSettled([
      setupWorkspace({ userId: NEW_USER, timezone: "Asia/Shanghai" }),
      setupWorkspace({ userId: NEW_USER, timezone: "Asia/Shanghai" }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictError,
    );

    const createdAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, NEW_USER));
    expect(createdAgents).toHaveLength(7);
  });
});

describe("account export and deletion", () => {
  it("exports and then deletes only the target user's data", async () => {
    await setupWorkspace({ userId: NEW_USER, timezone: "Asia/Shanghai" });
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, NEW_USER))
      .limit(2);
    const auditor = (
      await db
        .select()
        .from(agents)
        .where(eq(agents.userId, NEW_USER))
    ).find((row) => row.id !== agent.id)!;
    await db.insert(councils).values({
      id: "ccl_account_test",
      userId: NEW_USER,
      topic: "account test",
      trigger: "test",
      status: "open",
      memo: "test",
    });
    await db.insert(dissents).values({
      id: "dis_account_test",
      userId: NEW_USER,
      councilId: "ccl_account_test",
      agentId: agent.id,
      warning: "account export/delete must include dissents",
      condition: {
        metric: "audit_reject_count",
        operator: ">=",
        threshold: 1,
        windowDays: 7,
      },
      status: "pending",
      evidence: [],
    });

    /**
     * A single run leaves a budget reservation behind (settlement only flips
     * its state), and that row references the agent. Deleting the account used
     * to fail with a foreign key violation here.
     */
    await db.insert(tasks).values({
      id: "tsk_account_test",
      userId: NEW_USER,
      title: "account test task",
      description: "x",
      acceptanceCriteria: "x",
      status: "done",
      assigneeId: agent.id,
      auditorId: auditor.id,
      actionType: "internal",
      resource: "task",
      priority: 2,
    });
    await db.insert(agentBudgetPeriods).values({
      id: "abp_account_test",
      userId: NEW_USER,
      agentId: agent.id,
      timezone: "Asia/Shanghai",
      periodStart: new Date("2026-10-19T00:00:00Z"),
      periodEnd: new Date("2026-10-26T00:00:00Z"),
      limitCents: 5000,
      reservedCents: 120,
      settledCents: 0,
      unknownCents: 0,
    });
    await db.insert(agentBudgetReservations).values({
      id: "abr_account_test",
      userId: NEW_USER,
      periodId: "abp_account_test",
      agentId: agent.id,
      taskId: "tsk_account_test",
      state: "settled",
      amountCents: 120,
      settledCents: 120,
    });

    // A run keeps its trace in `steps`; an export without them cannot explain
    // what happened, so the run is deliberately given one.
    await db.insert(runs).values({
      id: "run_account_test",
      taskId: "tsk_account_test",
      agentId: agent.id,
      status: "submitted",
      runLabel: "replay-account-test",
      mode: "demo",
    });
    await db.insert(steps).values([
      {
        id: "stp_account_1",
        runId: "run_account_test",
        idx: 1,
        type: "plan",
        input: {},
        output: {},
      },
      {
        id: "stp_account_2",
        runId: "run_account_test",
        idx: 2,
        type: "tool",
        input: {},
        output: {},
      },
    ]);

    // Both children of the run: they must be exported, and they must not block
    // the delete (their foreign keys do not cascade).
    await db.insert(evidence).values({
      id: "evd_account_test",
      userId: NEW_USER,
      taskId: "tsk_account_test",
      runId: "run_account_test",
      kind: "page_extract",
      url: "https://example.com/x",
      title: "x",
      quote: "x",
      provider: "fetch",
      contentHash: "0".repeat(64),
      retrievedAt: new Date(),
    });
    await db.insert(retrievalCalls).values({
      id: "rtc_account_test",
      userId: NEW_USER,
      taskId: "tsk_account_test",
      runId: "run_account_test",
      tool: "web_search",
      provider: "brave",
      status: "ok",
      hits: 1,
      unitPriceCents: 40,
      chargedCents: 40,
    });

    const lines: Array<Record<string, unknown>> = [];
    for await (const line of exportAccountNdjson(NEW_USER)) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    expect(lines[0].kind).toBe("meta");
    expect(lines.at(-1)?.kind).toBe("end");
    const dumped = new Map(
      lines
        .filter((line) => line.kind === "rows")
        .map((line) => [String(line.table), line.rows as unknown[]]),
    );
    expect(dumped.get("tasks")).toHaveLength(1);
    expect(dumped.get("steps")).toHaveLength(2);

    const exported = await exportAccount(NEW_USER);
    expect(exported.evidence).toHaveLength(1);
    expect(exported.retrievalCalls).toHaveLength(1);
    expect(exported.steps).toHaveLength(2);
    expect(exported.steps.every((step) => step.runId === "run_account_test")).toBe(true);
    expect(exported.agentBudgetReservations).toHaveLength(1);
    expect(exported.agentBudgetPeriods).toHaveLength(1);
    expect(exported.dissents).toHaveLength(1);
    expect(exported.agents).toHaveLength(7);
    expect(exported.user?.id).toBe(NEW_USER);

    await deleteAccount(NEW_USER);

    const strayEvidence = await db
      .select()
      .from(evidence)
      .where(eq(evidence.userId, NEW_USER));
    expect(strayEvidence).toHaveLength(0);
    const strayCalls = await db
      .select()
      .from(retrievalCalls)
      .where(eq(retrievalCalls.userId, NEW_USER));
    expect(strayCalls).toHaveLength(0);

    const remainingUsers = await db
      .select()
      .from(users)
      .where(eq(users.id, NEW_USER));
    expect(remainingUsers).toHaveLength(0);

    const remainingAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, NEW_USER));
    expect(remainingAgents).toHaveLength(0);

    const remainingReservations = await db
      .select()
      .from(agentBudgetReservations)
      .where(eq(agentBudgetReservations.userId, NEW_USER));
    expect(remainingReservations).toHaveLength(0);
    const remainingPeriods = await db
      .select()
      .from(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.userId, NEW_USER));
    expect(remainingPeriods).toHaveLength(0);

    const remainingDissents = await db
      .select()
      .from(dissents)
      .where(eq(dissents.userId, NEW_USER));
    expect(remainingDissents).toHaveLength(0);

    const demoUser = await db
      .select()
      .from(users)
      .where(eq(users.id, "usr_zhen"));
    expect(demoUser).toHaveLength(1);
    const demoAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, "usr_zhen"));
    expect(demoAgents).toHaveLength(7);
  });
});
