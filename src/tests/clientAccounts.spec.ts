import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';

const ORIGINAL_ENV = { ...process.env };

const ADMIN_KEY = '0123456789abcdef0123456789abcdef';

beforeAll(() => {
  Object.assign(process.env, {
    ADMIN_API_KEY: ADMIN_KEY,
    CLIENT_SESSION_TTL_SECONDS: '3600',
  });
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

/**
 * In-memory Redis covering the operations the client session + auth layers use:
 * get/set (EX/NX/PX), del (scalar or array), incr, expire, pTTL, ping. TTLs are
 * not simulated — pTTL reports a live key, which is enough for the lock assertion.
 */
const redisStore = new Map<string, { value: string; ttl?: number }>();

const infra = {
  redis: {
    get: async (k: string) => redisStore.get(k)?.value ?? null,
    set: async (k: string, v: string, opts?: { EX?: number; NX?: boolean; PX?: number }) => {
      if (opts?.NX && redisStore.has(k)) return 'OK';
      redisStore.set(k, { value: v, ttl: opts?.PX ?? opts?.EX ?? undefined });
      return 'OK';
    },
    del: async (...keys: Array<string | string[]>) => {
      let n = 0;
      for (const key of keys.flat()) n += redisStore.delete(key) ? 1 : 0;
      return n;
    },
    incr: async (k: string) => {
      const cur = redisStore.get(k);
      const next = (cur ? Number(cur.value) : 0) + 1;
      redisStore.set(k, { value: String(next) });
      return next;
    },
    expire: async () => 1,
    pTTL: async (k: string) => {
      const entry = redisStore.get(k);
      return entry ? (entry.ttl ?? 1000) : -2;
    },
    ping: async () => 'PONG' as const,
  },
};

vi.mock('../lib/redis.js', () => ({ getRedis: async () => infra.redis }));
vi.mock('../db/client.js', () => ({
  withTenant: async (_storeId: string, fn: (tx: any) => Promise<unknown>) => fn({}),
  withOperator: async (fn: (tx: any) => Promise<unknown>) => fn({}),
}));

const mocks = vi.hoisted(() => {
  const clientRepo = {
    findByEmail: vi.fn(),
    get: vi.fn(),
    getForAuth: vi.fn(),
    getBySupabaseUid: vi.fn(),
    setSupabaseUid: vi.fn(async () => true),
    create: vi.fn(),
    setPassword: vi.fn(async (_id: string, _hash: string) => true),
    setStatus: vi.fn(async () => true),
    list: vi.fn(),
    storeCountsFor: vi.fn(async () => new Map()),
  };
  const storeRepo = {
    get: vi.fn(),
    belongsToClient: vi.fn(async () => true),
    assignClient: vi.fn(async () => {}),
    listForClient: vi.fn(async () => []),
  };
  const clientToPublic = vi.fn((c: any) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
  const storeToPublic = vi.fn((s: any) => s);
  const supabase = {
    anon: {
      auth: {
        signInWithPassword: vi.fn(),
        resetPasswordForEmail: vi.fn(),
        resend: vi.fn(),
      },
    },
    admin: {
      auth: {
        getUser: vi.fn(),
        admin: {
          createUser: vi.fn(),
          updateUserById: vi.fn(),
          generateLink: vi.fn(),
        },
      },
    },
    supabaseAnon: vi.fn(),
    supabaseAdmin: vi.fn(),
    findSupabaseUserByEmail: vi.fn(),
  };
  return { clientRepo, storeRepo, clientToPublic, storeToPublic, supabase };
});
vi.mock('../db/repos.js', () => ({ ...mocks }));
vi.mock('../lib/supabase.js', () => ({
  supabaseAnon: () => mocks.supabase.supabaseAnon(),
  supabaseAdmin: () => mocks.supabase.supabaseAdmin(),
  findSupabaseUserByEmail: (...args: unknown[]) => mocks.supabase.findSupabaseUserByEmail(...args),
}));

const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUPABASE_UID = '00000000-0000-4000-8000-000000000001';
const STORE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_STORE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW_CLIENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function clientRow(
  over: Partial<{ id: string; name: string; email: string; status: string; passwordHash: string | null; supabaseUid: string | null }> = {},
) {
  return {
    id: CLIENT_ID,
    name: 'Ace Widgets',
    email: 'owner@ace.com',
    status: 'active',
    passwordHash: '' as string | null,
    supabaseUid: null as string | null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

async function buildApp() {
  vi.resetModules();
  const { default: Fastify } = await import('fastify');
  const { clientAuth } = await import('../routes/clientAuth.js');
  const { clients } = await import('../routes/clients.js');
  const app = Fastify({ logger: false });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_error', issues: error.issues });
    }
    if (Number.isInteger(error.statusCode) && error.statusCode !== 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    reply.code(500).send({ error: 'internal_error' });
  });
  await clientAuth(app);
  await clients(app);
  return app;
}

type App = Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'correct-horse-battery';

let dbRow: ReturnType<typeof clientRow>;

/** Legacy-scrypt account: the pre-import path that still verifies locally. */
async function seedActiveClient(email = 'owner@ace.com') {
  const { hashPassword } = await import('../lib/passwordHash.js');
  dbRow = clientRow({ id: CLIENT_ID, email, passwordHash: await hashPassword(PASSWORD) });
  mocks.clientRepo.findByEmail.mockImplementation(async (e: string) =>
    e.toLowerCase() === dbRow.email.toLowerCase() ? dbRow : null,
  );
  mocks.clientRepo.get.mockImplementation(async () => dbRow);
  mocks.clientRepo.getForAuth.mockImplementation(async () => dbRow);
  mocks.clientRepo.setPassword.mockImplementation(async (_id: string, hash: string) => {
    dbRow.passwordHash = hash;
    return true;
  });
  return dbRow;
}

/** Supabase-managed account: hash is NULL, identity belongs to Supabase Auth. */
function seedSupabaseClient(email = 'owner@ace.com', uid = SUPABASE_UID) {
  dbRow = clientRow({ id: CLIENT_ID, email, passwordHash: null, supabaseUid: uid });
  mocks.clientRepo.findByEmail.mockImplementation(async (e: string) =>
    e.toLowerCase() === dbRow.email.toLowerCase() ? dbRow : null,
  );
  mocks.clientRepo.get.mockImplementation(async () => dbRow);
  mocks.clientRepo.getForAuth.mockImplementation(async () => dbRow);
  mocks.clientRepo.getBySupabaseUid.mockImplementation(async (u: string) => (u === uid ? dbRow : null));
  return dbRow;
}

function supabasePasswordOk(email = 'owner@ace.com', userId = SUPABASE_UID) {
  mocks.supabase.anon.auth.signInWithPassword.mockResolvedValue({
    data: { user: { id: userId, email, email_confirmed_at: new Date().toISOString() } },
    error: null,
  });
}

function supabasePasswordFail(message = 'Invalid login credentials') {
  mocks.supabase.anon.auth.signInWithPassword.mockResolvedValue({ data: null, error: new Error(message) });
}

/** Resets the supabase fakes to safe defaults; per-test setups override after. */
function defaultSupabaseMocks() {
  mocks.supabase.supabaseAnon.mockReturnValue(mocks.supabase.anon);
  mocks.supabase.supabaseAdmin.mockReturnValue(mocks.supabase.admin);
  mocks.supabase.findSupabaseUserByEmail.mockResolvedValue(null);
  mocks.supabase.anon.auth.signInWithPassword.mockResolvedValue({ data: null, error: new Error('no setup') });
  mocks.supabase.anon.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  mocks.supabase.anon.auth.resend.mockResolvedValue({ data: {}, error: null });
  mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({ data: null, error: new Error('no setup') });
  mocks.supabase.admin.auth.admin.updateUserById.mockResolvedValue({ data: { user: dbRow }, error: null });
  mocks.supabase.admin.auth.getUser.mockResolvedValue({ data: { user: null }, error: new Error('no setup') });
  mocks.supabase.admin.auth.admin.generateLink.mockResolvedValue({ data: null, error: new Error('no setup') });
}

function login(email: string, password: string) {
  return { method: 'POST' as const, url: '/api/auth/client/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email, password }) };
}

describe('client auth: login lockout', () => {
  let app: App;
  beforeEach(async () => {
    redisStore.clear();
    vi.clearAllMocks();
    defaultSupabaseMocks();
    app = await buildApp();
  });

  it('rejects a malformed body with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/client/login', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });

  it('returns a uniform 401 for an unknown email', async () => {
    const res = await app.inject(login('nobody@example.com', PASSWORD));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('returns 401 for a wrong password on an existing account', async () => {
    await seedActiveClient();
    const res = await app.inject(login('owner@ace.com', 'wrong-password'));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('keeps a suspended account indistinguishable from a bad credential', async () => {
    await seedActiveClient();
    mocks.clientRepo.findByEmail.mockResolvedValue(clientRow({ status: 'suspended', passwordHash: '' }));
    const res = await app.inject(login('owner@ace.com', 'anything'));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('locks an account after the fifth failure and keeps it locked for a good password', async () => {
    await seedActiveClient();
    for (let i = 0; i < 4; i++) {
      expect((await app.inject(login('owner@ace.com', 'wrong'))).statusCode).toBe(401);
    }
    const fifth = await app.inject(login('owner@ace.com', 'wrong'));
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ error: 'too_many_attempts' });
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThanOrEqual(30);

    const good = await app.inject(login('owner@ace.com', PASSWORD));
    expect(good.statusCode).toBe(429);
    expect(good.json()).toMatchObject({ error: 'too_many_attempts' });
  });

  it('issues a session with the sid and epoch on success', async () => {
    await seedActiveClient();
    const res = await app.inject(login('owner@ace.com', PASSWORD));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.name).toBe('Ace Widgets');
    expect(typeof body.sid).toBe('string');
    expect(typeof body.epoch).toBe('string');
    expect(body.expiresIn).toBe(3600);
    // Legacy accounts never touch Supabase.
    expect(mocks.supabase.anon.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.clientRepo.getForAuth).not.toHaveBeenCalled();
  });

  it('clears the failure counters after a successful login', async () => {
    await seedActiveClient();
    await app.inject(login('owner@ace.com', 'wrong'));
    await app.inject(login('owner@ace.com', 'wrong'));
    const ok = await app.inject(login('owner@ace.com', 'wrong')); // 3rd failure, no lock yet
    expect(ok.statusCode).toBe(401);
    const good = await app.inject(login('owner@ace.com', PASSWORD));
    expect(good.statusCode).toBe(200);
    // Lockout keys are gone after success; a subsequent good password is not throttled.
    for (const k of redisStore.keys()) expect(k).not.toMatch(/cli:login:/);
  });
});

describe('client auth: Supabase-managed login', () => {
  let app: App;
  beforeEach(async () => {
    redisStore.clear();
    vi.clearAllMocks();
    defaultSupabaseMocks();
    app = await buildApp();
  });

  it('verifies a Supabase account through signInWithPassword and mints a session', async () => {
    seedSupabaseClient();
    supabasePasswordOk();
    const res = await app.inject(login('owner@ace.com', PASSWORD));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.clientId).toBe(CLIENT_ID);
    expect(typeof body.sid).toBe('string');
    expect(mocks.supabase.anon.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'owner@ace.com',
      password: PASSWORD,
    });
  });

  it('treats a wrong Supabase password as a uniform 401', async () => {
    seedSupabaseClient();
    supabasePasswordFail();
    const res = await app.inject(login('owner@ace.com', PASSWORD));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('treats an unconfirmed Supabase signup as a uniform 401', async () => {
    seedSupabaseClient();
    mocks.supabase.anon.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: SUPABASE_UID, email: 'owner@ace.com', email_confirmed_at: null } },
      error: null,
    });
    const res = await app.inject(login('owner@ace.com', PASSWORD));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('fails closed with 503 when Supabase is not configured', async () => {
    seedSupabaseClient();
    mocks.supabase.supabaseAnon.mockReturnValue(null);
    const res = await app.inject(login('owner@ace.com', PASSWORD));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'auth_unavailable' });
  });
});

describe('client auth: register / forgot / reset-complete / exchange', () => {
  let app: App;
  beforeEach(async () => {
    redisStore.clear();
    vi.clearAllMocks();
    defaultSupabaseMocks();
    app = await buildApp();
  });

  function post(url: string, payload: unknown) {
    return { method: 'POST' as const, url, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) };
  }

  it('registers a client: creates the Supabase identity, then the account row', async () => {
    mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: SUPABASE_UID } },
      error: null,
    });
    mocks.clientRepo.create.mockResolvedValue(NEW_CLIENT_ID);
    const res = await app.inject(post('/api/auth/client/register', { name: 'New Co', email: 'new@ace.com', password: PASSWORD }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mocks.supabase.admin.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@ace.com', password: PASSWORD, email_confirm: false }),
    );
    expect(mocks.clientRepo.create).toHaveBeenCalledWith({
      name: 'New Co',
      email: 'new@ace.com',
      passwordHash: null,
      supabaseUid: SUPABASE_UID,
    });
  });

  it('reuses an existing identity and never leaks that the email is taken', async () => {
    mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('User already registered'), { code: 'user_already_exists' }),
    });
    mocks.supabase.findSupabaseUserByEmail.mockResolvedValue({ id: SUPABASE_UID } as never);
    mocks.supabase.anon.auth.resend.mockResolvedValue({ data: {}, error: null });
    const res = await app.inject(post('/api/auth/client/register', { name: 'Dup', email: 'taken@ace.com', password: PASSWORD }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mocks.supabase.anon.auth.resend).toHaveBeenCalled();
  });

  it('links an invited-but-unlinked account when a registration races it', async () => {
    mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: SUPABASE_UID } },
      error: null,
    });
    mocks.clientRepo.create.mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    mocks.clientRepo.findByEmail.mockResolvedValue(clientRow({ supabaseUid: null }));
    const res = await app.inject(post('/api/auth/client/register', { name: 'Dup', email: 'owner@ace.com', password: PASSWORD }));
    expect(res.statusCode).toBe(200);
    expect(mocks.clientRepo.setSupabaseUid).toHaveBeenCalledWith(CLIENT_ID, SUPABASE_UID);
  });

  it('registers fail closed when Supabase is unconfigured', async () => {
    mocks.supabase.supabaseAdmin.mockReturnValue(null);
    const res = await app.inject(post('/api/auth/client/register', { name: 'New', email: 'new@ace.com', password: PASSWORD }));
    expect(res.statusCode).toBe(503);
  });

  it('forgot always answers ok and hands the email to Supabase', async () => {
    mocks.clientRepo.findByEmail.mockResolvedValue(null);
    const res = await app.inject(post('/api/auth/client/forgot', { email: 'owner@ace.com' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mocks.supabase.anon.auth.resetPasswordForEmail).toHaveBeenCalledWith('owner@ace.com', {
      redirectTo: 'http://localhost:3000/login/reset',
    });
  });

  it('forgot fails closed when Supabase is unconfigured', async () => {
    mocks.supabase.supabaseAnon.mockReturnValue(null);
    const res = await app.inject(post('/api/auth/client/forgot', { email: 'owner@ace.com' }));
    expect(res.statusCode).toBe(503);
  });

  it('reset-complete bumps the epoch so pre-reset sessions die', async () => {
    seedSupabaseClient();
    mocks.supabase.admin.auth.getUser.mockResolvedValue({
      data: { user: { id: SUPABASE_UID, email: 'owner@ace.com' } },
      error: null,
    });
    await app.inject(login('owner@ace.com', 'x'.repeat(10)));
    const before = redisStore.get(`cli:sess:epoch:${CLIENT_ID}`);
    const res = await app.inject(post('/api/auth/client/reset-complete', { accessToken: 'jwt-1' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, clientId: CLIENT_ID });
    const after = redisStore.get(`cli:sess:epoch:${CLIENT_ID}`);
    expect(after?.value).toBeTruthy();
    expect(after?.value).not.toBe(before?.value);
    expect(mocks.supabase.admin.auth.getUser).toHaveBeenCalledWith('jwt-1');
  });

  it('exchange mints a session for a verified token', async () => {
    seedSupabaseClient();
    mocks.supabase.admin.auth.getUser.mockResolvedValue({
      data: { user: { id: SUPABASE_UID, email: 'owner@ace.com' } },
      error: null,
    });
    const res = await app.inject(post('/api/auth/client/exchange', { accessToken: 'jwt-google' }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.clientId).toBe(CLIENT_ID);
    expect(typeof body.sid).toBe('string');
  });

  it('exchange links a legacy account by email on first use', async () => {
    await seedActiveClient(); // passwordHash set, supabaseUid null
    mocks.supabase.admin.auth.getUser.mockResolvedValue({
      data: { user: { id: SUPABASE_UID, email: 'owner@ace.com' } },
      error: null,
    });
    mocks.clientRepo.getBySupabaseUid.mockResolvedValue(null);
    const res = await app.inject(post('/api/auth/client/exchange', { accessToken: 'jwt-1' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ clientId: CLIENT_ID });
    expect(mocks.clientRepo.setSupabaseUid).toHaveBeenCalledWith(CLIENT_ID, SUPABASE_UID);
  });

  it('exchange rejects a token that reaches no account', async () => {
    mocks.supabase.admin.auth.getUser.mockResolvedValue({
      data: { user: { id: '9b9b8c67-...-unknown' as string, email: 'ghost@example.com' } },
      error: null,
    });
    mocks.clientRepo.getBySupabaseUid.mockResolvedValue(null);
    mocks.clientRepo.findByEmail.mockResolvedValue(null);
    const res = await app.inject(post('/api/auth/client/exchange', { accessToken: 'jwt-nobody' }));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_credentials' });
  });

  it('exchange refuses a suspended account', async () => {
    seedSupabaseClient();
    dbRow.status = 'suspended';
    mocks.supabase.admin.auth.getUser.mockResolvedValue({
      data: { user: { id: SUPABASE_UID, email: 'owner@ace.com' } },
      error: null,
    });
    const res = await app.inject(post('/api/auth/client/exchange', { accessToken: 'jwt-1' }));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_session' });
  });

  it('exchange fails closed when Supabase is unconfigured', async () => {
    mocks.supabase.supabaseAdmin.mockReturnValue(null);
    const res = await app.inject(post('/api/auth/client/exchange', { accessToken: 'jwt-1' }));
    expect(res.statusCode).toBe(503);
  });
});

describe('client auth: session-scoped endpoints', () => {
  let app: App;
  beforeEach(async () => {
    redisStore.clear();
    vi.clearAllMocks();
    defaultSupabaseMocks();
    app = await buildApp();
  });

  async function mint(over: { email?: string } = {}) {
    await seedActiveClient(over.email ?? 'owner@ace.com');
    const res = await app.inject(login(over.email ?? 'owner@ace.com', PASSWORD));
    expect(res.statusCode).toBe(200);
    return res.json().sid as string;
  }

  it('treats logout without a credential as a benign no-op', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/client/logout', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it('revokes the sid on logout', async () => {
    const sid = await mint();
    const res = await app.inject({ method: 'POST', url: '/api/auth/client/logout', headers: { 'x-client-session': sid, 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/api/auth/client/logout', headers: { 'x-client-session': sid, 'content-type': 'application/json' }, payload: '{}' });
    expect(again.statusCode).toBe(401);
  });

  it('reports the account on /me', async () => {
    const sid = await mint();
    const res = await app.inject({ method: 'GET', url: '/api/auth/client/me', headers: { 'x-client-session': sid } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ client: { clientId: CLIENT_ID, name: 'Ace Widgets', email: 'owner@ace.com' } });
  });

  it('rejects a wrong current password on change', async () => {
    const sid = await mint();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/client/password',
      headers: { 'x-client-session': sid, 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: 'nope', newPassword: 'a-new-password' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('changes the password, bumps the epoch, and keeps the caller signed in', async () => {
    const sid = await mint();
    // A sibling session minted before the rotation carries the old epoch.
    const siblingSid = await mint();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/client/password',
      headers: { 'x-client-session': sid, 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'a-new-password' }),
    });
    expect(res.statusCode).toBe(200);
    const { epoch } = res.json();
    expect(typeof epoch).toBe('string');
    expect(mocks.clientRepo.setPassword).toHaveBeenCalledWith(CLIENT_ID, expect.any(String));

    // Caller's own sid still verifies after the rotation (it was re-minted).
    const me = await app.inject({ method: 'GET', url: '/api/auth/client/me', headers: { 'x-client-session': sid } });
    expect(me.statusCode).toBe(200);
    // The sibling was not re-signed, so its epoch is stale and it is dead.
    const stale = await app.inject({ method: 'GET', url: '/api/auth/client/me', headers: { 'x-client-session': siblingSid } });
    expect(stale.statusCode).toBe(401);
    // The old password no longer works.
    const oldPw = await app.inject(login('owner@ace.com', PASSWORD));
    expect(oldPw.statusCode).toBe(401);
  });

  it('rotates a Supabase-managed password through Auth and keeps the caller signed in', async () => {
    seedSupabaseClient();
    supabasePasswordOk();
    mocks.supabase.admin.auth.admin.updateUserById.mockResolvedValue({ data: { user: dbRow }, error: null });
    const sid = (await app.inject(login('owner@ace.com', PASSWORD))).json().sid as string;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/client/password',
      headers: { 'x-client-session': sid, 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'a-new-password' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mocks.supabase.admin.auth.admin.updateUserById).toHaveBeenCalledWith(SUPABASE_UID, { password: 'a-new-password' });
    expect(mocks.clientRepo.setPassword).not.toHaveBeenCalled();
    const me = await app.inject({ method: 'GET', url: '/api/auth/client/me', headers: { 'x-client-session': sid } });
    expect(me.statusCode).toBe(200);
  });
});

describe('clients admin surface (operator only)', () => {
  let app: App;
  beforeEach(async () => {
    redisStore.clear();
    vi.clearAllMocks();
    defaultSupabaseMocks();
    app = await buildApp();
    mocks.clientRepo.list.mockResolvedValue([clientRow()]);
    mocks.clientRepo.storeCountsFor.mockResolvedValue(new Map([[CLIENT_ID, 2]]));
  });

  function admin(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
    return {
      method,
      url,
      headers: { 'x-api-key': ADMIN_KEY, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    };
  }

  it('rejects an anonymous call', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a client session on the admin surface', async () => {
    await seedActiveClient();
    const sid = await app.inject(login('owner@ace.com', PASSWORD));
    const res = await app.inject({ method: 'GET', url: '/api/clients', headers: { 'x-client-session': sid.json().sid } });
    expect(res.statusCode).toBe(401);
  });

  it('lists clients with their store counts', async () => {
    const res = await app.inject(admin('GET', '/api/clients'));
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: CLIENT_ID, name: 'Ace Widgets', status: 'active', storeCount: 2 });
  });

  it('creates a client with a one-time temporary password', async () => {
    mocks.clientRepo.findByEmail.mockResolvedValue(null);
    mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: SUPABASE_UID } },
      error: null,
    });
    mocks.clientRepo.create.mockResolvedValue(NEW_CLIENT_ID);
    mocks.clientRepo.get.mockImplementation(async (id: string) =>
      id === NEW_CLIENT_ID ? clientRow({ id: NEW_CLIENT_ID, email: 'new@ace.com' }) : null,
    );
    const res = await app.inject(admin('POST', '/api/clients', { name: 'New Co', email: ' NEW@Ace.COM ' }));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.temporaryPassword).toBeDefined();
    expect(body.email).toBe('new@ace.com');
    expect(mocks.supabase.admin.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@ace.com', email_confirm: true }),
    );
    // No scrypt hash is ever persisted for a Supabase-managed account.
    expect(mocks.clientRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Co', email: 'new@ace.com', passwordHash: null, supabaseUid: SUPABASE_UID }),
    );
  });

  it('reuses an existing Supabase identity when inviting a returning email', async () => {
    mocks.clientRepo.findByEmail.mockResolvedValue(null);
    mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('User already registered'), { code: 'user_already_exists' }),
    });
    mocks.supabase.findSupabaseUserByEmail.mockResolvedValue({ id: SUPABASE_UID } as never);
    mocks.clientRepo.create.mockResolvedValue(NEW_CLIENT_ID);
    mocks.clientRepo.get.mockImplementation(async (id: string) => (id === NEW_CLIENT_ID ? clientRow({ id: NEW_CLIENT_ID }) : null));
    const res = await app.inject(admin('POST', '/api/clients', { name: 'Back', email: 'back@ace.com' }));
    expect(res.statusCode).toBe(201);
    expect(mocks.clientRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'back@ace.com', supabaseUid: SUPABASE_UID }),
    );
  });

  it('fails closed when creating a client without Supabase configured', async () => {
    mocks.clientRepo.findByEmail.mockResolvedValue(null);
    mocks.supabase.supabaseAdmin.mockReturnValue(null);
    const res = await app.inject(admin('POST', '/api/clients', { name: 'New', email: 'new@ace.com' }));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'auth_unavailable' });
  });

  it('rejects a duplicate email with 409', async () => {
    mocks.clientRepo.findByEmail.mockResolvedValue(clientRow());
    const res = await app.inject(admin('POST', '/api/clients', { name: 'Dup', email: 'owner@ace.com' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'client_already_exists' });
  });

  it('suspending a client bumps its epoch so live sessions die', async () => {
    mocks.clientRepo.setStatus.mockResolvedValue(true);
    const res = await app.inject(admin('PATCH', `/api/clients/${CLIENT_ID}/status`, { status: 'suspended' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'suspended' });
    expect(redisStore.has(`cli:sess:epoch:${CLIENT_ID}`)).toBe(true);
  });

  it('returns 404 when resetting a password for an unknown client', async () => {
    mocks.clientRepo.get.mockResolvedValue(null);
    const res = await app.inject(admin('POST', `/api/clients/${OTHER_STORE_ID}/reset-password`, { password: 'x'.repeat(12) }));
    expect(res.statusCode).toBe(404);
  });

  it('resets a Supabase-managed password through Auth and kills live sessions', async () => {
    mocks.clientRepo.get.mockResolvedValue(clientRow({ supabaseUid: SUPABASE_UID }));
    mocks.supabase.admin.auth.admin.updateUserById.mockResolvedValue({ data: { user: dbRow }, error: null });
    const res = await app.inject(admin('POST', `/api/clients/${CLIENT_ID}/reset-password`, { password: 'x'.repeat(12) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(mocks.supabase.admin.auth.admin.updateUserById).toHaveBeenCalledWith(SUPABASE_UID, { password: 'x'.repeat(12) });
    expect(mocks.clientRepo.setPassword).not.toHaveBeenCalled();
    expect(redisStore.has(`cli:sess:epoch:${CLIENT_ID}`)).toBe(true);
  });

  it('still resets a legacy scrypt account locally until it is imported', async () => {
    mocks.clientRepo.get.mockResolvedValue(clientRow());
    const res = await app.inject(admin('POST', `/api/clients/${CLIENT_ID}/reset-password`, { password: 'x'.repeat(12) }));
    expect(res.statusCode).toBe(200);
    expect(mocks.clientRepo.setPassword).toHaveBeenCalledWith(CLIENT_ID, expect.any(String));
    expect(mocks.supabase.admin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('attaches and detaches a store, checking ownership on detach', async () => {
    mocks.clientRepo.get.mockResolvedValue(clientRow());
    mocks.storeRepo.get.mockResolvedValue({ id: STORE_ID });
    const attach = await app.inject(admin('POST', `/api/clients/${CLIENT_ID}/stores`, { storeId: STORE_ID }));
    expect(attach.statusCode).toBe(200);
    expect(mocks.storeRepo.assignClient).toHaveBeenCalledWith(STORE_ID, CLIENT_ID);

    mocks.storeRepo.belongsToClient.mockResolvedValue(false);
    const wrong = await app.inject(admin('DELETE', `/api/clients/${CLIENT_ID}/stores/${OTHER_STORE_ID}`));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: 'store_not_assigned' });

    mocks.storeRepo.belongsToClient.mockResolvedValue(true);
    const detach = await app.inject(admin('DELETE', `/api/clients/${CLIENT_ID}/stores/${STORE_ID}`));
    expect(detach.statusCode).toBe(200);
    expect(mocks.storeRepo.assignClient).toHaveBeenCalledWith(STORE_ID, null);
  });
});