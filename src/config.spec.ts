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

  describe('production DATABASE_URL', () => {
    // Satisfies the other three production gates so each case below fails (or
    // passes) on DATABASE_URL alone.
    const prod = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      ...base(),
      NODE_ENV: 'production',
      ADMIN_API_KEY: 'k'.repeat(32),
      // Every human credential is Supabase's, so production cannot boot without them.
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      TRUST_PROXY: '1',
      ...over,
    });

    // The default is a superuser, which owns the tables and so ignores every
    // tenant policy while still passing a naive health check.
    test('refuses to boot on the default superuser connection', () => {
      expect(() => loadConfig(prod({ DATABASE_URL: '' }))).toThrow(
        /DATABASE_URL is required in production/,
      );
    });

    test('refuses to boot when DATABASE_URL is unset entirely', () => {
      expect(() => loadConfig(prod({ DATABASE_URL: undefined }))).toThrow(
        /DATABASE_URL is required in production/,
      );
    });

    test('accepts an explicitly configured runtime role', () => {
      const cfg = loadConfig(prod({ DATABASE_URL: 'postgres://agent_app:pw@db:5432/app' }));
      expect(cfg.DATABASE_URL).toBe('postgres://agent_app:pw@db:5432/app');
    });

    test('stays optional outside production so local compose and CI are unaffected', () => {
      expect(loadConfig(base()).DATABASE_URL).toBeTruthy();
    });
  });

  describe('production Supabase credentials', () => {
    const prod = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      ...base(),
      NODE_ENV: 'production',
      ADMIN_API_KEY: 'k'.repeat(32),
      DATABASE_URL: 'postgres://agent_app:pw@db:5432/app',
      TRUST_PROXY: '1',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_ANON_KEY: 'anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      ...over,
    });

    test('refuses to boot without them, since no credential could be verified', () => {
      expect(() => loadConfig(prod({ SUPABASE_URL: undefined }))).toThrow(
        /SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY/,
      );
      expect(() => loadConfig(prod({ SUPABASE_ANON_KEY: undefined }))).toThrow(
        /SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY/,
      );
      expect(() => loadConfig(prod({ SUPABASE_SERVICE_ROLE_KEY: undefined }))).toThrow(
        /SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY/,
      );
    });

    test('stays optional outside production so an all-local run still boots', () => {
      const cfg = loadConfig(base());
      expect(cfg.SUPABASE_URL).toBeUndefined();
    });
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
