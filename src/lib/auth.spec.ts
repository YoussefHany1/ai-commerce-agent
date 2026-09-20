import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const store = new Map<string, number>();

vi.mock('./redis.js', () => ({
  getRedis: vi.fn(async () => ({
    incr: async (k: string) => {
      const v = (store.get(k) ?? 0) + 1;
      store.set(k, v);
      return v;
    },
    expire: async () => 1,
    del: async (k: string) => store.delete(k),
  })),
}));

const ADMIN_KEY = '0123456789abcdef0123456789abcdef';

async function loadAuth(env: Record<string, string>, remove: string[] = []) {
  vi.resetModules();
  const saved = { ...process.env };
  for (const k of remove) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await import('./auth.js');
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

function req(ip: string, key?: string): FastifyRequest {
  const headers: Record<string, string | string[] | undefined> = {};
  if (key) headers['x-api-key'] = key;
  const socket = { remoteAddress: ip } as any;
  return { headers, socket } as FastifyRequest;
}

function reply() {
  const out: { code: number; body?: unknown } = { code: 0 };
  const r = {
    send: (body: unknown) => {
      out.body = body;
      return r;
    },
    code: (c: number) => {
      out.code = c;
      return r;
    },
    out,
  };
  return r as unknown as FastifyReply & { out: typeof out };
}

describe('requireApiKey', () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });
  afterEach(() => vi.resetModules());

  it('accepts a valid key and resets the brute-force counter', async () => {
    const { requireApiKey } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    store.set('rl:apikey:1.2.3.4', 29);
    const r = reply();
    await requireApiKey(req('1.2.3.4', ADMIN_KEY), r);
    expect(r.out.code).toBe(0);
    expect(store.has('rl:apikey:1.2.3.4')).toBe(false);
  });

  it('rejects a wrong key with 401', async () => {
    const { requireApiKey } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    const r = reply();
    await requireApiKey(req('1.2.3.4', 'wrong-key'), r);
    expect(r.out.code).toBe(401);
    expect(r.out.body).toMatchObject({ error: 'unauthorized' });
  });

  it('locks the IP out with 429 after the brute-force limit', async () => {
    const { requireApiKey } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    for (let i = 0; i < 30; i++) {
      const r = reply();
      await requireApiKey(req('9.9.9.9', 'wrong'), r);
      expect(r.out.code).toBe(401);
    }
    const locked = reply();
    await requireApiKey(req('9.9.9.9', 'wrong'), locked);
    expect(locked.out.code).toBe(429);
  });

  it('locks out a different IP independently', async () => {
    const { requireApiKey } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    for (let i = 0; i < 31; i++) {
      const r = reply();
      await requireApiKey(req('5.5.5.5', 'wrong'), r);
    }
    const ok = reply();
    await requireApiKey(req('5.5.5.6', ADMIN_KEY), ok);
    expect(ok.out.code).toBe(0);
  });

  it('returns 503 when no admin key is configured', async () => {
    const { requireApiKey } = await loadAuth({}, ['ADMIN_API_KEY']);
    const r = reply();
    await requireApiKey(req('1.1.1.1', ADMIN_KEY), r);
    expect(r.out.code).toBe(503);
  });
});