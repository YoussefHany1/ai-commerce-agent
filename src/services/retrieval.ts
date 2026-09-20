import { sql } from 'drizzle-orm';
import { withTenant } from '../db/client.js';
import { products } from '../db/schema.js';
import { config } from '../config.js';
import { catalogRepo } from '../db/repos.js';
import { embedTexts } from './embedding.js';
import { rerank, type Candidate } from './rerank.js';
import type { Product } from '../types.js';

export type Retrieved = { product: Product; score: number; source: 'fts' | 'vector' };

export type Retriever = {
  retrieve(query: string, storeId: string, opts?: { limit?: number }): Promise<Retrieved[]>;
};

const FIELDS = {
  id: products.id,
  title: products.title,
  description: products.description,
  price: products.price,
  currency: products.currency,
  available: products.available,
  url: products.url,
  sku: products.sku,
};

function rowToProduct(r: Record<string, any>): Product {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    price: r.price,
    currency: r.currency,
    available: r.available,
    url: r.url ?? undefined,
    sku: r.sku ?? undefined,
  };
}

export function validQuery(query: string): boolean {
  const t = query.trim();
  return t.length >= 2 && t.length <= 500;
}

export const ftsRetriever: Retriever = {
  async retrieve(query, storeId, opts = {}) {
    const limit = opts.limit ?? 8;
    if (!validQuery(query)) return [];
    const q = query.trim();
    return withTenant(storeId, async (tx) => {
      const rows = await tx
        .select({
          ...FIELDS,
          score: sql<number>`ts_rank(search_vector, plainto_tsquery('simple', ${q}))`,
        })
        .from(products)
        .where(sql`search_vector @@ plainto_tsquery('simple', ${q})`)
        .orderBy(sql`ts_rank(search_vector, plainto_tsquery('simple', ${q})) desc, title asc`)
        .limit(limit);
      return rows.map((r) => ({ product: rowToProduct(r), score: r.score, source: 'fts' as const }));
    });
  },
};

export const vectorRetriever: Retriever = {
  async retrieve(query, storeId, opts = {}) {
    const limit = opts.limit ?? 8;
    if (!config.OPENAI_API_KEY) return [];
    if (!validQuery(query)) return [];
    const emb = await embedTexts([query.trim()]);
    if (!emb?.[0]) return [];
    const v = `[${emb[0].join(',')}]`;
    return withTenant(storeId, async (tx) => {
      const rows = await tx
        .select({
          ...FIELDS,
          score: sql<number>`1 - (embedding <=> ${sql.raw(v)}::vector)`,
        })
        .from(products)
        .where(sql`embedding IS NOT NULL`)
        .orderBy(sql`embedding <=> ${sql.raw(v)}::vector`)
        .limit(limit);
      return rows.map((r) => ({ product: rowToProduct(r), score: r.score, source: 'vector' as const }));
    });
  },
};

export function mergeResults(fts: Retrieved[], vector: Retrieved[], limit: number): Retrieved[] {
  const bestFts = fts.length ? Math.max(...fts.map((x) => x.score)) : 0;
  const byId = new Map<string, Retrieved & { score: number }>();
  for (const r of fts) {
    const norm = bestFts > 0 ? r.score / bestFts : 0;
    byId.set(r.product.id, { ...r, score: norm });
  }
  for (const r of vector) {
    const sim = Math.max(r.score, 0);
    const prev = byId.get(r.product.id);
    byId.set(r.product.id, { ...r, score: (prev?.score ?? 0) + sim });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export const hybridRetriever: Retriever = {
  async retrieve(query, storeId, opts = {}) {
    const limit = opts.limit ?? 8;
    const [fts, vec] = await Promise.all([
      ftsRetriever.retrieve(query, storeId, { limit }),
      vectorRetriever.retrieve(query, storeId, { limit }),
    ]);
    return mergeResults(fts, vec, limit);
  },
};

export function retrieve(
  query: string,
  storeId: string,
  opts?: { limit?: number; mode?: 'fts' | 'vector' | 'hybrid'; rerank?: 'off' | 'synonym' | 'embedding' },
): Promise<Retrieved[]> {
  const mode = opts?.mode ?? config.RETRIEVAL_MODE;
  const limit = opts?.limit ?? 8;
  const retriever = mode === 'fts' ? ftsRetriever : mode === 'vector' ? vectorRetriever : hybridRetriever;
  const rerankMode = opts?.rerank ?? config.RETRIEVAL_RE_RANK;

  return retriever.retrieve(query, storeId, { limit }).then((cands) => {
    if (rerankMode === 'off') return cands;
    return rerank(query, storeId, cands as Candidate[], rerankMode, limit) as Promise<Retrieved[]>;
  });
}

export async function embedMissingCatalog(storeId: string): Promise<number> {
  if (!config.OPENAI_API_KEY) return 0;
  const rows = await catalogRepo.missingEmbeddingTitles(storeId);
  if (!rows.length) return 0;
  const vecs = await embedTexts(rows.map((r) => r.title));
  if (!vecs) return 0;
  await catalogRepo.updateEmbeddings(
    storeId,
    rows.map((r, i) => ({ id: r.id, embedding: vecs[i] })),
  );
  return vecs.length;
}