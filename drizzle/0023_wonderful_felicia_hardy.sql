ALTER TABLE "agent_grants" ADD COLUMN "action" text DEFAULT '*' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "created_by_approval_id" text;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "max_cents" integer;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "max_runs" integer;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_grants_policy_idx" ON "agent_grants" USING btree ("agent_id","resource","action");