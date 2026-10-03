import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTenant } from '../db/client.js';
import { products } from '../db/schema.js';
import { config } from '../config.js';
import { embedTexts } from './embedding.js';
import type { Product } from '../types.js';

export type Candidate = { product: Product; score: number; source: string };

const norm = (s: string) => s.toLowerCase();

export const SYNONYM_GROUPS: Record<string, string[]> = {
  shirt: ['shirt', 't-shirt', 'tshirt', 'tee', 't shirt', 'قميص', 'تيشيرت'],
  white: ['white', 'ابيض', 'أبيض'],
  black: ['black', 'اسود', 'أسود'],
  cotton: ['cotton', 'قطن', 'قطني'],
  mug: ['mug', 'cup', 'كوب', 'كاسة', 'مج'],
  bottle: ['bottle', 'زجاجة', 'قنينة'],
};

export function expandQuery(query: string): string[] {
  const q = norm(query);
  const out = new Set<string>();
  for (const group of Object.values(SYNONYM_GROUPS)) {
    if (group.some((v) => q.includes(norm(v)))) {
      for (const v of group) out.add(norm(v));
    }
  }
  const tokens = q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  for (const t of tokens) {
    out.add(t);
    for (const group of Object.values(SYNONYM_GROUPS)) {
      if (group.some((v) => norm(v) === t)) {
        for (const v of group) out.add(norm(v));
      }
    }
  }
  return [...out];
}

export function scoreCandidate(terms: string[], title: string, description?: string | null): number {
  const t = norm(title);
  const d = norm(description ?? '');
  let score = 0;
  for (const term of terms) {
    if (t.includes(term)) score += 2;
    if (d.includes(term)) score += 1;
  }
  return score;
}

function sortCandidates(items: Candidate[]): Candidate[] {
  return [...items].sort((a, b) => b.score - a.score);
}

export function lexicalReRank(query: string, candidates: Candidate[]): Candidate[] {
  if (!candidates.length) return [];
  const terms = expandQuery(query);
  const scored = candidates.map((c) => ({
    ...c,
    score: scoreCandidate(terms, c.product.title, c.product.description),
  }));
  return sortCandidates(scored);
}

export async function synonymRecall(
  query: string,
  storeId: string,
  limit: number,
): Promise<Candidate[]> {
  const terms = expandQuery(query).filter((t) => t.length >= 2);
  if (!terms.length) return [];
  const conditions = terms.map(
    (t) => sql`(lower("products"."title") like ${'%' + t + '%'} or lower("products"."description") like ${'%' + t + '%'})`,
  );
  const where = and(
    eq(products.storeId, storeId),
    sql`"products"."embedding" is not null`,
    conditions.length > 1 ? sql`${sql.join(conditions, sql` or `)}` : conditions[0],
  );
  const rows = (await withTenant(storeId, async (tx) => {
    return tx.execute(
      sql`select id::text as id, title, description, price, currency, available, url, sku from products where ${where} limit ${limit}`,
    );
  })) as any[];
  if (!rows.length) return [];
  const scoreMap = new Map<string, number>();
  const productMap = new Map<string, Product>();
  for (const r of rows) {
    const p: Product = {
      id: String(r.id),
      title: String(r.title),
      description: r.description ?? undefined,
      price: Number(r.price),
      currency: String(r.currency),
      available: Boolean(r.available),
      url: r.url ?? undefined,
      sku: r.sku ?? undefined,
    };
    const s = scoreCandidate(terms, p.title, p.description);
    if (s > (scoreMap.get(p.id) ?? 0)) {
      scoreMap.set(p.id, s);
      productMap.set(p.id, p);
    }
  }
  return [...scoreMap.entries()]
    .map(([id, score]) => ({ product: productMap.get(id)!, score, source: 'recall' }))
    .sort((a, b) => b.score - a.score);
}

export function dedupeById(items: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of items) {
    const prev = best.get(c.product.id);
    if (!prev || c.score > prev.score) best.set(c.product.id, c);
  }
  return [...best.values()];
}

export async function embeddingReRank(
  query: string,
  storeId: string,
  candidates: Candidate[],
  queryEmbedding?: number[] | null,
): Promise<Candidate[]> {
  if (!config.OPENAI_API_KEY) return lexicalReRank(query, candidates);
  // Reuse the caller's query vector when available; `undefined` means unresolved,
  // while an explicit null means "already attempted" and falls straight through.
  const vec = queryEmbedding !== undefined ? queryEmbedding : (await embedTexts([query.trim()]))?.[0];
  if (!vec) return lexicalReRank(query, candidates);
  const v = `[${vec.join(',')}]`;
  const ids = candidates.map((c) => c.product.id);
  if (!ids.length) return [];
  const sims = new Map<string, number>();
  const rows = (await withTenant(storeId, async (tx) => {
    return tx.execute(
      sql`select id::text as id, 1 - (embedding <=> ${sql.raw(v)}::vector) as similarity
          from products where store_id = ${storeId} and embedding is not null and ${inArray(products.id, ids)}`,
    );
  })) as any[];
  for (const r of rows) sims.set(String(r.id), Number(r.similarity));
  const byId = new Map(candidates.map((c) => [c.product.id, c]));
  const ranked: Candidate[] = [];
  for (const [id, similarity] of [...sims.entries()].sort((a, b) => b[1] - a[1])) {
    const orig = byId.get(id)!;
    ranked.push({ ...orig, score: similarity, source: 'embedding' });
  }
  for (const c of candidates) if (!sims.has(c.product.id)) ranked.push({ ...c, source: 'embedding-fallback' });
  return ranked;
}

export async function rerank(
  query: string,
  storeId: string,
  candidates: Candidate[],
  mode: string,
  limit: number,
  queryEmbedding?: number[] | null,
): Promise<Candidate[]> {
  if (mode === 'off') return candidates.slice(0, limit);
  const recall = await synonymRecall(query, storeId, limit);
  const pool = dedupeById([...candidates, ...recall]);
  if (mode === 'embedding') {
    return embeddingReRank(query, storeId, pool, queryEmbedding).then((r) => r.slice(0, limit));
  }
  return lexicalReRank(query, pool).slice(0, limit);
}