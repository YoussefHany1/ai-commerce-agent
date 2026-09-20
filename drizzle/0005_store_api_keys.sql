ALTER TABLE "stores" ADD COLUMN "api_key_hash" text;
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "api_key_hint" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "stores_api_key_hash_unique" ON "stores" ("api_key_hash") WHERE "api_key_hash" IS NOT NULL;
--> statement-breakpoint
-- Allow the least-privilege tenant role to read its own store row so a store-scoped
-- API key (sk_live_…) can be verified against the stored SHA-256 hash. The row only
-- carries the key hash + a 4-char hint; the raw key is never persisted.
CREATE POLICY "tenant_self_stores" ON "stores"
FOR SELECT
USING (id = nullif(current_setting('app.store_id', true), '')::uuid)
WITH CHECK (id = nullif(current_setting('app.store_id', true), '')::uuid);