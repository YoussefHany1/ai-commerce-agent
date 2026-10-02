-- Transient send failures used to be permanent. `claim` dedupes on
-- (store_id, rule_id, dedupe_key) with ON CONFLICT DO NOTHING, and a failed send left
-- its row owning that key — so every later tick hit the conflict, returned no id, and
-- the order was skipped forever. Two orders failed during the window after the app was
-- reinstalled but before WhatsApp was paired, and never recovered.
--
-- Track how many attempts a claim has had and when the last one happened so `claim`
-- can reclaim a `failed` row a few times with backoff, then stop.
ALTER TABLE automation_logs
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

-- Existing failed rows predate retry tracking. Leaving them at attempts = 0 means
-- `claim` will pick them up again on the next tick, which is the intent: they failed
-- before retries existed and deserve one. Successful/pending rows are untouched because
-- `claim` only reclaims when status = 'failed'.
