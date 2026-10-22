import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  agentGrants,
  agents,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  dissents,
  goals,
  idempotencyKeys,
  insights,
  memories,
  profiles,
  rateLimits,
  reviews,
  runs,
  sessions,
  skills,
  steps,
  tasks,
  userActions,
  users,
} from "@/lib/db/schema";

export async function exportAccount(userId: string) {
  const [
    userRows,
    profileRows,
    agentRows,
    goalRows,
    taskRows,
    memoryRows,
    insightRows,
    reviewRows,
    approvalRows,
    councilRows,
    checkinRows,
    auditRows,
    dissentRows,
  ] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)),
    db.select().from(profiles).where(eq(profiles.userId, userId)),
    db.select().from(agents).where(eq(agents.userId, userId)),
    db.select().from(goals).where(eq(goals.userId, userId)),
    db.select().from(tasks).where(eq(tasks.userId, userId)),
    db.select().from(memories).where(eq(memories.userId, userId)),
    db.select().from(insights).where(eq(insights.userId, userId)),
    db.select().from(reviews).where(eq(reviews.userId, userId)),
    db.select().from(approvals).where(eq(approvals.userId, userId)),
    db.select().from(councils).where(eq(councils.userId, userId)),
    db.select().from(checkins).where(eq(checkins.userId, userId)),
    db.select().from(auditEvents).where(eq(auditEvents.userId, userId)),
    db.select().from(dissents).where(eq(dissents.userId, userId)),
  ]);

  const agentIds = agentRows.map((row) => row.id);
  const councilIds = councilRows.map((row) => row.id);
  const taskIds = taskRows.map((row) => row.id);

  const [runRows, skillRows, positionRows, artifactRows] =
    await Promise.all([
      agentIds.length
        ? db.select().from(runs).where(inArray(runs.agentId, agentIds))
        : Promise.resolve([]),
      agentIds.length
        ? db.select().from(skills).where(inArray(skills.agentId, agentIds))
        : Promise.resolve([]),
      councilIds.length
        ? db
            .select()
            .from(councilPositions)
            .where(inArray(councilPositions.councilId, councilIds))
        : Promise.resolve([]),
      taskIds.length
        ? db.select().from(artifacts).where(inArray(artifacts.taskId, taskIds))
        : Promise.resolve([]),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    user: userRows[0] ?? null,
    profile: profileRows[0] ?? null,
    agents: agentRows,
    goals: goalRows,
    tasks: taskRows,
    runs: runRows,
    memories: memoryRows,
    insights: insightRows,
    reviews: reviewRows,
    approvals: approvalRows,
    skills: skillRows,
    councils: councilRows,
    councilPositions: positionRows,
    checkins: checkinRows,
    artifacts: artifactRows,
    auditEvents: auditRows,
    dissents: dissentRows,
  };
}

export async function deleteAccount(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const agentIds = (
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.userId, userId))
    ).map((row) => row.id);
    const taskIds = (
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.userId, userId))
    ).map((row) => row.id);
    const runIds = taskIds.length
      ? (
          await tx
            .select({ id: runs.id })
            .from(runs)
            .where(inArray(runs.taskId, taskIds))
        ).map((row) => row.id)
      : [];
    const councilIds = (
      await tx
        .select({ id: councils.id })
        .from(councils)
        .where(eq(councils.userId, userId))
    ).map((row) => row.id);

    if (councilIds.length) {
      await tx
        .delete(councilPositions)
        .where(inArray(councilPositions.councilId, councilIds));
    }
    if (agentIds.length) {
      await tx.delete(skills).where(inArray(skills.agentId, agentIds));
      await tx
        .delete(agentGrants)
        .where(inArray(agentGrants.agentId, agentIds));
    }
    if (taskIds.length) {
      await tx.delete(artifacts).where(inArray(artifacts.taskId, taskIds));
    }
    if (runIds.length) {
      await tx.delete(steps).where(inArray(steps.runId, runIds));
    }
    if (taskIds.length) {
      await tx.delete(runs).where(inArray(runs.taskId, taskIds));
    }

    await tx.delete(approvals).where(eq(approvals.userId, userId));
    await tx.delete(auditEvents).where(eq(auditEvents.userId, userId));
    await tx.delete(dissents).where(eq(dissents.userId, userId));
    await tx.delete(reviews).where(eq(reviews.userId, userId));
    await tx.delete(insights).where(eq(insights.userId, userId));
    await tx.delete(memories).where(eq(memories.userId, userId));
    await tx.delete(checkins).where(eq(checkins.userId, userId));
    await tx.delete(councils).where(eq(councils.userId, userId));
    await tx.delete(tasks).where(eq(tasks.userId, userId));
    await tx.delete(goals).where(eq(goals.userId, userId));
    await tx.delete(agents).where(eq(agents.userId, userId));
    await tx.delete(profiles).where(eq(profiles.userId, userId));
    await tx.delete(userActions).where(eq(userActions.userId, userId));
    await tx
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, userId));
    await tx.delete(rateLimits).where(eq(rateLimits.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(accounts).where(eq(accounts.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}
