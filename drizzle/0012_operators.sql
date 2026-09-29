-- Operator identities, backed by Supabase Auth.
--
-- Until now the operator was not a person: the dashboard had a single shared
-- password (OPERATOR_PASSWORD_HASH) and one global ADMIN_API_KEY, with no identity
-- anywhere behind them. There was no row to suspend, no session to revoke
-- individually, and no way to tell two operators apart in a log.
--
-- This table makes the operator a first-class account, deliberately shaped like
-- `clients` so both principals read the same way. An operator is a Supabase Auth
-- user (`supabase_uid` = `auth.users.id`) with a local row that carries the
-- application-side facts: what to call them, and whether they are allowed in.
--
-- Two deliberate differences from `clients`:
--   * no `password_hash`. That column exists on `clients` only because
--     invite-only accounts predate Supabase; the operator password is being
--     deleted, not migrated, and nothing local is left to hash. Supabase Auth is
--     the only credential store, so there is no local hash to leak or to drift.
--   * no `client_id` policy tier. An operator is not a tenant: they are the tier
--     above tenants, so the policy below is the same one every other
--     `tenant_operator_*` policy uses. The fifteen per-store tables keep their
--     existing policies untouched.
--
-- `supabase_uid` is nullable so a row can exist before its auth user does (the
-- invite writes the row and the identity in either order), and unique while
-- present so one auth identity maps to at most one operator. A Supabase user with
-- no row here is not an operator: the exchange route resolves the identity
-- against this table and refuses when it misses, which is what keeps
-- "anyone who can sign up to Supabase" from becoming "anyone who can administer
-- the install".
CREATE TABLE "operators" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "supabase_uid" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Stored lowercased and trimmed, exactly like clients.email, so lookups and the
-- unique index cannot be dodged by casing.
CREATE UNIQUE INDEX "operators_email_uidx" ON "operators" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "operators_status_idx" ON "operators" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "operators_supabase_uid_uidx" ON "operators" USING btree ("supabase_uid");
--> statement-breakpoint
ALTER TABLE "operators" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Same shape as every other operator policy, on the same claim. There is no
-- per-operator self-service policy: an operator reading the directory is admin
-- work, and identity changes go through the API, which revokes the sessions.
CREATE POLICY "tenant_operator_operators" ON "operators"
  USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
  WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true');
--> statement-breakpoint
-- Same reasoning as 0007: without FORCE the table owner ignores the policy
-- above, and a DATABASE_URL pointing at the owner connection would look
-- perfectly healthy while reading and editing the operator directory.
ALTER TABLE "operators" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Grants for the Supabase runtime role, mirroring the end of 0010. The DO block
-- is a no-op on local/CI, where the role is absent and scripts/apply-rls.ts grants
-- `agent_app` instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO authenticated';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO authenticated';
  END IF;
END
$$;
