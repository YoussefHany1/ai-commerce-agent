import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const store = new Map<string, string>();

vi.mock('./redis.js', () => ({
  getRedis: vi.fn(async () => ({
    set: async (_k: string, v: string) => {
      store.set(_k, v);
    },
    get: async (k: string) => store.get(k) ?? null,
    del: async (k: string) => store.delete(k),
  })),
}));

async function loadSession(env: Record<string, string>) {
  vi.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await import('./session.js');
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe('customer sessions', () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });
  afterEach(() => vi.resetModules());

  it('mints an opaque token and retrieves the session', async () => {
    const { createSession: c, getSession: g } = await loadSession({});
    const token = await c({ storeId: 's1', customerId: null, conversationId: 'c1' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expect(g(token)).resolves.toEqual({ storeId: 's1', customerId: null, conversationId: 'c1' });
  });

  it('does not leak the raw token into redis (sha256-hashed key)', async () => {
    const { createSession: c } = await loadSession({});
    const token = await c({ storeId: 's1', customerId: null, conversationId: 'c1' });
    expect(store.has(`sess:${token}`)).toBe(false);
    expect([...store.keys()][0]).not.toContain(token);
  });

  it('looks up an unknown/garbage token as null', async () => {
    const { getSession: g } = await loadSession({});
    await expect(g('nope')).resolves.toBeNull();
    await expect(g(undefined)).resolves.toBeNull();
  });

  it('revokes a session', async () => {
    const { createSession: c, getSession: g, revokeSession: r } = await loadSession({});
    const token = await c({ storeId: 's1', customerId: 'cust-1', conversationId: 'c1' });
    expect(await g(token)).not.toBeNull();
    await r(token);
    await expect(g(token)).resolves.toBeNull();
  });
});