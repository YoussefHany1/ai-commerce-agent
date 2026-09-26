import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { hashOperatorPassword } from '../lib/passwordHash.js';

const PASSWORD = 'correct horse battery staple';
const PREVIOUS = 'previous operator password';
const IP = '1.2.3.4';

/**
 * Fake Redis with a virtual clock, so lockout escalation and expiry can be
 * asserted without waiting on wall time.
 */
function createFakeRedis() {
  const clock = { t: 0 };
  const store = new Map<string, { value: string; expAt: number | null }>();

  const alive = (k: string) => {
    const entry = store.get(k);
    if (!entry) return null;
    if (entry.expAt !== null && entry.expAt <= clock.t) {
      store.delete(k);
      return null;
    }
    return entry;
  };

  const client = {
    get: async (k: string) => alive(k)?.value ?? null,
    set: async (k: string, v: string, opts?: { EX?: number; PX?: number; NX?: boolean }) => {
      if (opts?.NX && alive(k)) return null;
      const expAt =
        opts?.PX !== undefined ? clock.t + opts.PX : opts?.EX !== undefined ? clock.t + opts.EX * 1000 : null;
      store.set(k, { value: v, expAt });
      return 'OK';
    },
    incr: async (k: string) => {
      const cur = alive(k);
      const next = (cur ? Number(cur.value) : 0) + 1;
      store.set(k, { value: String(next), expAt: cur ? cur.expAt : null });
      return next;
    },
    expire: async (k: string, sec: number) => {
      const cur = alive(k);
      if (!cur) return 0;
      cur.expAt = clock.t + sec * 1000;
      return 1;
    },
    pTTL: async (k: string) => {
      const cur = alive(k);
      if (!cur) return -2;
      return cur.expAt === null ? -1 : cur.expAt - clock.t;
    },
    del: async (...args: Array<string | string[]>) => {
      let n = 0;
      for (const arg of args) {
        if (Array.isArray(arg)) {
          for (const k of arg) if (store.delete(k)) n++;
        } else if (store.delete(arg)) {
          n++;
        }
      }
      return n;
    },
  };

  return { clock, store, client, advance: (ms: number) => void (clock.t += ms) };
}

let fake = createFakeRedis();
let down = false;

vi.mock('../lib/redis.js', () => ({
  getRedis: async () => {
    if (down) throw new Error('redis unavailable');
    return fake.client;
  },
}));

const ORIGINAL_ENV = { ...process.env };

async function buildApp(env: Record<string, string | undefined>) {
  vi.resetModules();
  fake = createFakeRedis();
  down = false;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { operatorAuth } = await import('./operatorAuth.js');
  const { installErrorHandler } = await import('../lib/errorHandler.js');
  const app = Fastify();
  installErrorHandler(app);
  await operatorAuth(app);
  return app;
}

function post(app: ReturnType<typeof Fastify>, password: unknown, ip = IP) {
  return app.inject({ method: 'POST', url: '/api/auth/operator/verify', payload: { password }, remoteAddress: ip });
}

async function closeApp(app: ReturnType<typeof Fastify>) {
  await app.close();
  process.env = { ...ORIGINAL_ENV };
}

let HASH = '';
let PREV_HASH = '';

beforeEach(async () => {
  HASH = await hashOperatorPassword(PASSWORD);
  PREV_HASH = await hashOperatorPassword(PREVIOUS);
});

afterEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/auth/operator/verify', () => {
  it('accepts the configured password and returns a session epoch', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    const res = await post(app, PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(typeof res.json().epoch).toBe('string');
    expect(res.json().epoch.length).toBeGreaterThan(0);
    await closeApp(app);
  });

  it('reuses a stable epoch across logins', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    const first = (await post(app, PASSWORD)).json().epoch;
    const second = (await post(app, PASSWORD)).json().epoch;
    expect(second).toBe(first);
    await closeApp(app);
  });

  it('rejects a wrong password with a uniform error', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    const res = await post(app, 'nope');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('does not reveal whether the stored hash is configured via the 401 body', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    const wrong = await post(app, 'nope');
    await closeApp(app);

    const noHash = await buildApp({ OPERATOR_PASSWORD_HASH: undefined });
    const unconfigured = await noHash.inject({
      method: 'POST',
      url: '/api/auth/operator/verify',
      payload: { password: 'nope' },
      remoteAddress: IP,
    });
    expect(unconfigured.statusCode).toBe(503);
    expect(unconfigured.json().error).not.toBe(wrong.json().error);
  });

  it('accepts the previous password during a rotation window', async () => {
    const app = await buildApp({
      OPERATOR_PASSWORD_HASH: HASH,
      OPERATOR_PASSWORD_HASH_PREVIOUS: PREV_HASH,
    });
    expect((await post(app, PREVIOUS)).statusCode).toBe(200);
    expect((await post(app, PASSWORD)).statusCode).toBe(200);
    await closeApp(app);
  });

  it('ignores a previous hash that is not set', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH, OPERATOR_PASSWORD_HASH_PREVIOUS: undefined });
    expect((await post(app, PREVIOUS)).statusCode).toBe(401);
    await closeApp(app);
  });

  it('returns 503 when no password hash is configured', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: undefined });
    const res = await post(app, PASSWORD);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_not_configured' });
    await closeApp(app);
  });

  it('validates the request body', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/operator/verify',
      payload: { password: '' },
      remoteAddress: IP,
    });
    expect(res.statusCode).toBe(400);
    await closeApp(app);
  });

  it('rejects an over-long password before consulting the attempt counter', async () => {
    // Validation must not depend on Redis: a bad request is a 400 whether or not the
    // session store is up, otherwise an outage would mask caller errors as 503s and
    // a caller could never tell a typo from an outage.
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/operator/verify',
      payload: { password: 'a'.repeat(2000) },
      remoteAddress: IP,
    });
    expect(res.statusCode).toBe(400);
    await closeApp(app);
  });
});

describe('login lockout', () => {
  it('locks the IP out on the fifth consecutive failure', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    for (let i = 0; i < 4; i++) {
      expect((await post(app, 'nope')).statusCode).toBe(401);
    }
    const fifth = await post(app, 'nope');
    expect(fifth.statusCode).toBe(429);
    expect(fifth.headers['retry-after']).toBe('30');
    await closeApp(app);
  });

  it('refuses even the correct password while locked out', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    for (let i = 0; i < 5; i++) await post(app, 'nope');
    const res = await post(app, PASSWORD);
    expect(res.statusCode).toBe(429);
    await closeApp(app);
  });

  it('counts attempts per IP, not globally', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    for (let i = 0; i < 5; i++) await post(app, 'nope', IP);
    expect((await post(app, 'nope', IP)).statusCode).toBe(429);
    expect((await post(app, PASSWORD, '5.6.7.8')).statusCode).toBe(200);
    await closeApp(app);
  });

  it('escalates the lockout on each failure after the lock lapses', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    for (let i = 0; i < 5; i++) await post(app, 'nope');
    expect((await post(app, 'nope')).headers['retry-after']).toBe('30');

    fake.advance(30_000);
    expect((await post(app, 'nope')).headers['retry-after']).toBe('60');

    fake.advance(60_000);
    expect((await post(app, 'nope')).headers['retry-after']).toBe('120');
    await closeApp(app);
  });

  it('clears the failure history after a successful login', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    for (let i = 0; i < 4; i++) await post(app, 'nope');
    expect((await post(app, PASSWORD)).statusCode).toBe(200);

    for (let i = 0; i < 4; i++) {
      expect((await post(app, 'nope')).statusCode).toBe(401);
    }
    expect((await post(app, PASSWORD)).statusCode).toBe(200);
    await closeApp(app);
  });

  it('fails closed when Redis is unavailable so an outage is not unlimited login attempts', async () => {
    const app = await buildApp({ OPERATOR_PASSWORD_HASH: HASH });
    down = true;
    const res = await post(app, PASSWORD);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });
});
