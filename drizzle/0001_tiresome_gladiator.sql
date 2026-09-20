ALTER TABLE "products" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS ((setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B') || setweight(to_tsvector('simple', coalesce(sku, '')), 'C'))) STORED;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
CREATE INDEX "products_search_vector_gin" ON "products" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "products_embedding_hnsw" ON "products" USING hnsw ("embedding" vector_cosine_ops);