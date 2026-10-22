import { db } from "@/lib/db";
import { goals } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { logAuditTx } from "@/lib/audit";
import { ValidationError } from "@/lib/domain/errors";

export async function createGoal(
  input: {
    title: string;
    why: string;
    target: string;
    horizon: string;
    domain: string;
  },
  userId: string,
) {
  const title = input.title.trim();
  const why = input.why.trim();
  const target = input.target.trim();
  const horizon = input.horizon.trim();
  const domain = input.domain.trim();
  if (!title || !why || !target || !horizon || !domain) {
    throw new ValidationError("All goal fields are required.");
  }

  const id = newId("goal");
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(goals)
      .values({
        id,
        userId: userId,
        domain,
        title,
        why,
        target,
        horizon,
        status: "active",
        progress: 0,
      })
      .returning();

    await logAuditTx(tx, {
      userId: userId,
      actor: "user",
      action: "goal.create",
      target: id,
      before: null,
      after: { title, domain, horizon },
    });

    return created;
  });
}
