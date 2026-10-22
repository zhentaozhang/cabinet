CREATE UNIQUE INDEX "audit_seq_idx" ON "audit_events" USING btree ("seq");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_autonomy_range" CHECK ("agents"."autonomy_level" BETWEEN 0 AND 3);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_budget_non_negative" CHECK ("agents"."budget_cents" >= 0);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_not_auditor" CHECK ("tasks"."assignee_id" IS NULL OR "tasks"."auditor_id" IS NULL OR "tasks"."assignee_id" <> "tasks"."auditor_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cost_non_negative" CHECK ("tasks"."estimated_cost_cents" >= 0);