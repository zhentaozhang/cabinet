import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, checkins, memories, tasks } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logAuditTx } from "@/lib/audit";
import { assertTransition } from "@/lib/domain/state";
import { localDateKey } from "@/lib/domain/time";
import { checkinMemoryContent } from "@/lib/domain/checkin-memory";
import { ValidationError } from "@/lib/domain/errors";
import { getWorkspace } from "../queries/workspace";
import { getPolicyConfigFor } from "@/lib/policy/config";
import { ensureNextLearningTask } from "./learning";
import { recalculateUserGoalProgress } from "./progress";

export async function saveCheckin(
  input: {
    energy: number;
    mood: number;
    completed: Array<{ taskId: string; done: boolean }>;
    note: string;
    studyMinutes?: number;
    recallScore?: number | null;
    errorTags?: string[];
  },
  userId: string,
) {
  const { user } = await getWorkspace(userId);
  // 用户级配置：打卡会重算目标进度，而进度权重/周打卡目标可能被洞察覆盖过。
  const config = await getPolicyConfigFor(userId);
  const today = localDateKey(new Date(), user.timezone);

  const taskIds = [...new Set(input.completed.map((item) => item.taskId))];
  const ownedTasks = taskIds.length
    ? await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.userId, userId), inArray(tasks.id, taskIds)))
    : [];
  if (ownedTasks.length !== taskIds.length) {
    throw new ValidationError("One or more check-in tasks were not found.");
  }

  const [coach] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), eq(agents.role, "coach")))
    .limit(1);

  const studyMinutes = Math.max(0, Math.round(input.studyMinutes ?? 0));
  const recallScore = input.recallScore ?? null;
  const errorTags = [...new Set(input.errorTags ?? [])];

  await db.transaction(async (tx) => {
    // One check-in per user per local day: re-submitting updates it instead of
    // creating a duplicate row (the unique index enforces this at the DB).
    const [saved] = await tx
      .insert(checkins)
      .values({
        id: newId("chk"),
        userId,
        date: today,
        energy: input.energy,
        mood: input.mood,
        completed: input.completed,
        note: input.note,
        studyMinutes,
        recallScore,
        errorTags,
      })
      .onConflictDoUpdate({
        target: [checkins.userId, checkins.date],
        set: {
          energy: input.energy,
          mood: input.mood,
          completed: input.completed,
          note: input.note,
          studyMinutes,
          recallScore,
          errorTags,
        },
      })
      .returning({ id: checkins.id });
    const checkinId = saved.id;

    for (const item of input.completed) {
      if (!item.done) continue;
      const task = ownedTasks.find((candidate) => candidate.id === item.taskId);
      // A check-in is a self-report, not an Auditor decision. Only the final
      // accepted -> done transition is allowed here; everything else keeps its
      // current state and still has to go through the normal audit path.
      if (!task || task.status !== "accepted") continue;
      assertTransition("task", task.status, "done");
      await tx
        .update(tasks)
        .set({ status: "done", updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.userId, userId),
            eq(tasks.status, "accepted"),
          ),
        );
    }

    // Replacing the note must not accumulate one memory per re-submit.
    await tx
      .delete(memories)
      .where(
        and(eq(memories.userId, userId), eq(memories.sourceEventId, checkinId)),
      );

    // 正文与首页徽章共用同一个函数：为空就不写记忆行（见 checkin-memory.ts）。
    const memoryContent = checkinMemoryContent({
      studyMinutes,
      recallScore,
      errorTags,
      note: input.note,
    });

    if (memoryContent) {
      await tx.insert(memories).values({
        id: newId("mem"),
        userId,
        agentId: coach?.id ?? null,
        type: "episodic",
        domain: "checkin",
        content: memoryContent,
        sourceType: "user_input",
        confidence: 0.9,
        salience: 0.55,
        evidence: [
          { label: "今日 check-in", ref: `checkin:${checkinId}` },
        ],
        sourceEventId: checkinId,
        lastConfirmedAt: new Date(),
      });
    }

    await recalculateUserGoalProgress(tx, userId, config.learning);

    await logAuditTx(tx, {
      userId,
      actor: "user",
      action: "checkin.save",
      target: today,
      before: null,
      after: {
        energy: input.energy,
        mood: input.mood,
        completed: input.completed.filter((item) => item.done).length,
        studyMinutes,
        recallScore,
        errorTags,
      },
    });
  });

  // The loop closes here. A check-in is the only signal that says which weak
  // point the next study task should be about, so the task is scheduled by the
  // check-in itself instead of waiting for someone to press a button.
  //
  // Deliberately outside the transaction: it reads through `db`, not `tx`, and
  // it refuses to run for a workspace with no coach/auditor or no learning goal.
  // A check-in is worth keeping either way, so only that refusal is swallowed.
  try {
    await ensureNextLearningTask(userId);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
}
