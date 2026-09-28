-- Order backfill. Metrics were derived entirely from locally captured rows, and the
-- only writer of `orders` was the orders/create|update webhook. A store that
-- installed the app after it had already taken sales therefore reported zero
-- revenue for its entire history: nothing backfilled `orders`, and nothing
-- registered the webhook in the first place.
--
-- Two columns make an incremental backfill possible:
--   * orders.placed_at           — when the order happened on the platform. Backfilled
--                                  rows arrive late, so the daily rollup must bucket on
--                                  this rather than on the ingestion timestamp.
--   * platform_connections.orders_synced_at — resume cursor, so each order.sync run
--                                  walks forward from the last sync instead of the
--                                  beginning of the store's history.
ALTER TABLE "orders" ADD COLUMN "placed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_connections" ADD COLUMN "orders_synced_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "orders_store_placed_at_idx" ON "orders" USING btree ("store_id","placed_at");
--> statement-breakpoint
CREATE INDEX "platform_connections_orders_due_idx" ON "platform_connections" USING btree ("orders_synced_at");
