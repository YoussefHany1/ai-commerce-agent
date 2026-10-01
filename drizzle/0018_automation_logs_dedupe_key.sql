-- Corrects `0017`, which added `dedupe_scope` but keyed uniqueness on
-- `conversation_id` instead of the per-message `dedupe_key`. As written that index
-- would have kept the original bug for poll triggers and made the new column unused.
--
-- `dedupe_key` is the value the rule is unique *per*:
--   * poll triggers  -> the conversation id (unchanged behaviour)
--   * inbound/keyword-> the inbound message id, so a repeated keyword replies again
ALTER TABLE automation_logs
  ADD COLUMN IF NOT EXISTS dedupe_key uuid;

-- Backfill before indexing: unique indexes treat NULLs as distinct, so the pre-existing
-- 'conversation' rows would otherwise all become claimable and could double-send.
UPDATE automation_logs
   SET dedupe_key = conversation_id
 WHERE dedupe_key IS NULL
   AND dedupe_scope = 'conversation'
   AND conversation_id IS NOT NULL;

DROP INDEX IF EXISTS automation_logs_dedupe_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS automation_logs_dedupe_uidx
  ON automation_logs (store_id, rule_id, dedupe_key)
  WHERE dedupe_scope IS NOT NULL;