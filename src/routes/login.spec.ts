import { describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'youssef@example.com';
const IP = '1.2.3.4';

/**
 * The single sign-in route.
 *
 * Two things matter more than the rest: that the kind is decided by the verified
 * credential and not by anything the caller sent, and that every failure — unknown
 * account, wrong password, unconfirmed signup, suspension, or an identity linked on both
 * sides — is the same 401. The route is the only place both principals authenticate, so
 * a difference between one failure and another is a difference an attacker can read.
 *
 * The resolver is stubbed: it is the exchange's collaborator and is exercised there. What
 * is under test here is the route's behaviour around it — the legacy scrypt branch, the
 * confirmation gate, the lockout buckets, and the session it mints per kind.
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

const supabase = vi.hoisted(() => ({
  configured: true,
  signIn: vi.fn(),
  throwOnSignIn: false,
}));

vi.mock('../lib/supabase.js', () => ({
  supabaseAnon: () =>
    supabase.configured
      ? {
          auth: {
            signInWithPassword: async (args: unknown) => {
              if (supabase.throwOnSignIn) throw new Error('supabase down');
              return supabase.signIn(args);
            },
          },
        }
      : null,
  supabaseAdmin: () => null,
  findSupabaseUserByEmail: async () => null,
}));

/**
 * The resolver is replaced, but the client lookup the legacy branch needs is real enough
 * to vary: it is how a pre-Supabase password is found, and how the route decides not to
 * make a provider call.
 */
const clientLookup = vi.hoisted(() => ({ byEmail: vi.fn<(...args: any[]) => Promise<any>>(async () => null) }));

vi.mock('../db/repos.js', () => ({
  clientRepo: {
    findByEmail: (...args: unknown[]) => clientLookup.byEmail(...args),
    setSupabaseUid: async () => true,
  },
  operatorRepo: {
    findByEmail: async () => null,
    getBySupabaseUid: async () => null,
    setSupabaseUid: async () => true,
  },
}));

const resolver = vi.hoisted(() => ({ resolve: vi.fn<(...args: any[]) => Promise<any>>() }));

vi.mock('../lib/localIdentity.js', () => ({
  resolveSupabaseIdentity: (...args: unknown[]) => resolver.resolve(...args),
}));

const ORIGINAL_ENV = { ...process.env };

async function buildApp() {
  vi.resetModules();
  fake = createFakeRedis();
  down = false;
  supabase.configured = true;
  supabase.throwOnSignIn = false;
  supabase.signIn.mockReset();
  clientLookup.byEmail.mockReset();
  clientLookup.byEmail.mockResolvedValue(null);
  resolver.resolve.mockReset();
  resolver.resolve.mockResolvedValue({ status: 'none' });

  const { login } = await import('./login.js');
  const { installErrorHandler } = await import('../lib/errorHandler.js');
  const app = Fastify();
  installErrorHandler(app);
  await login(app);
  return app;
}

function post(app: ReturnType<typeof Fastify>, payload: unknown, ip = IP) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload, remoteAddress: ip });
}

function signInSucceeds(uid = 'uid-youssef', email = EMAIL) {
  supabase.signIn.mockResolvedValue({
    data: { user: { id: uid, email, email_confirmed_at: '2026-01-01T00:00:00Z' } },
    error: null,
  });
}

function resolveAs(identity: { kind: 'operator' | 'client'; id: string; name: string; email: string }) {
  resolver.resolve.mockResolvedValue({ status: 'ok', identity });
}

async function closeApp(app: ReturnType<typeof Fastify>) {
  await app.close();
  process.env = { ...ORIGINAL_ENV };
}

afterEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/auth/login: kind detection', () => {
  it('mints an operator session when the identity resolves to an operator', async () => {
    const app = await buildApp();
    signInSucceeds();
    resolveAs({ kind: 'operator', id: 'op-1', name: 'Youssef', email: EMAIL });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // `kind` is what the BFF writes its cookie from; the caller never supplies it.
    expect(body).toMatchObject({ ok: true, kind: 'operator', operatorId: 'op-1' });
    expect(typeof body.sid).toBe('string');
    expect(typeof body.epoch).toBe('string');
    expect(typeof body.globalEpoch).toBe('string');
    // The resolver is told to bind an unlinked operator by the address just proved.
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'uid-youssef', email: EMAIL, linkOperatorByEmail: true, autoProvision: false }),
    );
    await closeApp(app);
  });

  it('mints a client session when the identity resolves to a client', async () => {
    const app = await buildApp();
    signInSucceeds();
    resolveAs({ kind: 'client', id: 'c-1', name: 'Ace', email: 'owner@ace.com' });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, kind: 'client', clientId: 'c-1' });
    // No global epoch reaches a client: the install-wide revocation is an operator idea.
    expect(body.globalEpoch).toBeUndefined();
    await closeApp(app);
  });

  it('verifies a legacy scrypt client locally without calling Supabase', async () => {
    // A merchant imported before Supabase managed their credential. The provider has no
    // password to check, so the local hash is the authority and no provider call is made.
    const app = await buildApp();
    const { hashPassword } = await import('../lib/passwordHash.js');
    clientLookup.byEmail.mockResolvedValue({
      id: 'c-legacy',
      name: 'Legacy',
      email: EMAIL,
      status: 'active',
      passwordHash: await hashPassword(PASSWORD),
      supabaseUid: null,
    });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'client', clientId: 'c-legacy' });
    expect(supabase.signIn).not.toHaveBeenCalled();
    await closeApp(app);
  });

  it('refuses a legacy client whose password is wrong with the uniform error', async () => {
    const app = await buildApp();
    const { hashPassword } = await import('../lib/passwordHash.js');
    clientLookup.byEmail.mockResolvedValue({
      id: 'c-legacy',
      name: 'Legacy',
      email: EMAIL,
      status: 'active',
      passwordHash: await hashPassword('a different password'),
      supabaseUid: null,
    });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    // A row that still has a hash is verified locally, so a wrong password is refused
    // here and the provider is never asked — the two credentials do not stack.
    expect(supabase.signIn).not.toHaveBeenCalled();
    await closeApp(app);
  });

  it('refuses an identity linked to both an operator and a client', async () => {
    const app = await buildApp();
    signInSucceeds();
    resolver.resolve.mockResolvedValue({ status: 'conflict', operatorId: 'op-1', clientId: 'c-1' });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });
});

describe('POST /api/auth/login: uniform failure', () => {
  it('rejects a wrong password with the uniform error', async () => {
    const app = await buildApp();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid login credentials' } });
    const res = await post(app, { email: EMAIL, password: 'nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('treats an unconfirmed signup exactly like a wrong password', async () => {
    const app = await buildApp();
    supabase.signIn.mockResolvedValue({
      data: { user: { id: 'uid-1', email: EMAIL, email_confirmed_at: null } },
      error: null,
    });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    // The resolver is never reached: the gate is upstream of it.
    expect(resolver.resolve).not.toHaveBeenCalled();
    await closeApp(app);
  });

  it('gives the same answer when the verified identity resolves to nothing', async () => {
    // A valid Supabase user who administers nothing and is not a merchant — an ordinary
    // visitor with an account. Indistinguishable from a wrong password, as it must be.
    const app = await buildApp();
    signInSucceeds('uid-stranger', 'stranger@example.com');
    resolver.resolve.mockResolvedValue({ status: 'none' });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('gives the same answer for a suspended operator', async () => {
    const app = await buildApp();
    signInSucceeds();
    resolver.resolve.mockResolvedValue({ status: 'none' });
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(401);
    await closeApp(app);
  });
});

describe('POST /api/auth/login: availability and validation', () => {
  it('returns 503 when Supabase is not configured and there is no legacy row', async () => {
    const app = await buildApp();
    supabase.configured = false;
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });

  it('returns 503 when Supabase throws rather than leaking the provider error', async () => {
    const app = await buildApp();
    supabase.throwOnSignIn = true;
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });

  it('fails closed when Redis is unavailable so an outage is not unlimited attempts', async () => {
    const app = await buildApp();
    down = true;
    const res = await post(app, { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });

  it('validates the body before touching the provider or the counter', async () => {
    const app = await buildApp();
    for (const payload of [{}, { email: EMAIL }, { password: PASSWORD }, { email: '', password: PASSWORD }]) {
      expect((await post(app, payload)).statusCode).toBe(400);
    }
    const overLong = await post(app, { email: EMAIL, password: 'a'.repeat(2000) });
    expect(overLong.statusCode).toBe(400);
    expect(supabase.signIn).not.toHaveBeenCalled();
    await closeApp(app);
  });
});

describe('POST /api/auth/login: lockout', () => {
  it('locks the IP out on the fifth consecutive failure', async () => {
    const app = await buildApp();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    for (let i = 0; i < 4; i++) {
      expect((await post(app, { email: EMAIL, password: 'nope' })).statusCode).toBe(401);
    }
    const fifth = await post(app, { email: EMAIL, password: 'nope' });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.headers['retry-after']).toBe('30');
    await closeApp(app);
  });

  it('clears the failure history after a successful login', async () => {
    const app = await buildApp();
    const rejects = () =>
      supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    const fail = () => post(app, { email: EMAIL, password: 'nope' });

    rejects();
    for (let i = 0; i < 4; i++) expect((await fail()).statusCode).toBe(401);
    signInSucceeds();
    resolveAs({ kind: 'operator', id: 'op-1', name: 'Youssef', email: EMAIL });
    expect((await post(app, { email: EMAIL, password: PASSWORD })).statusCode).toBe(200);

    rejects();
    for (let i = 0; i < 4; i++) expect((await fail()).statusCode).toBe(401);
    await closeApp(app);
  });
});
