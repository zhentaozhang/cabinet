CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"kind" text DEFAULT 'web_page' NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text,
	"quote" text NOT NULL,
	"provider" text NOT NULL,
	"content_hash" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_task_idx" ON "evidence" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_run_idx" ON "evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evidence_user_idx" ON "evidence" USING btree ("user_id");