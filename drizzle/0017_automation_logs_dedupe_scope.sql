-- Keyword rules must be able to answer the same customer more than once.
--
-- `automation_logs` enforced one row per (store, rule, conversation) forever. That is
-- right for poll triggers, which ask "has this rule already handled this conversation?"
-- but wrong for keyword triggers: a customer who types the keyword twice expects two
-- answers, and the second was silently swallowed by the unique conflict, leaving the AI
-- to reply instead.
--
-- `dedupe_scope` narrows the uniqueness to the trigger's actual semantics:
--   * poll triggers  -> 'conversation', the old behaviour
--   * keyword/edge   -> 'message', one row per inbound message
-- NULL means "no dedupe", so those rows never collide.
ALTER TABLE automation_logs
  ADD COLUMN IF NOT EXISTS dedupe_scope text;

UPDATE automation_logs
   SET dedupe_scope = 'conversation'
 WHERE dedupe_scope IS NULL
   AND conversation_id IS NOT NULL;

DROP INDEX IF EXISTS automation_logs_rule_conv_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS automation_logs_dedupe_uidx
  ON automation_logs (store_id, rule_id, conversation_id, dedupe_scope)
  WHERE dedupe_scope IS NOT NULL;