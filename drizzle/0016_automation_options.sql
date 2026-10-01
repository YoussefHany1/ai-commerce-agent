-- Per-trigger configuration for automation rules.
--
-- Added for the keyword trigger, which needs the list of words that should fire it
-- (`{"keywords":["price","order"]}`). The column is a generic JSON object rather than a
-- `keywords text[]` column so a future trigger can carry its own settings without
-- another migration; existing rows default to `{}`, which every trigger treats as
-- "no settings".
--
-- The `action` JSON is unchanged on disk: its shape is widened in code only
-- (`whatsapp_text` | `whatsapp_number` | `template`), which the existing jsonb column
-- already accommodates, so no data migration is required.
ALTER TABLE "automation_rules"
  ADD COLUMN IF NOT EXISTS "trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
