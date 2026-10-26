CREATE TABLE "learning_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"artifact_id" text,
	"topic_id" text,
	"prompt" text NOT NULL,
	"answer" text NOT NULL,
	"rubric" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdicts" jsonb,
	"score" real,
	"judged_by" text DEFAULT 'rule' NOT NULL,
	"judge_model" text,
	"accepted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_attempts_judged_by_check" CHECK ("learning_attempts"."judged_by" IN ('rule', 'model', 'human')),
	CONSTRAINT "learning_attempts_score_range" CHECK ("learning_attempts"."score" IS NULL OR ("learning_attempts"."score" >= 0 AND "learning_attempts"."score" <= 1)),
	CONSTRAINT "learning_attempts_rubric_is_array" CHECK (jsonb_typeof("learning_attempts"."rubric") = 'array')
);
--> statement-breakpoint
CREATE TABLE "learning_mastery" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"mastery" real DEFAULT 0 NOT NULL,
	"ease_factor" real DEFAULT 2.5 NOT NULL,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_mastery_attempts_non_negative" CHECK ("learning_mastery"."attempts" >= 0),
	CONSTRAINT "learning_mastery_correct_within_attempts" CHECK ("learning_mastery"."correct" >= 0 AND "learning_mastery"."correct" <= "learning_mastery"."attempts"),
	CONSTRAINT "learning_mastery_mastery_range" CHECK ("learning_mastery"."mastery" >= 0 AND "learning_mastery"."mastery" <= 1),
	CONSTRAINT "learning_mastery_ease_floor" CHECK ("learning_mastery"."ease_factor" >= 1.3),
	CONSTRAINT "learning_mastery_interval_non_negative" CHECK ("learning_mastery"."interval_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "learning_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"goal_id" text,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_topics_key_not_blank" CHECK (btrim("learning_topics"."key") <> '')
);
--> statement-breakpoint
CREATE TABLE "policy_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"insight_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_overrides_status_check" CHECK ("policy_overrides"."status" IN ('active', 'rolled_back'))
);
--> statement-breakpoint
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_attempts" ADD CONSTRAINT "learning_attempts_topic_id_learning_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."learning_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_mastery" ADD CONSTRAINT "learning_mastery_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_mastery" ADD CONSTRAINT "learning_mastery_topic_id_learning_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."learning_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_overrides" ADD CONSTRAINT "policy_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_overrides" ADD CONSTRAINT "policy_overrides_insight_id_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."insights"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_attempts_user_task_idx" ON "learning_attempts" USING btree ("user_id","task_id");--> statement-breakpoint
CREATE INDEX "learning_attempts_user_created_idx" ON "learning_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "learning_attempts_topic_idx" ON "learning_attempts" USING btree ("topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_mastery_user_topic_idx" ON "learning_mastery" USING btree ("user_id","topic_id");--> statement-breakpoint
CREATE INDEX "learning_mastery_user_due_idx" ON "learning_mastery" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_topics_user_key_idx" ON "learning_topics" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "learning_topics_goal_idx" ON "learning_topics" USING btree ("goal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_overrides_user_key_active_idx" ON "policy_overrides" USING btree ("user_id","key") WHERE "policy_overrides"."status" = 'active';--> statement-breakpoint
CREATE INDEX "policy_overrides_user_status_idx" ON "policy_overrides" USING btree ("user_id","status");