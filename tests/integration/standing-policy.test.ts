import { DEMO_USER_ID } from "@/lib/demo";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentGrants, auditEvents, tasks } from "@/lib/db/schema";
import { decideApproval, runTask } from "@/server/services/engine";
import { PolicyDenied, ValidationError } from "@/lib/domain/errors";
import { revokeGrant } from "@/server/services/commands/tasks/grants";
import { resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

/**
 * Rewind the task to `planned`, which is exactly what a rejection does, so a
 * test can exercise "the agent asks to run this again" without depending on
 * whether the Auditor happened to accept the draft.
 */
async function requeue() {
  await db
    .update(tasks)
    .set({ status: "planned" })
    .where(eq(tasks.id, "tsk_booking"));
}

/**
 * The live policy created by an approval. The seed also ships base permission
 * grants (e.g. `grt_coach` for calendar), so ownership of the approval is what
 * distinguishes a standing policy from a baseline permission.
 */
async function liveStandingGrant() {
  const [row] = await db
    .select()
    .from(agentGrants)
    .where(
      and(
        eq(agentGrants.agentId, "ag_coach"),
        eq(agentGrants.resource, "calendar"),
        isNotNull(agentGrants.createdByApprovalId),
        isNull(agentGrants.revokedAt),
      ),
    );
  return row;
}

describe("approvals become bounded standing policies", () => {
  it("turns one approval into a policy that runs without asking again", async () => {
    await decideApproval("appr_booking", "approve", "同意", DEMO_USER_ID, {
      remember: { days: 30, maxRuns: 3 },
    });

    const grant = await liveStandingGrant();
    expect(grant).toBeDefined();
    expect(grant.action).toBe("external_action");
    expect(grant.createdByApprovalId).toBe("appr_booking");
    expect(grant.maxRuns).toBe(3);
    expect(grant.useCount).toBe(0);
    expect(grant.expiresAt).toBeInstanceOf(Date);

    // The first run spends the approval itself…
    const first = await runTask("tsk_booking", DEMO_USER_ID);
    expect("runId" in first).toBe(true);
    expect((await liveStandingGrant()).useCount).toBe(0);

    // …every later run is covered by the policy instead.
    await requeue();
    const second = await runTask("tsk_booking", DEMO_USER_ID);
    expect("runId" in second).toBe(true);
    expect((await liveStandingGrant()).useCount).toBe(1);

    const [use] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, DEMO_USER_ID),
          eq(auditEvents.action, "grant.use"),
        ),
      );
    expect(use.target).toBe(grant.id);
  });

  it("stops pre-approving once the use budget is spent", async () => {
    await decideApproval("appr_booking", "approve", "同意", DEMO_USER_ID, {
      remember: { days: 30, maxRuns: 1 },
    });

    await runTask("tsk_booking", DEMO_USER_ID); // spends the approval
    await requeue();
    await runTask("tsk_booking", DEMO_USER_ID); // spends the only policy use
    expect((await liveStandingGrant()).useCount).toBe(1);

    await requeue();
    await expect(runTask("tsk_booking", DEMO_USER_ID)).rejects.toBeInstanceOf(
      PolicyDenied,
    );
  });

  it("stops trusting a policy the user revoked", async () => {
    await decideApproval("appr_booking", "approve", "同意", DEMO_USER_ID, {
      remember: { days: 30, maxRuns: 5 },
    });
    const grant = await liveStandingGrant();

    await revokeGrant(grant.id, DEMO_USER_ID, "不想再自动预约");
    expect(await liveStandingGrant()).toBeUndefined();

    await runTask("tsk_booking", DEMO_USER_ID); // spends the approval itself
    await requeue();
    await expect(runTask("tsk_booking", DEMO_USER_ID)).rejects.toBeInstanceOf(
      PolicyDenied,
    );
  });

  it("never mints a policy from a rejection", async () => {
    await decideApproval("appr_booking", "reject", "不同意", DEMO_USER_ID, {
      remember: { days: 30 },
    });
    expect(await liveStandingGrant()).toBeUndefined();
  });

  it("treats a revoked base grant as no permission at all", async () => {
    // The seeded `grt_coach` is a baseline permission, not a standing policy.
    const [base] = await db
      .select()
      .from(agentGrants)
      .where(
        and(
          eq(agentGrants.agentId, "ag_coach"),
          eq(agentGrants.resource, "calendar"),
          isNull(agentGrants.createdByApprovalId),
        ),
      );
    await revokeGrant(base.id, DEMO_USER_ID, "收回日历写入权限");

    await decideApproval("appr_booking", "approve", "同意", DEMO_USER_ID);
    await expect(runTask("tsk_booking", DEMO_USER_ID)).rejects.toBeInstanceOf(
      PolicyDenied,
    );
  });

  it("keeps a non-spend policy uncapped, with a default use budget", async () => {
    await decideApproval("appr_booking", "approve", "同意", DEMO_USER_ID, {
      remember: { days: 30 },
    });
    const grant = await liveStandingGrant();
    expect(grant.maxCents).toBeNull();
    expect(grant.maxRuns).toBe(20);
  });

  it("rejects remembering for longer than the allowed window", async () => {
    await expect(
      decideApproval("appr_booking", "approve", "同意", DEMO_USER_ID, {
        remember: { days: 365 },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps an approval that is not remembered single-use", async () => {
    await decideApproval("appr_booking", "approve", "同意", DEMO_USER_ID);
    expect(await liveStandingGrant()).toBeUndefined();

    await runTask("tsk_booking", DEMO_USER_ID);
    await requeue();
    await expect(runTask("tsk_booking", DEMO_USER_ID)).rejects.toBeInstanceOf(
      PolicyDenied,
    );
  });
});
