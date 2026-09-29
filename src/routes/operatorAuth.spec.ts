import { describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'youssef@example.com';
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

/**
 * Supabase is stubbed rather than dialled. The point of these tests is the route's
 * behaviour around the provider's answer — uniform failure, the confirmation gate,
 * linking an unlinked invite — so the provider is the thing being varied, not a
 * network. `signInWithPassword` is the only call the login path makes.
 */
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

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Youssef',
  email: EMAIL,
  status: 'active',
  supabaseUid: 'uid-youssef',
};

const repos = vi.hoisted(() => ({
  byEmail: new Map<string, any>(),
  byUid: new Map<string, any>(),
  /** The same two indexes, on the client side — the split this route has to notice. */
  clientByEmail: new Map<string, any>(),
  clientByUid: new Map<string, any>(),
  linked: [] as Array<{ id: string; uid: string }>,
  clientLinked: [] as Array<{ id: string; uid: string }>,
  throwOnRead: false,
}));

vi.mock('../db/repos.js', () => ({
  operatorRepo: {
    findByEmail: async (email: string) => {
      if (repos.throwOnRead) throw new Error('db down');
      return repos.byEmail.get(email.toLowerCase()) ?? null;
    },
    getBySupabaseUid: async (uid: string) => {
      if (repos.throwOnRead) throw new Error('db down');
      return repos.byUid.get(uid) ?? null;
    },
    setSupabaseUid: async (id: string, uid: string) => {
      repos.linked.push({ id, uid });
      return true;
    },
  },
  clientRepo: {
    findByEmail: async (email: string) => {
      if (repos.throwOnRead) throw new Error('db down');
      return repos.clientByEmail.get(email.toLowerCase()) ?? null;
    },
    getBySupabaseUid: async (uid: string) => {
      if (repos.throwOnRead) throw new Error('db down');
      return repos.clientByUid.get(uid) ?? null;
    },
    setSupabaseUid: async (id: string, uid: string) => {
      repos.clientLinked.push({ id, uid });
      return true;
    },
  },
}));

const ORIGINAL_ENV = { ...process.env };

async function buildApp() {
  vi.resetModules();
  fake = createFakeRedis();
  down = false;
  supabase.configured = true;
  supabase.throwOnSignIn = false;
  supabase.signIn.mockReset();
  repos.byEmail.clear();
  repos.byUid.clear();
  repos.clientByEmail.clear();
  repos.clientByUid.clear();
  repos.linked.length = 0;
  repos.clientLinked.length = 0;
  repos.throwOnRead = false;

  const { operatorAuth } = await import('./operatorAuth.js');
  const { installErrorHandler } = await import('../lib/errorHandler.js');
  const app = Fastify();
  installErrorHandler(app);
  await operatorAuth(app);
  return app;
}

/** A correct password for a confirmed Supabase user — the happy path's only stub. */
function signInSucceeds(uid = 'uid-youssef', email = EMAIL) {
  supabase.signIn.mockResolvedValue({
    data: { user: { id: uid, email, email_confirmed_at: '2026-01-01T00:00:00Z' } },
    error: null,
  });
}

function post(app: ReturnType<typeof Fastify>, payload: unknown, ip = IP) {
  return app.inject({ method: 'POST', url: '/api/auth/operator/login', payload, remoteAddress: ip });
}

function login(app: ReturnType<typeof Fastify>, ip = IP) {
  return post(app, { email: EMAIL, password: PASSWORD }, ip);
}

/** The default world: a real operator row linked to a working Supabase identity. */
function seedActiveOperator() {
  repos.byEmail.set(EMAIL, operator);
  repos.byUid.set(operator.supabaseUid, operator);
  signInSucceeds();
}

async function closeApp(app: ReturnType<typeof Fastify>) {
  await app.close();
  process.env = { ...ORIGINAL_ENV };
}

afterEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /api/auth/operator/login', () => {
  it('authenticates a confirmed operator and returns both epochs plus a sid', async () => {
    const app = await buildApp();
    seedActiveOperator();
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // `kind` is what the BFF writes its cookie from; it must not be left to the caller.
    expect(body.kind).toBe('operator');
    expect(body).toMatchObject({ ok: true, operatorId: operator.id, name: 'Youssef', email: EMAIL });
    expect(typeof body.sid).toBe('string');
    expect(body.sid.length).toBeGreaterThan(0);
    expect(typeof body.epoch).toBe('string');
    expect(typeof body.globalEpoch).toBe('string');
    expect(body.globalEpoch).not.toBe(body.epoch);
    expect(typeof body.expiresIn).toBe('number');
    await closeApp(app);
  });

  it('reuses a stable epoch across logins so a browser refresh keeps working', async () => {
    const app = await buildApp();
    seedActiveOperator();
    const first = (await login(app)).json();
    const second = (await login(app)).json();
    expect(second.epoch).toBe(first.epoch);
    expect(second.globalEpoch).toBe(first.globalEpoch);
    // A per-login sid, though: that is what makes one device revocable on its own.
    expect(second.sid).not.toBe(first.sid);
    await closeApp(app);
  });

  it('rejects a wrong password with a uniform error', async () => {
    const app = await buildApp();
    seedActiveOperator();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'Invalid login credentials' } });
    const res = await post(app, { email: EMAIL, password: 'nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('gives the same answer for an address that is not an operator', async () => {
    // A valid Supabase user who administers nothing must be indistinguishable from a
    // wrong password: otherwise the endpoint enumerates which addresses hold admin
    // accounts, which is the more valuable of the two facts.
    const app = await buildApp();
    signInSucceeds('uid-stranger', 'stranger@example.com');
    const res = await post(app, { email: 'stranger@example.com', password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('gives the same answer for a suspended operator', async () => {
    const app = await buildApp();
    repos.byEmail.set(EMAIL, { ...operator, status: 'suspended' });
    repos.byUid.set(operator.supabaseUid, { ...operator, status: 'suspended' });
    signInSucceeds();
    const res = await login(app);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('refuses an identity linked to both an operator and a client', async () => {
    // Per-table unique indexes make this representable, so it has to be caught here:
    // letting it through would hand the operator surface to whoever holds the shared
    // identity, and would make one person able to sign in on both sides.
    const app = await buildApp();
    seedActiveOperator();
    repos.clientByUid.set(operator.supabaseUid, { id: 'client-1', email: EMAIL, status: 'active' });
    signInSucceeds();
    const res = await login(app);
    expect(res.statusCode).toBe(401);
    // Indistinguishable from a wrong password: the refusal must not confirm that either
    // account exists.
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('refuses to link an operator whose address a client already holds', async () => {
    const app = await buildApp();
    repos.byEmail.set(EMAIL, { ...operator, supabaseUid: null });
    repos.clientByEmail.set(EMAIL, { id: 'client-1', email: EMAIL, status: 'active' });
    signInSucceeds();
    const res = await login(app);
    expect(res.statusCode).toBe(401);
    expect(repos.linked).toHaveLength(0);
    await closeApp(app);
  });

  it('treats an unconfirmed signup exactly like a wrong password', async () => {
    // The confirmation gate doubles as the bad-credential bucket, so a caller cannot
    // tell "you have not confirmed your email" from "that password is wrong".
    const app = await buildApp();
    seedActiveOperator();
    supabase.signIn.mockResolvedValue({
      data: { user: { id: operator.supabaseUid, email: EMAIL, email_confirmed_at: null } },
      error: null,
    });
    const res = await login(app);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    await closeApp(app);
  });

  it('links an invite whose supabase_uid was never written', async () => {
    // The row predates the identity being recorded. The credential has just proved the
    // address, so binding it here is safe — and it is the only place a row is linked.
    const app = await buildApp();
    repos.byEmail.set(EMAIL, { ...operator, supabaseUid: null });
    signInSucceeds();
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    expect(repos.linked).toEqual([{ id: operator.id, uid: 'uid-youssef' }]);
    await closeApp(app);
  });

  it('rejects an identity already bound to a different operator', async () => {
    // The uid is the authority. A Supabase identity that resolves to somebody else
    // must not be adopted by row lookup.
    const app = await buildApp();
    repos.byUid.set('uid-youssef', { ...operator, id: 'someone-else', email: EMAIL });
    repos.byEmail.set(EMAIL, { ...operator, supabaseUid: null });
    signInSucceeds();
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    // The row reached is the uid's own, not the email's.
    expect(res.json().operatorId).toBe('someone-else');
    expect(repos.linked).toEqual([]);
    await closeApp(app);
  });

  it('returns 503 when Supabase is not configured', async () => {
    const app = await buildApp();
    supabase.configured = false;
    const res = await login(app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });

  it('returns 503 when Supabase throws rather than leaking the provider error', async () => {
    const app = await buildApp();
    supabase.throwOnSignIn = true;
    const res = await login(app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });

  it('returns 503 when the operator lookup fails', async () => {
    const app = await buildApp();
    signInSucceeds();
    repos.throwOnRead = true;
    const res = await login(app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });

  it('validates the request body', async () => {
    const app = await buildApp();
    for (const payload of [{}, { email: EMAIL }, { password: PASSWORD }, { email: '', password: PASSWORD }]) {
      expect((await post(app, payload)).statusCode).toBe(400);
    }
    await closeApp(app);
  });

  it('rejects an over-long password before consulting Supabase or the counter', async () => {
    // Validation must not depend on anything else being up: a bad request is a 400
    // whether or not Supabase or Redis are reachable, or an outage would mask a typo.
    const app = await buildApp();
    const res = await post(app, { email: EMAIL, password: 'a'.repeat(2000) });
    expect(res.statusCode).toBe(400);
    expect(supabase.signIn).not.toHaveBeenCalled();
    await closeApp(app);
  });
});

describe('login lockout', () => {
  it('locks the IP out on the fifth consecutive failure', async () => {
    const app = await buildApp();
    seedActiveOperator();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    for (let i = 0; i < 4; i++) {
      expect((await post(app, { email: EMAIL, password: 'nope' })).statusCode).toBe(401);
    }
    const fifth = await post(app, { email: EMAIL, password: 'nope' });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.headers['retry-after']).toBe('30');
    await closeApp(app);
  });

  it('refuses even the correct password while locked out', async () => {
    const app = await buildApp();
    seedActiveOperator();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    for (let i = 0; i < 5; i++) await post(app, { email: EMAIL, password: 'nope' });
    signInSucceeds();
    const res = await login(app);
    expect(res.statusCode).toBe(429);
    await closeApp(app);
  });

  it('counts attempts per IP, not globally', async () => {
    const app = await buildApp();
    seedActiveOperator();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    for (let i = 0; i < 5; i++) await post(app, { email: EMAIL, password: 'nope' }, IP);
    expect((await post(app, { email: EMAIL, password: 'nope' }, IP)).statusCode).toBe(429);
    // A different account from a different address: the email bucket is deliberately
    // per-account and does not travel with the IP, so this is not a continuation of
    // the same locked bucket — a distinct address guessing a distinct account is only
    // stopped by that account's own counter.
    signInSucceeds('uid-other', 'other@example.com');
    repos.byUid.set('uid-other', { ...operator, id: 'other-id', email: 'other@example.com' });
    expect((await post(app, { email: 'other@example.com', password: PASSWORD }, '5.6.7.8')).statusCode).toBe(200);
    await closeApp(app);
  });

  it('locks a targeted account across every address that guesses it', async () => {
    // The mirror of the case above, and the reason there are two buckets: an attacker
    // who rotates source addresses must still be throttled on the account itself.
    const app = await buildApp();
    seedActiveOperator();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    for (let i = 0; i < 5; i++) await post(app, { email: EMAIL, password: 'nope' }, `10.0.0.${i + 1}`);
    signInSucceeds();
    expect((await login(app, '203.0.113.9')).statusCode).toBe(429);
    await closeApp(app);
  });

  it('escalates the lockout on each failure after the lock lapses', async () => {
    const app = await buildApp();
    seedActiveOperator();
    supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    const fail = () => post(app, { email: EMAIL, password: 'nope' });

    for (let i = 0; i < 5; i++) await fail();
    expect((await fail()).headers['retry-after']).toBe('30');

    fake.advance(30_000);
    expect((await fail()).headers['retry-after']).toBe('60');

    fake.advance(60_000);
    expect((await fail()).headers['retry-after']).toBe('120');
    await closeApp(app);
  });

  it('clears the failure history after a successful login', async () => {
    const app = await buildApp();
    seedActiveOperator();
    const rejects = () =>
      supabase.signIn.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } });
    rejects();
    const fail = () => post(app, { email: EMAIL, password: 'nope' });

    for (let i = 0; i < 4; i++) expect((await fail()).statusCode).toBe(401);
    signInSucceeds();
    expect((await login(app)).statusCode).toBe(200);

    // A success clears the history, so the next four failures are 401s again rather
    // than inheriting the earlier four and tripping a lock.
    rejects();
    for (let i = 0; i < 4; i++) expect((await fail()).statusCode).toBe(401);
    signInSucceeds();
    expect((await login(app)).statusCode).toBe(200);
    await closeApp(app);
  });

  it('fails closed when Redis is unavailable so an outage is not unlimited login attempts', async () => {
    const app = await buildApp();
    seedActiveOperator();
    down = true;
    const res = await login(app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
    await closeApp(app);
  });
});
