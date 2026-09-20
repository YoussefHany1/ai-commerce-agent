import { describe, expect, it } from 'vitest';
import { expandQuery, scoreCandidate, lexicalReRank, dedupeById, type Candidate } from './rerank.js';

function c(id: string, title: string, description?: string, score = 0): Candidate {
  return { product: { id, title, description, price: 0, currency: 'SAR', available: true }, score, source: 'fts' };
}

describe('expandQuery', () => {
  it('expands English synonym group', () => {
    const terms = expandQuery('t-shirt');
    expect(terms).toContain('tee');
    expect(terms).toContain('قميص');
    expect(terms).toContain('tshirt');
  });

  it('expands Arabic variant via group', () => {
    const terms = expandQuery('قميص');
    expect(terms).toContain('tee');
    expect(terms).toContain('shirt');
  });

  it('expands multi-word query by containment', () => {
    const terms = expandQuery('black shirt');
    expect(terms).toContain('أسود');
    expect(terms).toContain('قميص');
    expect(terms).toContain('tee');
  });

  it('returns token verbatim when no group matches', () => {
    const terms = expandQuery('widget');
    expect(terms).toContain('widget');
  });
});

describe('scoreCandidate', () => {
  it('weights title matches higher', () => {
    const terms = ['black', 'أسود', 'قميص'];
    const titleScore = scoreCandidate(terms, 'قميص قطن أسود', '');
    const descScore = scoreCandidate(terms, 'قميص قطني', 'أسود');
    expect(titleScore).toBeGreaterThan(descScore);
  });

  it('returns 0 when no terms match', () => {
    expect(scoreCandidate(['zzz'], 'something', 'else')).toBe(0);
  });
});

describe('lexicalReRank', () => {
  it('ranks Arabic product first for English synonym query', () => {
    const arabic = c('1', 'قميص قطن أسود', 'قميص قطني مريح');
    const tee = c('2', 'Webhook Tee', 'Premium cotton tee');
    const result = lexicalReRank('black shirt', [tee, arabic]);
    expect(result[0].product.id).toBe('1');
  });

  it('ranks tee first for paraphrase query', () => {
    const tee = c('1', 'Cotton Tee', '');
    const mug = c('2', 'Ceramic Mug', '');
    const result = lexicalReRank('cotton tee', [mug, tee]);
    expect(result[0].product.id).toBe('1');
  });

  it('returns empty for empty input', () => {
    expect(lexicalReRank('anything', [])).toEqual([]);
  });
});

describe('dedupeById', () => {
  it('keeps higher score on duplicate id', () => {
    const a = c('1', 'A', undefined, 3);
    const b = c('1', 'A', undefined, 5);
    const result = dedupeById([b, a]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(5);
  });
});
