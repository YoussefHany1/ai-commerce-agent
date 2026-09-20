import { describe, expect, it } from 'vitest';
import { mergeResults, validQuery } from './retrieval.js';
import type { Retrieved } from './retrieval.js';

const p = (id: string, title: string, score: number, source: Retrieved['source'] = 'fts'): Retrieved => ({
  product: { id, title, price: 0, currency: 'SAR', available: true },
  score,
  source,
});

describe('validQuery', () => {
  it('rejects short/empty/oversized queries', () => {
    expect(validQuery('')).toBe(false);
    expect(validQuery('a')).toBe(false);
    expect(validQuery('  a  ')).toBe(false);
    expect(validQuery('ok')).toBe(true);
    expect(validQuery('x'.repeat(501))).toBe(false);
  });
});

describe('mergeResults', () => {
  it('returns only fts results when vector is empty', () => {
    const fts = [p('1', 'Tee', 0.9), p('2', 'Cap', 0.4)];
    const out = mergeResults(fts, [], 8);
    expect(out.map((r) => r.product.id)).toEqual(['1', '2']);
    expect(out[0].score).toBeCloseTo(1);
  });

  it('sums normalized scores for overlapping products (hybrid boost)', () => {
    const fts = [p('1', 'Tee', 0.5), p('2', 'Cap', 1)];
    const vec = [p('1', 'Tee', 0.8, 'vector')];
    const out = mergeResults(fts, vec, 8);
    const one = out.find((r) => r.product.id === '1')!;
    const two = out.find((r) => r.product.id === '2')!;
    expect(out).toHaveLength(2);
    expect(one.score).toBeGreaterThan(two.score);
  });

  it('respects the limit', () => {
    const fts = [0.9, 0.8, 0.7].map((s, i) => p(String(i), 'x', s));
    expect(mergeResults(fts, [], 2)).toHaveLength(2);
  });
});