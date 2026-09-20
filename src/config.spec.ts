import { test, expect, describe, vi } from 'vitest';

vi.mock('../integrations/shopify.js', () => ({
  ShopifyAdapter: class {},
}));
vi.mock('../db/repos.js', () => ({}));
vi.mock('../lib/health.js', () => ({
  dbPing: async () => true,
  redisPing: async () => true,
  rlsPing: async () => true,
}));

describe('config', () => {
  test('provides defaults', async () => {
    vi.resetModules();
    process.env.ENCRYPTION_KEY_VERSION = 'v1';
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { config } = await import('./config.js');
    expect(config.PORT).toBe(3000);
    expect(config.ENCRYPTION_KEY_VERSION).toBe('v1');
  });
});

describe('mock adapter', () => {
  test('searches by title substring', async () => {
    const { MockAdapter } = await import('./integrations/mock.js');
    const adapter = new MockAdapter('salla', [
      { id: '1', title: 'Face Serum', price: 50, currency: 'SAR', available: true },
      { id: '2', title: 'Body Lotion', price: 30, currency: 'SAR', available: true },
    ]);
    const results = await adapter.searchProducts('face');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Face Serum');
  });
});

describe('agent fallback', () => {
  test('returns formatted product list when no LLM provider key is present', async () => {
    const orig = process.env.OPENAI_API_KEY;
    const origOr = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    vi.resetModules();
    const { answer } = await import('./services/agent.js');
    const res = await answer('test', [
      { id: '1', title: 'Test Item', price: 10, currency: 'SAR', available: true, url: 'https://example.com' },
    ]);
    expect(res).toContain('Test Item');
    expect(res).toContain('10 SAR');
    if (orig) process.env.OPENAI_API_KEY = orig;
    if (origOr) process.env.OPENROUTER_API_KEY = origOr;
  });
});
