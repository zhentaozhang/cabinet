UPDATE "policy_config"
SET "value_json" = "value_json" || '{"maxOutputTokens":1200,"maxRunCents":50}'::jsonb
WHERE "key" = 'cost';
