import "../src/lib/env";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";

/**
 * Removes checkins whose `user_id` is not in `users`.
 *
 * Migration 0027 adds the missing foreign key on `checkins.user_id` and already
 * deletes orphans so the ALTER can run. This script exists for the operator who
 * has to look before it happens: run it on a copy, read the count, and only then
 * migrate. It deletes exactly the rows the migration would delete, so it is
 * idempotent — a second run reports 0.
 */
export async function run(): Promise<{ deleted: number }> {
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM "checkins"
    WHERE NOT EXISTS (
      SELECT 1 FROM "users" WHERE "users"."id" = "checkins"."user_id"
    )
    RETURNING "id"
  `);
  return { deleted: deleted.length };
}

const invokedDirectly = /cleanup-orphans\.(ts|js|mjs|cjs)$/.test(
  process.argv[1] ?? "",
);

if (invokedDirectly) {
  run()
    .then(({ deleted }) => {
      console.log(
        deleted === 0
          ? "No orphan checkins found."
          : `Deleted ${deleted} orphan checkin(s).`,
      );
      // The connection pool keeps the event loop alive; the delete is committed.
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
