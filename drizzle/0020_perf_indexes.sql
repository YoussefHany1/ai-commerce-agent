-- Performance indexes for hot paths found in the Phase 1 audit. Every statement
-- is IF NOT EXISTS so re-running a partially applied migration is safe.
--
-- Note: the meta/ snapshots stop at 0004, so hand-written migrations (0005+) are
-- the convention here — `drizzle-kit generate` would try to re-emit everything
-- since 0004. This file and its journal entry follow that convention.

-- Sync schedulers filter connections by when they last synced.
CREATE INDEX IF NOT EXISTS platform_connections_last_synced_idx
  ON platform_connections (last_synced_at);
--> statement-breakpoint

-- Catalog listing/ordering and title lookups are store-scoped.
CREATE INDEX IF NOT EXISTS products_store_title_idx
  ON products (store_id, title);
--> statement-breakpoint

-- Conversation transcripts are read newest-first per conversation.
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, "createdAt");
--> statement-breakpoint

-- The automation worker selects enabled rules by trigger type per store.
CREATE INDEX IF NOT EXISTS automation_rules_store_enabled_idx
  ON automation_rules (store_id, enabled, trigger_type);
--> statement-breakpoint

-- The jobs worker polls pending jobs whose run_at has passed, oldest first.
CREATE INDEX IF NOT EXISTS jobs_status_run_at_idx
  ON jobs (status, run_at);
--> statement-breakpoint

-- Analytics rollups scan attributions per store by creation and by the two
-- nullable funnel timestamps; partial indexes keep those scans off the nulls.
CREATE INDEX IF NOT EXISTS attributions_store_created_idx
  ON attributions (store_id, "createdAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS attributions_store_converted_idx
  ON attributions (store_id, converted_at)
  WHERE converted_at IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS attributions_store_clicked_idx
  ON attributions (store_id, "clickedAt")
  WHERE "clickedAt" IS NOT NULL;
