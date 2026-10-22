CREATE TABLE "agent_budget_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"timezone" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"limit_cents" real NOT NULL,
	"reserved_cents" real DEFAULT 0 NOT NULL,
	"settled_cents" real DEFAULT 0 NOT NULL,
	"unknown_cents" real DEFAULT 0 NOT NULL,
	"overrun" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_budget_periods_limit_check" CHECK ("agent_budget_periods"."limit_cents" >= 0),
	CONSTRAINT "agent_budget_periods_reserved_check" CHECK ("agent_budget_periods"."reserved_cents" >= 0),
	CONSTRAINT "agent_budget_periods_settled_check" CHECK ("agent_budget_periods"."settled_cents" >= 0),
	CONSTRAINT "agent_budget_periods_unknown_check" CHECK ("agent_budget_periods"."unknown_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_budget_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" text,
	"run_id" text,
	"state" text DEFAULT 'reserved' NOT NULL,
	"amount_cents" real NOT NULL,
	"settled_cents" real DEFAULT 0 NOT NULL,
	"provider_attempt_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "agent_budget_reservations_state_check" CHECK ("agent_budget_reservations"."state" IN ('reserved', 'settled', 'released', 'unknown_charged')),
	CONSTRAINT "agent_budget_reservations_amount_check" CHECK ("agent_budget_reservations"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_budget_periods" ADD CONSTRAINT "agent_budget_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_periods" ADD CONSTRAINT "agent_budget_periods_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_reservations" ADD CONSTRAINT "agent_budget_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_reservations" ADD CONSTRAINT "agent_budget_reservations_period_id_agent_budget_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."agent_budget_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_reservations" ADD CONSTRAINT "agent_budget_reservations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_reservations" ADD CONSTRAINT "agent_budget_reservations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_budget_reservations" ADD CONSTRAINT "agent_budget_reservations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_budget_periods_key" ON "agent_budget_periods" USING btree ("agent_id","period_start");--> statement-breakpoint
CREATE INDEX "agent_budget_reservations_period_idx" ON "agent_budget_reservations" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "agent_budget_reservations_run_idx" ON "agent_budget_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_budget_reservations_run_key" ON "agent_budget_reservations" USING btree ("run_id") WHERE "run_id" IS NOT NULL;
