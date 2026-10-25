import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import type { AcceptanceItem } from "@/lib/db/schema";
import {
  exportAcceptanceContract,
  renderAcceptanceContract,
  type AcceptanceContract,
} from "@/lib/domain/acceptance-export";

/**
 * The acceptance contract of one task, as the task's owner sees it.
 *
 * Ownership is part of the lookup (not a check afterwards), and a missing task
 * is `null` so the route answers 404 for "not yours" and "does not exist"
 * alike.
 */
export async function loadAcceptanceContract(
  taskId: string,
  userId: string,
): Promise<{ contract: AcceptanceContract; markdown: string } | null> {
  const [task] = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      acceptanceCriteria: tasks.acceptanceCriteria,
      acceptanceChecklist: tasks.acceptanceChecklist,
    })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
  if (!task) return null;

  const contract = exportAcceptanceContract({
    taskId: task.id,
    title: task.title,
    criteria: task.acceptanceCriteria,
    checklist: (task.acceptanceChecklist ?? null) as AcceptanceItem[] | null,
  });

  return { contract, markdown: renderAcceptanceContract(contract) };
}
