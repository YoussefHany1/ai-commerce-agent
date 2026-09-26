import { test, expect, describe, vi } from 'vitest';
import { loadConfig } from './config.js';

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
  const HEX = 'a'.repeat(64);

  // loadConfig takes the env explicitly, so these cases need no module reset.
  const base = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ENCRYPTION_KEY: HEX,
    ENCRYPTION_KEY_VERSION: 'v1',
    ...over,
  });

  test('provides defaults', async () => {
    vi.resetModules();
    process.env.ENCRYPTION_KEY_VERSION = 'v1';
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { config } = await import('./config.js');
    expect(config.PORT).toBe(3000);
    expect(config.ENCRYPTION_KEY_VERSION).toBe('v1');
  });

  test('rejects a non-hex ENCRYPTION_KEY at boot', () => {
    expect(() => loadConfig(base({ ENCRYPTION_KEY: 'z'.repeat(64) }))).toThrow(/64 hex characters/);
  });

  test('rejects a wrong-length ENCRYPTION_KEY at boot', () => {
    expect(() => loadConfig(base({ ENCRYPTION_KEY: 'a'.repeat(32) }))).toThrow(/64 hex characters/);
  });

  test('rejects a non-hex rotation key too', () => {
    expect(() =>
      loadConfig(base({ ENCRYPTION_KEY_VERSION: 'v2', ENCRYPTION_KEY_v2: 'x'.repeat(64) })),
    ).toThrow(/version v2/);
  });

  test('accepts uppercase hex and a valid rotation set', () => {
    // ENCRYPTION_KEY is always filed under the active version, so it and
    // ENCRYPTION_KEY_v2 both land in keys.v2 — the latter wins.
    const cfg = loadConfig(
      base({ ENCRYPTION_KEY: HEX.toUpperCase(), ENCRYPTION_KEY_VERSION: 'v2', ENCRYPTION_KEY_v2: HEX }),
    );
    expect(cfg.encryption.version).toBe('v2');
    expect(cfg.encryption.keys.v2).toBe(HEX);
  });

  test('keeps the superseded key readable so rotation can decrypt old rows', () => {
    const cfg = loadConfig(
      base({ ENCRYPTION_KEY: HEX, ENCRYPTION_KEY_VERSION: 'v2', ENCRYPTION_KEY_v1: 'b'.repeat(64) }),
    );
    expect(cfg.encryption.version).toBe('v2');
    expect(cfg.encryption.keys.v1).toBe('b'.repeat(64));
  });

  test('production still requires a key to be present at all', () => {
    expect(() =>
      loadConfig({ ...base(), ENCRYPTION_KEY: '', NODE_ENV: 'production', ADMIN_API_KEY: 'k'.repeat(32) }),
    ).toThrow(/ENCRYPTION_KEY is required in production/);
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
