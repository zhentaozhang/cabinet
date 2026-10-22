ALTER TABLE "skills" ADD COLUMN "label" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "eval_set" jsonb;