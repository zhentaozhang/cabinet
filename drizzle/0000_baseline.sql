CREATE TABLE "agent_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"config" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_templates" (
	"role" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"charter" text NOT NULL,
	"objective" text NOT NULL,
	"tools" jsonb NOT NULL,
	"memory_scope" jsonb NOT NULL,
	"default_autonomy" integer DEFAULT 1 NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"avatar" text NOT NULL,
	"charter" text NOT NULL,
	"objective" text NOT NULL,
	"model" text DEFAULT 'auto' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"autonomy_level" integer DEFAULT 1 NOT NULL,
	"trust_score" real DEFAULT 50 NOT NULL,
	"lifecycle_stage" text DEFAULT 'active' NOT NULL,
	"mentor_id" text,
	"tools" jsonb NOT NULL,
	"memory_scope" jsonb NOT NULL,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"spent_cents" real DEFAULT 0 NOT NULL,
	"budget_period_start" timestamp with time zone,
	"policy_json" jsonb,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"reject_streak" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"user_id" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"hash" text NOT NULL,
	"prev_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"energy" integer NOT NULL,
	"mood" integer NOT NULL,
	"completed" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "council_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"council_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"stance" text NOT NULL,
	"claim" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"risk" text NOT NULL,
	"recommendation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "councils" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"memo" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"title" text NOT NULL,
	"why" text NOT NULL,
	"target" text NOT NULL,
	"horizon" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_json" jsonb,
	"status_code" integer DEFAULT 200 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"claim" text NOT NULL,
	"rationale" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence" jsonb NOT NULL,
	"proposed_change" jsonb NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"type" text NOT NULL,
	"domain" text NOT NULL,
	"content" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"salience" real DEFAULT 0.5 NOT NULL,
	"evidence" jsonb NOT NULL,
	"source_event_id" text,
	"last_confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"constraints" jsonb NOT NULL,
	"preferences" jsonb NOT NULL,
	"energy_pattern" jsonb NOT NULL,
	"management_budget_min" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"type" text NOT NULL,
	"narrative" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"decisions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'demo' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"cost_cents" real DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"error" text,
	"replay_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"steps" jsonb NOT NULL,
	"tools" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"eval" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"idx" integer NOT NULL,
	"type" text NOT NULL,
	"tool" text,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"goal_id" text,
	"parent_id" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"assignee_id" text,
	"auditor_id" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"due_at" timestamp with time zone,
	"acceptance_criteria" text NOT NULL,
	"estimate_min" integer DEFAULT 25 NOT NULL,
	"action_type" text DEFAULT 'internal' NOT NULL,
	"resource" text DEFAULT 'task' NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approval_threshold_cents" integer,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"quality_gate" text,
	"template" text,
	"accepted_at" timestamp with time zone,
	"accepted_autonomy_level" integer,
	"created_by" text DEFAULT 'agent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agents_user_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_user_key_idx" ON "idempotency_keys" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "steps_run_idx" ON "steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id");