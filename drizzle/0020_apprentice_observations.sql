CREATE TABLE "apprentice_exam_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"apprentice_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"run_id" text,
	"observation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apprentice_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"apprentice_id" text NOT NULL,
	"mentor_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version" integer NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"artifact_id" text,
	"attested_by_user_id" text NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"qualification" text DEFAULT 'qualified' NOT NULL,
	"reason" text,
	CONSTRAINT "apprentice_observations_qualification_check" CHECK ("apprentice_observations"."qualification" IN ('qualified', 'disqualified'))
);
--> statement-breakpoint
ALTER TABLE "apprentice_exam_snapshots" ADD CONSTRAINT "apprentice_exam_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_exam_snapshots" ADD CONSTRAINT "apprentice_exam_snapshots_apprentice_id_agents_id_fk" FOREIGN KEY ("apprentice_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_exam_snapshots" ADD CONSTRAINT "apprentice_exam_snapshots_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_exam_snapshots" ADD CONSTRAINT "apprentice_exam_snapshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_apprentice_id_agents_id_fk" FOREIGN KEY ("apprentice_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_mentor_id_agents_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apprentice_observations" ADD CONSTRAINT "apprentice_observations_attested_by_user_id_users_id_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apprentice_exam_snapshots_key" ON "apprentice_exam_snapshots" USING btree ("apprentice_id","skill_id","skill_version","attempt_no");--> statement-breakpoint
CREATE INDEX "apprentice_exam_snapshots_run_idx" ON "apprentice_exam_snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apprentice_observations_key" ON "apprentice_observations" USING btree ("apprentice_id","skill_id","skill_version","run_id");--> statement-breakpoint
CREATE INDEX "apprentice_observations_user_idx" ON "apprentice_observations" USING btree ("user_id");