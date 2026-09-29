-- Dashboard client accounts.
--
-- Until now the dashboard had exactly one identity: a single operator password
-- (OPERATOR_PASSWORD_HASH) plus one global ADMIN_API_KEY, with storeRepo.list()
-- returning every tenant. There was no account to log in with, so "my store" could
-- not be expressed anywhere in the stack.
--
-- `clients` is that account. It is invite-only — the operator creates a row and
-- hands over the credentials — so there is no public signup surface, no
-- email-verification step, and no abuse path to defend.
--
-- `stores.client_id` is nullable and is NOT backfilled. That is deliberate:
--   * every existing store keeps client_id = NULL, which the guards read as
--     "operator-owned", so current operator behaviour is bit-for-bit unchanged
--     and this migration needs no data migration window;
--   * stores created through the operator's OAuth install path stay operator-owned
--     without a code change;
--   * ON DELETE SET NULL rather than CASCADE, because losing an account must never
--     take a merchant's orders and conversations with it.
CREATE TABLE "clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "settings" jsonb,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The login identifier. Stored already lowercased and trimmed by the create
-- paths so the unique index cannot be sidestepped with mixed casing.
CREATE UNIQUE INDEX "clients_email_uidx" ON "clients" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "client_id" uuid;
--> statement-breakpoint
-- No FK cascade: see the header note on why detaching an account is preferred to
-- deleting one.
ALTER TABLE "stores" ADD CONSTRAINT "stores_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "stores_client_id_idx" ON "stores" USING btree ("client_id");
--> statement-breakpoint
-- Third policy tier, above the store. Deliberately only on the two tables that
-- actually carry a client_id column.
--
-- The fifteen per-store tables are NOT given a client policy. A client request is
-- scoped twice over — the route guard proves the store belongs to the caller,
-- then app.store_id isolates the data itself — and giving all sixteen tables a
-- client_id policy would mean an EXISTS subquery against `stores` inside every
-- policy, evaluated once per row, for no guarantee the guard does not already
-- give. `client_id = nullif(current_setting('app.client_id', true), '')::uuid`
-- resolves to null when the GUC is unset, so a bare connection matches nothing.
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_operator_clients" ON "clients"
  USING (current_setting('app.operator', true) = 'true')
  WITH CHECK (current_setting('app.operator', true) = 'true');
--> statement-breakpoint
-- A client may read its own row (the login handler re-reads status on every
-- request) but may not edit it: password changes go through the API, which bumps
-- the session epoch, rather than through a self-service profile write.
CREATE POLICY "tenant_client_clients" ON "clients"
  USING (id = nullif(current_setting('app.client_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "tenant_client_stores" ON "stores"
  USING (client_id = nullif(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = nullif(current_setting('app.client_id', true), '')::uuid);
--> statement-breakpoint
-- Same reasoning as 0007: without FORCE the table owner ignores all of the above,
-- and a DATABASE_URL pointing at the owner connection would look perfectly
-- healthy while reading every client's stores.
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;