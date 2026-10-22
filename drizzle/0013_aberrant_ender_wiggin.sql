CREATE INDEX "agent_grants_agent_idx" ON "agent_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agents_user_status_idx" ON "agents" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "approvals_user_status_idx" ON "approvals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "approvals_task_idx" ON "approvals" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "artifacts_task_idx" ON "artifacts" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "audit_user_created_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_user_target_idx" ON "audit_events" USING btree ("user_id","target");--> statement-breakpoint
CREATE UNIQUE INDEX "checkins_user_date_idx" ON "checkins" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "council_positions_council_idx" ON "council_positions" USING btree ("council_id");--> statement-breakpoint
CREATE INDEX "councils_user_status_idx" ON "councils" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "goals_user_status_idx" ON "goals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "insights_user_status_idx" ON "insights" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "insights_user_created_idx" ON "insights" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_user_type_idx" ON "reviews" USING btree ("user_id","type","created_at");--> statement-breakpoint
CREATE INDEX "runs_agent_idx" ON "runs" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "skills_agent_idx" ON "skills" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "tasks_user_status_idx" ON "tasks" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tasks_user_due_idx" ON "tasks" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "tasks_user_updated_idx" ON "tasks" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_user_accepted_idx" ON "tasks" USING btree ("user_id","accepted_at");--> statement-breakpoint
CREATE INDEX "user_actions_user_created_idx" ON "user_actions" USING btree ("user_id","created_at");