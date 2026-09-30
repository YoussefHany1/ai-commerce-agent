-- Storefront widget embed key.
--
-- A public, non-secret identifier the merchant pastes into their own storefront
-- so the widget can mint a customer session without holding the admin key or the
-- store API key. Stored in the clear on purpose (the merchant must be able to
-- read it back to copy it); it is not a credential, and no operator or dashboard
-- guard accepts it. Uniquely indexed so a key resolves to exactly one store.
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "embed_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stores_embed_key_idx" ON "stores" ("embed_key");
