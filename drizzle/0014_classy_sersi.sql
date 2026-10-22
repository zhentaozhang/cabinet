ALTER TABLE "artifacts" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "submitted_by" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "study_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "recall_score" real;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "error_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "artifacts_task_source_idx" ON "artifacts" USING btree ("task_id","submitted_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_user_type_period_unique" ON "reviews" USING btree ("user_id","type","period");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_submitted_by_check" CHECK ("artifacts"."submitted_by" IN ('agent', 'user'));--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_study_minutes_non_negative" CHECK ("checkins"."study_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_recall_score_range" CHECK ("checkins"."recall_score" IS NULL OR ("checkins"."recall_score" >= 0 AND "checkins"."recall_score" <= 1));--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_error_tags_array" CHECK (jsonb_typeof("checkins"."error_tags") = 'array');