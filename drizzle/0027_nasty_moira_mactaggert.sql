-- Constraints below can be violated by rows an older build already accepted, so
-- the offending rows are removed first. Without this the ALTER/CREATE aborts the
-- whole migration run on any workspace that holds duplicates or orphans, which is
-- exactly the workspace that must migrate.
--> statement-breakpoint
-- checkins: the new FK to users rejects a checkin whose owner never existed.
DELETE FROM "checkins"
WHERE NOT EXISTS (
  SELECT 1 FROM "users" WHERE "users"."id" = "checkins"."user_id"
);
--> statement-breakpoint
-- steps: keep the newest row of every (run_id, idx) pair the sequence index rejects.
DELETE FROM "steps" a
USING "steps" b
WHERE a."run_id" = b."run_id"
  AND a."idx" = b."idx"
  AND (a."created_at", a."id") < (b."created_at", b."id");
--> statement-breakpoint
-- run_jobs: keep the newest live job per task; a finished job never conflicts.
DELETE FROM "run_jobs" a
USING "run_jobs" b
WHERE a."task_id" = b."task_id"
  AND a."status" IN ('queued', 'running')
  AND b."status" IN ('queued', 'running')
  AND (a."created_at", a."id") < (b."created_at", b."id");
--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_jobs_active_task_idx" ON "run_jobs" USING btree ("task_id") WHERE "run_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "runs_task_created_idx" ON "runs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_run_seq_idx" ON "steps" USING btree ("run_id","idx");
