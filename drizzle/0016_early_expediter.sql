ALTER TABLE "artifacts" ADD COLUMN "source_type" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_type" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source_type" text DEFAULT 'legacy_unknown' NOT NULL;
-- The demo account is an explicit fixture, never a legacy real workspace.
UPDATE "runs" SET "source_type" = 'demo_fixture'
WHERE "task_id" IN (SELECT "id" FROM "tasks" WHERE "user_id" = 'usr_zhen');
--> statement-breakpoint
UPDATE "artifacts" SET "source_type" = 'demo_fixture'
WHERE "task_id" IN (SELECT "id" FROM "tasks" WHERE "user_id" = 'usr_zhen');
--> statement-breakpoint
UPDATE "memories" SET "source_type" = 'demo_fixture'
WHERE "user_id" = 'usr_zhen';
