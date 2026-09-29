-- Supabase-aligned tenancy and credential model.
--
-- Up until this migration, tenant isolation read three separate GUCs the app
-- set per request (app.store_id / app.operator / app.client_id) via the
-- dedicated `agent_app` runtime role. Supabase cannot host a custom role and its
-- owner connections (postgres / service_role) bypass RLS entirely, so both the
-- policy language and the identity carrier are re-expressed in Supabase terms:
--
--   * policies now read `public.auth_jwt()` (a shim over the `request.jwt.claims`
--     GUC, the same placeholder custom variable Supabase and PostgREST use);
--   * `src/db/client.ts` sets the whole identity as one JSON claim object per
--     transaction, inside the same transaction as the work;
--   * on Supabase the runtime connects as the `authenticated` role (grants below);
--     on local/CI Postgres the existing `agent_app` role keeps working unchanged;
--   * operator reads no longer assume a special role or bypass — they ride the
--     claim `{app:{operator:'true'}}` exactly like the GUC did before.
--
-- This also starts the migration of account credentials to Supabase Auth:
-- `clients.password_hash` becomes nullable legacy (NULL = managed by Supabase),
-- and `clients.supabase_uid` links a row to `auth.users.id`.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.auth_jwt() RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "clients"."password_hash" IS
'Legacy scrypt digest for pre-Supabase operator-created accounts. NULL for every
Supabase-managed account - Supabase Auth owns all credentials from this migration
onward, so the only reader left is the pre-migration login path.';
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "supabase_uid" uuid;
--> statement-breakpoint
COMMENT ON COLUMN "clients"."supabase_uid" IS
'The auth.users.id on Supabase that backs this account. NULL until linked by the
import script or by first Supabase sign-in; unique while present.';
--> statement-breakpoint
CREATE UNIQUE INDEX "clients_supabase_uid_uidx" ON "clients" USING btree ("supabase_uid");
--> statement-breakpoint
-- --- Replace the app.* GUC policy families with claim-based equivalents. ---
-- First remove every 0004/0006/0009 policy, then recreate on the same names over
-- the JWT claim. An absent claim yields '' -> null, so a bare connection matches
-- no rows, just as the GUCs did.
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_stores" ON "stores";
DROP POLICY IF EXISTS "tenant_operator_stores" ON "stores";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_platform_connections" ON "platform_connections";
DROP POLICY IF EXISTS "tenant_operator_platform_connections" ON "platform_connections";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_products" ON "products";
DROP POLICY IF EXISTS "tenant_operator_products" ON "products";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_variants" ON "variants";
DROP POLICY IF EXISTS "tenant_operator_variants" ON "variants";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_customers" ON "customers";
DROP POLICY IF EXISTS "tenant_operator_customers" ON "customers";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_orders" ON "orders";
DROP POLICY IF EXISTS "tenant_operator_orders" ON "orders";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_conversations" ON "conversations";
DROP POLICY IF EXISTS "tenant_operator_conversations" ON "conversations";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_messages" ON "messages";
DROP POLICY IF EXISTS "tenant_operator_messages" ON "messages";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_events" ON "events";
DROP POLICY IF EXISTS "tenant_operator_events" ON "events";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_automation_rules" ON "automation_rules";
DROP POLICY IF EXISTS "tenant_operator_automation_rules" ON "automation_rules";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_automation_logs" ON "automation_logs";
DROP POLICY IF EXISTS "tenant_operator_automation_logs" ON "automation_logs";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_jobs" ON "jobs";
DROP POLICY IF EXISTS "tenant_operator_jobs" ON "jobs";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_attributions" ON "attributions";
DROP POLICY IF EXISTS "tenant_operator_attributions" ON "attributions";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_whatsapp_channels" ON "whatsapp_channels";
DROP POLICY IF EXISTS "tenant_operator_whatsapp_channels" ON "whatsapp_channels";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_billing_subscriptions" ON "billing_subscriptions";
DROP POLICY IF EXISTS "tenant_operator_billing_subscriptions" ON "billing_subscriptions";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_daily_metrics" ON "daily_metrics";
DROP POLICY IF EXISTS "tenant_operator_daily_metrics" ON "daily_metrics";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_operator_clients" ON "clients";
DROP POLICY IF EXISTS "tenant_client_clients" ON "clients";
DROP POLICY IF EXISTS "tenant_client_stores" ON "stores";
--> statement-breakpoint
-- The per-store tables keep exactly two policies (store_id isolation + operator),
-- on the same names, now expressed over the JWT claim. An absent claim yields
-- '' -> null, so a bare connection matches no rows, just as the GUCs did.
-- `stores` is the deliberate exception: it has no store_id column, so its scope
-- is client_id (tenant_client_stores below) and operator, exactly as before.
--> statement-breakpoint
CREATE POLICY "tenant_operator_stores" ON "stores"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_platform_connections" ON "platform_connections"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_platform_connections" ON "platform_connections"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_products" ON "products"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_products" ON "products"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_variants" ON "variants"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_variants" ON "variants"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_customers" ON "customers"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_customers" ON "customers"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_orders" ON "orders"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_orders" ON "orders"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_conversations" ON "conversations"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_conversations" ON "conversations"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_messages" ON "messages"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_messages" ON "messages"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_events" ON "events"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_events" ON "events"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_automation_rules" ON "automation_rules"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_automation_rules" ON "automation_rules"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_automation_logs" ON "automation_logs"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_automation_logs" ON "automation_logs"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_jobs" ON "jobs"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_jobs" ON "jobs"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_attributions" ON "attributions"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_attributions" ON "attributions"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_whatsapp_channels" ON "whatsapp_channels"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_whatsapp_channels" ON "whatsapp_channels"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_billing_subscriptions" ON "billing_subscriptions"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_billing_subscriptions" ON "billing_subscriptions"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_isolation_daily_metrics" ON "daily_metrics"
USING (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
WITH CHECK (store_id = nullif(public.auth_jwt() #>> '{app,store_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_operator_daily_metrics" ON "daily_metrics"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
-- The three client-scoped policies, on the same names as before. A client may
-- read its own row (the guards re-read status on every request) but not edit it:
-- password/credential changes go through the API, which bumps the session epoch.
--> statement-breakpoint
CREATE POLICY "tenant_operator_clients" ON "clients"
USING ((public.auth_jwt() #>> '{app,operator}') = 'true')
WITH CHECK ((public.auth_jwt() #>> '{app,operator}') = 'true')
--> statement-breakpoint
CREATE POLICY "tenant_client_clients" ON "clients"
USING (id = nullif(public.auth_jwt() #>> '{app,client_id}', '')::uuid)
--> statement-breakpoint
CREATE POLICY "tenant_client_stores" ON "stores"
USING (client_id = nullif(public.auth_jwt() #>> '{app,client_id}', '')::uuid)
WITH CHECK (client_id = nullif(public.auth_jwt() #>> '{app,client_id}', '')::uuid)
--> statement-breakpoint
-- Grants for the Supabase runtime role. `authenticated` exists only on Supabase
-- and ships with no default privileges on the public schema, so the app there
-- needs explicit grants; the DO block is a no-op on local/CI where the role is
-- absent and `agent_app` is granted by scripts/apply-rls.ts instead.
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO authenticated';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO authenticated';
  END IF;
END
$$;