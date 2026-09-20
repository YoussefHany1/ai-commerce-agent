import { describe, expect, it } from 'vitest';
import { checkLimit, rateError, storeKeyFrom } from '../lib/rateLimit.js';

describe('checkLimit', () => {
  it('allows usage up to the limit and reports remaining', () => {
    expect(checkLimit(5, 10, 60)).toMatchObject({ exceeded: false, remaining: 5, retryAfterSec: 60 });
    expect(checkLimit(10, 10, 60)).toMatchObject({ exceeded: false, remaining: 0 });
  });

  it('flags exceeded usage', () => {
    const r = checkLimit(11, 10, 60);
    expect(r.exceeded).toBe(true);
    expect(r.remaining).toBe(0);
  });
});

describe('rateError', () => {
  it('builds a 429 with a retry-after header', () => {
    const err = rateError('rate_limit_exceeded', 60);
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe('rate_limit_exceeded');
    expect(err.headers).toEqual({ 'retry-after': '60' });
  });
});

describe('storeKeyFrom', () => {
  it('reads storeId from body or params', () => {
    expect(storeKeyFrom({ body: { storeId: 'store-a' } })).toBe('store-a');
    expect(storeKeyFrom({ params: { storeId: 'store-b' } })).toBe('store-b');
    expect(storeKeyFrom({})).toBe('');
  });
});