ALTER TABLE "runs" ALTER COLUMN "tokens_in" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "tokens_in" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "tokens_out" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "tokens_out" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "provider_attempt_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_source" text;--> statement-breakpoint
CREATE INDEX "runs_provider_attempt_idx" ON "runs" USING btree ("provider_attempt_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cost_source_check" CHECK ("runs"."cost_source" IS NULL OR "runs"."cost_source" IN ('actual', 'estimated', 'unknown'));