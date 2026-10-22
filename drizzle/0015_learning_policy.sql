INSERT INTO "policy_config" ("key", "value_json", "description")
VALUES (
  'learning',
  '{"progressWeights":{"acceptedTasks":0.5,"recall":0.3,"checkins":0.2},"targetCheckinsPerWeek":5,"nextTask":{"estimateMin":25,"minRecallScore":0.6,"minWords":60,"maxErrorTags":3,"retestAfterDays":3}}'::jsonb,
  'Learning progress weights and next-task policy'
)
ON CONFLICT ("key") DO NOTHING;
