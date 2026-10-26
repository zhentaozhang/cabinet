import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  agentBudgetPeriods,
  agentBudgetReservations,
  agentGrants,
  agents,
  apprenticeExamSnapshots,
  apprenticeObservations,
  approvals,
  artifacts,
  auditEvents,
  checkins,
  councilPositions,
  councils,
  dissents,
  evidence,
  goals,
  idempotencyKeys,
  insights,
  learningAttempts,
  learningMastery,
  learningTopics,
  memories,
  outbox,
  policyOverrides,
  profiles,
  rateLimits,
  retrievalCalls,
  runJobs,
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
    evidenceRows,
    outboxRows,
    retrievalRows,
    runJobRows,
    topicRows,
    masteryRows,
    attemptRows,
    overrideRows,
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
    db.select().from(evidence).where(eq(evidence.userId, userId)),
    db.select().from(outbox).where(eq(outbox.userId, userId)),
    db.select().from(retrievalCalls).where(eq(retrievalCalls.userId, userId)),
    db.select().from(runJobs).where(eq(runJobs.userId, userId)),
    // 学习历史与策略覆盖同样是用户的个人数据：迁移到一个新工具时，
    // "我复习过哪些知识点、答错过什么" 不能说丢就丢。
    db.select().from(learningTopics).where(eq(learningTopics.userId, userId)),
    db.select().from(learningMastery).where(eq(learningMastery.userId, userId)),
    db.select().from(learningAttempts).where(eq(learningAttempts.userId, userId)),
    db.select().from(policyOverrides).where(eq(policyOverrides.userId, userId)),
  ]);

  const agentIds = agentRows.map((row) => row.id);
  const councilIds = councilRows.map((row) => row.id);
  const taskIds = taskRows.map((row) => row.id);

  const [
    runRows,
    skillRows,
    positionRows,
    artifactRows,
    grantRows,
    budgetRows,
    reservationRows,
    observationRows,
    examSnapshotRows,
  ] = await Promise.all([
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
      agentIds.length
        ? db.select().from(agentGrants).where(inArray(agentGrants.agentId, agentIds))
        : Promise.resolve([]),
      db.select().from(agentBudgetPeriods).where(eq(agentBudgetPeriods.userId, userId)),
      db
        .select()
        .from(agentBudgetReservations)
        .where(eq(agentBudgetReservations.userId, userId)),
      db
        .select()
        .from(apprenticeObservations)
        .where(eq(apprenticeObservations.userId, userId)),
      db
        .select()
        .from(apprenticeExamSnapshots)
        .where(eq(apprenticeExamSnapshots.userId, userId)),
    ]);

  // Steps hang off runs, not users, so they can only be fetched once the run
  // ids are known. Without them an export cannot rebuild what a run did.
  const runIds = (runRows as Array<{ id: string }>).map((row) => row.id);
  const stepRows = runIds.length
    ? await db.select().from(steps).where(inArray(steps.runId, runIds))
    : [];

  return {
    exportedAt: new Date().toISOString(),
    user: userRows[0] ?? null,
    profile: profileRows[0] ?? null,
    agents: agentRows,
    goals: goalRows,
    tasks: taskRows,
    runs: runRows,
    steps: stepRows,
    memories: memoryRows,
    insights: insightRows,
    reviews: reviewRows,
    approvals: approvalRows,
    skills: skillRows,
    councils: councilRows,
    councilPositions: positionRows,
    agentGrants: grantRows,
    agentBudgetPeriods: budgetRows,
    agentBudgetReservations: reservationRows,
    apprenticeObservations: observationRows,
    apprenticeExamSnapshots: examSnapshotRows,
    checkins: checkinRows,
    artifacts: artifactRows,
    auditEvents: auditRows,
    dissents: dissentRows,
    evidence: evidenceRows,
    outbox: outboxRows,
    retrievalCalls: retrievalRows,
    runJobs: runJobRows,
    learningTopics: topicRows,
    learningMastery: masteryRows,
    learningAttempts: attemptRows,
    policyOverrides: overrideRows,
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

    /**
     * The budget ledger and the apprenticeship history point at agents, tasks
     * and runs without ON DELETE CASCADE, so they must be deleted first: a
     * user who has run a single task owns a reservation row, and deleting the
     * agent underneath it fails the whole transaction.
     */
    await tx
      .delete(agentBudgetReservations)
      .where(eq(agentBudgetReservations.userId, userId));
    await tx
      .delete(agentBudgetPeriods)
      .where(eq(agentBudgetPeriods.userId, userId));
    await tx
      .delete(apprenticeObservations)
      .where(eq(apprenticeObservations.userId, userId));
    await tx
      .delete(apprenticeExamSnapshots)
      .where(eq(apprenticeExamSnapshots.userId, userId));
    /**
     * 学习与策略数据同理（约定见上）：learning_attempts 指向 artifacts 和
     * tasks，learning_mastery 指向 learning_topics，learning_topics 指向
     * goals，policy_overrides 指向 insights，四张表全部 ON DELETE no action。
     * 少删任何一张，删号都会在第一个被引用的父表上撞外键、整条事务回滚，
     * /api/account 的 DELETE 直接 500。
     */
    await tx.delete(policyOverrides).where(eq(policyOverrides.userId, userId));
    await tx.delete(learningAttempts).where(eq(learningAttempts.userId, userId));
    await tx.delete(learningMastery).where(eq(learningMastery.userId, userId));
    await tx.delete(learningTopics).where(eq(learningTopics.userId, userId));

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
    // Jobs reference tasks and runs by id with no cascade.
    await tx.delete(runJobs).where(eq(runJobs.userId, userId));
    // Children of runs go first: evidence and retrieval_calls both point at
    // run_id and task_id with no cascade, so deleting runs before them fails
    // on a foreign key rather than silently leaving orphans.
    await tx.delete(evidence).where(eq(evidence.userId, userId));
    await tx.delete(retrievalCalls).where(eq(retrievalCalls.userId, userId));
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
    await tx.delete(outbox).where(eq(outbox.userId, userId));
    await tx
      .delete(idempotencyKeys)
      .where(eq(idempotencyKeys.userId, userId));
    await tx.delete(rateLimits).where(eq(rateLimits.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(accounts).where(eq(accounts.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}
