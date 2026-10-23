CREATE TABLE "run_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" text,
	"lease_until" timestamp with time zone,
	"run_id" text,
	"last_error" text,
	"requested_by" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_jobs" ADD CONSTRAINT "run_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_jobs" ADD CONSTRAINT "run_jobs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_jobs_claim_idx" ON "run_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "run_jobs_user_created_idx" ON "run_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "run_jobs_task_idx" ON "run_jobs" USING btree ("task_id");