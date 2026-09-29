-- Store-scoped API keys.
--
-- 0005_store_api_keys.sql was authored as an empty file, so the columns schema.ts
-- declares and src/lib/auth.ts (store-key auth) reads were never created on any
-- migrated database. Fresh installs, CI databases, and the Supabase target all
-- produce a `stores` table without api_key_hash/api_key_hint, and every full-row
-- insert/select of stores fails with 42703. This migration finally creates them,
-- matching the schema definitions exactly (nullable).
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "api_key_hash" text;
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "api_key_hint" text;