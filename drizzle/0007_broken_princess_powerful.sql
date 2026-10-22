CREATE TABLE "dissents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"council_id" text NOT NULL,
	"task_id" text,
	"agent_id" text NOT NULL,
	"warning" text NOT NULL,
	"condition" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dissents_user_idx" ON "dissents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dissents_status_idx" ON "dissents" USING btree ("status");--> statement-breakpoint
INSERT INTO "policy_config" ("key", "value_json", "description")
VALUES (
  'dissent',
  '{"trustBonus":15,"chiefPenalty":5,"precedentSalience":0.9}'::jsonb,
  'Cabinet policy: dissent'
)
ON CONFLICT ("key") DO NOTHING;
