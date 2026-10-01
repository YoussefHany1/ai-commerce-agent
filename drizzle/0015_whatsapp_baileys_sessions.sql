-- WhatsApp Web (Baileys) pairing state, one row per paired number.
--
-- This is a new table rather than extra columns on `whatsapp_channels`, and the
-- reason is a constraint conflict rather than a preference:
--
--   * `whatsapp_channels.phone_number_id` is `notNull()` with a unique index, but
--     during QR pairing no phone number exists yet. Baileys starts emitting a QR
--     before any number is known, and `creds` must be persisted during that window
--     or a redeploy mid-handshake loses the pairing.
--   * A placeholder in that NOT NULL unique column would then have to be displaced
--     by a later Meta `upsert`, which clobbers the Baileys state instead of
--     coexisting with it.
--   * `whatsappRepo.byStore` is `.limit(1)` with no `ORDER BY`, so two rows make
--     transport selection nondeterministic.
--
-- So the two transports share `stores` and nothing else. A store may hold one Meta
-- channel row and one Baileys session row independently.
--
-- Two further details that are not obvious from the column names:
--
--   * `state_enc` holds the *complete* Baileys `{ creds, keys }` auth state, not
--     `creds` alone. `keys` carries the Signal pre-key and session records; dropping
--     them silently breaks a session that otherwise looks correctly paired.
--   * `phone` stores bare digits, never a JID. It is compared against order phone
--     numbers in `markConversationsForOrder`, where a `@s.whatsapp.net` suffix
--     would silently fail to match and lose attribution.
--
-- `status` mirrors the live socket so a redeploy leaves the dashboard reading a real
-- connection state rather than a column that can drift from it:
--   'idle' | 'connecting' | 'qr' | 'open' | 'logged_out' | 'replaced' | 'error'
--
-- Deliberately no `connectionType` column. Baileys is the only value it would ever
-- hold (Meta lives in `whatsapp_channels`), and a column that cannot vary would let
-- dispatch key off a stale flag instead of the live session map.
CREATE TABLE "whatsapp_baileys_sessions" (
  "store_id" uuid PRIMARY KEY NOT NULL,
  "state_enc" text NOT NULL,
  "key_version" text DEFAULT 'v1' NOT NULL,
  "phone" text,
  "status" text DEFAULT 'idle' NOT NULL,
  "last_error" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "whatsapp_baileys_sessions_store_id_stores_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "stores" ("id") ON DELETE cascade
);
--> statement-breakpoint
-- Serves the lease scan and the dashboard status read, both of which filter on
-- status without touching store_id.
CREATE INDEX "whatsapp_baileys_sessions_status_idx" ON "whatsapp_baileys_sessions" USING btree ("status");
--> statement-breakpoint
-- store_id is the primary key, so the isolation policy below resolves through the
-- same index the lease scan uses.
ALTER TABLE "whatsapp_baileys_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_whatsapp_baileys_sessions" ON "whatsapp_baileys_sessions"
  USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
  WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_operator_whatsapp_baileys_sessions" ON "whatsapp_baileys_sessions"
  USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
  WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true');
--> statement-breakpoint
-- Same reasoning as 0007: without FORCE the table owner ignores the policies above,
-- and a DATABASE_URL pointing at the owner connection would look perfectly healthy
-- while reading and rewriting every tenant's pairing state. `state_enc` is ciphertext,
-- but it is still another merchant's live WhatsApp session.
ALTER TABLE "whatsapp_baileys_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Mirrors the end of 0012: a no-op on local/CI, where the role is absent and
-- scripts/apply-rls.ts grants `agent_app` instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO authenticated';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO authenticated';
  END IF;
END
$$;