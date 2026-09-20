import { expect, it } from 'vitest';
import { evaluateCase, hitsAt, mrr, ndcgAt, recallAt, summarize } from './scoring.js';

const tee = 'tee-1';
const mug = 'mug-1';

it('hitsAt checks the top-k window', () => {
  expect(hitsAt(['a', 'b', 'c'], new Set(['b']), 3)).toBe(true);
  expect(hitsAt(['a', 'b', 'c'], new Set(['b']), 1)).toBe(false);
});

it('recallAt is the share of relevant found in top-k', () => {
  expect(recallAt(['a', 'b', 'c'], new Set(['a', 'b', 'x']), 3)).toBeCloseTo(2 / 3, 5);
});

it('mrr is 1 over the first relevant rank', () => {
  expect(mrr(['a', 'b', 'c'], new Set(['b']))).toBe(0.5);
  expect(mrr(['a', 'b', 'c'], new Set(['x']))).toBe(0);
});

it('ndcgAt5 gives full credit for a perfect ranking and partial for a later hit', () => {
  const relevant = new Set([tee, mug]);
  expect(ndcgAt([tee, mug], relevant, 5)).toBeCloseTo(1, 5);
  const later = ndcgAt([mug, 'x', 'y', 'z', tee], relevant, 5);
  expect(later).toBeGreaterThan(0.2);
  expect(later).toBeLessThan(1);
});

it('evaluateCase builds a scored result', () => {
  const r = evaluateCase('black tee', [
    { id: 'tee-1', title: 'Tee', score: 0.9, source: 'fts' },
    { id: 'mug-1', title: 'Mug', score: 0.4, source: 'vector' },
  ], [tee]);
  expect(r.mrr).toBe(1);
  expect(r.hitsAt1).toBe(true);
  expect(r.recallAt3).toBe(1);
  expect(r.topProducts[1].source).toBe('vector');
});

it('summarize averages metrics only over cases with relevant targets', () => {
  const good = evaluateCase('a', [{ id: 'a', title: 'A', score: 1, source: 'fts' }], ['a']);
  const bad = evaluateCase('b', [], ['a']);
  const decoy = evaluateCase('c', [], []);
  const s = summarize([good, bad, decoy]);
  expect(s.cases).toBe(3);
  expect(s.nonzeroRelevant).toBe(2);
  expect(s.mrr).toBeCloseTo(0.5, 5);
  expect(s.hitsAt1).toBe(1);
});