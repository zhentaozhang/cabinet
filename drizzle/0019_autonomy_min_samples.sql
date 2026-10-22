-- Data-only migration: add the audit sample floor to workspaces that already
-- exist. A nested setting is invisible to the top-level provisioning loop, so
-- without this every pre-existing workspace would fail closed on the new key.
UPDATE "policy_config"
SET "value_json" = "value_json" || '{"minAuditSamples":5}'::jsonb
WHERE "key" = 'autonomy' AND NOT ("value_json" ? 'minAuditSamples');
