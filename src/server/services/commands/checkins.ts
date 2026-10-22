import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, memories, tasks } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logAudit } from "@/lib/audit";
import { localDateKey } from "@/lib/domain/time";
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
  const checkinId = newId("chk");
  await db.insert(checkins).values({
    id: checkinId,
    userId: userId,
    date: today,
    energy: input.energy,
    mood: input.mood,
    completed: input.completed,
    note: input.note,
  });

  for (const item of input.completed) {
    if (item.done) {
      const [task] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, item.taskId));
      if (task && !["accepted", "done"].includes(task.status)) {
        await db
          .update(tasks)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(tasks.id, item.taskId));
      }
    }
  }

  if (input.note.trim()) {
    await db.insert(memories).values({
      id: newId("mem"),
      userId: userId,
      agentId: "ag_coach",
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

  await logAudit({
    userId: userId,
    actor: "user",
    action: "checkin.save",
    target: today,
    before: null,
    after: { energy: input.energy, mood: input.mood },
  });
}
