ALTER TABLE "tasks" ADD COLUMN "topic_key" text;--> statement-breakpoint
CREATE INDEX "tasks_user_topic_idx" ON "tasks" USING btree ("user_id","topic_key");