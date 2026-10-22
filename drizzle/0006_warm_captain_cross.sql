ALTER TABLE "memories" ADD COLUMN "fact_key" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "value" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by" text;--> statement-breakpoint
CREATE INDEX "memories_fact_idx" ON "memories" USING btree ("user_id","fact_key");--> statement-breakpoint
UPDATE "memories" SET "valid_from" = "created_at";
--> statement-breakpoint
INSERT INTO "policy_config" ("key", "value_json", "description")
VALUES (
  'reflection',
  '{"windowDays":7,"minRejectEvents":1,"minTaskSample":2,"eveningHour":20,"eveningCompletionThreshold":0.5,"lowEnergyThreshold":2,"budgetPressureRatio":0.8,"confidence":0.72}'::jsonb,
  'Cabinet policy: reflection'
)
ON CONFLICT ("key") DO NOTHING;
