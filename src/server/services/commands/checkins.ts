import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agents, checkins, memories, tasks } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logAuditTx } from "@/lib/audit";
import { assertTransition } from "@/lib/domain/state";
import { localDateKey } from "@/lib/domain/time";
import { ValidationError } from "@/lib/domain/errors";
import { getWorkspace } from "../queries/workspace";

export async function saveCheckin(
  input: {
    energy: number;
    mood: number;
    completed: Array<{ taskId: string; done: boolean }>;
    note: string;
  },
  userId: string,
) {
  const { user } = await getWorkspace(userId);
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

  const checkinId = newId("chk");
  await db.transaction(async (tx) => {
    await tx.insert(checkins).values({
      id: checkinId,
      userId,
      date: today,
      energy: input.energy,
      mood: input.mood,
      completed: input.completed,
      note: input.note,
    });

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

    if (input.note.trim()) {
      await tx.insert(memories).values({
        id: newId("mem"),
        userId,
        agentId: coach?.id ?? null,
        type: "episodic",
        domain: "checkin",
        content: input.note.trim(),
        confidence: 0.9,
        salience: 0.55,
        evidence: [
          { label: "今日 check-in", ref: `checkin:${checkinId}` },
        ],
        sourceEventId: checkinId,
        lastConfirmedAt: new Date(),
      });
    }

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
      },
    });
  });
}
