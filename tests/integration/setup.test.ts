import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentGrants, agents, dissents, goals, profiles, users } from "@/lib/db/schema";
import { setupWorkspace } from "@/lib/setup";
import { exportAccount, deleteAccount } from "@/lib/account";
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
});

describe("account export and deletion", () => {
  it("exports and then deletes only the target user's data", async () => {
    await setupWorkspace({ userId: NEW_USER, timezone: "Asia/Shanghai" });
    await db.insert(dissents).values({
      id: "dis_account_test",
      userId: NEW_USER,
      councilId: "ccl_account_test",
      agentId: "ag_account_test",
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

    const exported = await exportAccount(NEW_USER);
    expect(exported.dissents).toHaveLength(1);
    expect(exported.agents).toHaveLength(7);
    expect(exported.user?.id).toBe(NEW_USER);

    await deleteAccount(NEW_USER);

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
