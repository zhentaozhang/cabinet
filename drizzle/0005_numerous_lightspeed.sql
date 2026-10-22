ALTER TABLE "council_positions" ADD COLUMN "scores" jsonb;--> statement-breakpoint
ALTER TABLE "council_positions" ADD COLUMN "is_dissent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "council_positions" ADD COLUMN "falsification_condition" jsonb;--> statement-breakpoint
ALTER TABLE "councils" ADD COLUMN "matrix" jsonb;--> statement-breakpoint
ALTER TABLE "councils" ADD COLUMN "resolution" jsonb;--> statement-breakpoint
ALTER TABLE "councils" ADD COLUMN "resolution_applied_at" timestamp with time zone;--> statement-breakpoint
INSERT INTO "policy_config" ("key", "value_json", "description")
VALUES (
  'council',
  '{"roleWeights":{"chief":1.1,"researcher":1,"coach":1,"treasurer":1.1,"critic":1.2,"auditor":0.8},"dimensionWeights":{"feasibility":0.3,"costEfficiency":0.25,"evidenceQuality":0.25,"robustness":0.2},"score":{"base":50,"goalWeight":0.3,"trustWeight":0.2,"evidencePoints":20,"rejectPenalty":15,"pausePenalty":30,"budgetPressureWeight":100},"minPositions":3,"minEnergy":3,"dissentWindowDays":7,"dissentBudgetRatio":0.8}'::jsonb,
  'Cabinet policy: council'
)
ON CONFLICT ("key") DO NOTHING;
