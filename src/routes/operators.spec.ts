import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';

/**
 * The operator management surface.
 *
 * These tests care about two things above all: that the write which grants access also
 * gets the identity right, and that the two ways to lock yourself out — suspending
 * yourself, suspending the last person who can sign in — are both refused. Everything
 * else about the surface is bookkeeping.
 */

const ORIGINAL_ENV = { ...process.env };

const ADMIN_KEY = '0123456789abcdef0123456789abcdef';

beforeAll(() => {
  Object.assign(process.env, {
    ADMIN_API_KEY: ADMIN_KEY,
    OPERATOR_SESSION_TTL_SECONDS: '3600',
  });
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

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
    pTTL: async (k: string) => (redisStore.has(k) ? 1000 : -2),
    ping: async () => 'PONG' as const,
  },
};

vi.mock('../lib/redis.js', () => ({ getRedis: async () => infra.redis }));
vi.mock('../db/client.js', () => ({
  withTenant: async (_storeId: string, fn: (tx: any) => Promise<unknown>) => fn({}),
  withOperator: async (fn: (tx: any) => Promise<unknown>) => fn({}),
}));

const mocks = vi.hoisted(() => {
  const operatorRepo = {
    get: vi.fn(),
    findByEmail: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    getBySupabaseUid: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    setSupabaseUid: vi.fn(async () => true),
    create: vi.fn(),
    setStatus: vi.fn(async () => true),
    list: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
  };
  // The client side is consulted on create, so a merchant address or identity cannot be
  // turned into a second role for the same person.
  const clientRepo = {
    findByEmail: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
    getBySupabaseUid: vi.fn<(...args: any[]) => Promise<any>>(async () => null),
  };
  const supabase = {
    admin: {
      auth: {
        admin: {
          createUser: vi.fn(),
          updateUserById: vi.fn(),
          deleteUser: vi.fn(),
        },
      },
    },
    supabaseAdmin: vi.fn(),
    findSupabaseUserByEmail: vi.fn(),
  };
  return { operatorRepo, clientRepo, supabase };
});

vi.mock('../db/repos.js', () => ({ ...mocks, operatorToPublic: (o: any) => o }));
vi.mock('../lib/supabase.js', () => ({
  supabaseAnon: () => null,
  supabaseAdmin: () => mocks.supabase.supabaseAdmin(),
  findSupabaseUserByEmail: (...args: unknown[]) => mocks.supabase.findSupabaseUserByEmail(...args),
}));

const OPERATOR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SUPABASE_UID = '00000000-0000-4000-8000-0000000000aa';
const NEW_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_ID = '22222222-2222-4222-8222-222222222222';

function operatorRow(over: Partial<Record<string, string | null>> = {}) {
  return {
    id: OPERATOR_ID,
    name: 'Youssef',
    email: 'youssef@example.com',
    status: 'active',
    supabaseUid: SUPABASE_UID as string | null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

async function buildApp() {
  vi.resetModules();
  const { default: Fastify } = await import('fastify');
  const { operators } = await import('./operators.js');
  // The real session module, not a stand-in: seeding a sid by hand means hand-writing
  // the sha256 the module keys on, and a test that passes against the wrong key proves
  // nothing about the guard it is meant to exercise.
  const { createOperatorSession } = await import('../lib/operatorSession.js');
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
  await operators(app);
  return { app, mint: (operatorId: string) => createOperatorSession(operatorId) };
}

beforeEach(() => {
  redisStore.clear();
  vi.clearAllMocks();
  // `clearAllMocks` keeps implementations, and several cases below seed a lookup to make
  // one path fail. Without an explicit reset, the next case inherits it and fails for
  // the wrong reason.
  mocks.operatorRepo.findByEmail.mockReset();
  mocks.operatorRepo.findByEmail.mockResolvedValue(null);
  mocks.operatorRepo.getBySupabaseUid.mockReset();
  mocks.operatorRepo.getBySupabaseUid.mockResolvedValue(null);
  mocks.clientRepo.findByEmail.mockReset();
  mocks.clientRepo.findByEmail.mockResolvedValue(null);
  mocks.clientRepo.getBySupabaseUid.mockReset();
  mocks.clientRepo.getBySupabaseUid.mockResolvedValue(null);
  mocks.supabase.supabaseAdmin.mockReturnValue({ auth: { admin: mocks.supabase.admin.auth.admin } });
  mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({
    data: { user: { id: SUPABASE_UID } },
    error: null,
  });
  mocks.supabase.admin.auth.admin.updateUserById.mockResolvedValue({ data: {}, error: null });
  mocks.supabase.admin.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });
  mocks.supabase.findSupabaseUserByEmail.mockResolvedValue({ id: SUPABASE_UID });
  mocks.operatorRepo.list.mockResolvedValue([operatorRow()]);
  mocks.operatorRepo.get.mockImplementation(async (id: string) => {
    if (id === OPERATOR_ID) return operatorRow();
    if (id === OTHER_ID) return operatorRow({ id: OTHER_ID, email: 'other@example.com' });
    if (id === NEW_ID) return operatorRow({ id: NEW_ID, email: 'youssef@example.com' });
    return null;
  });
  mocks.operatorRepo.create.mockResolvedValue(NEW_ID);
});

function key(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return {
    method,
    url,
    headers: {
      'x-api-key': ADMIN_KEY,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  };
}

function as(method: 'GET' | 'POST' | 'PATCH', url: string, sid: string, payload?: unknown) {
  return {
    method,
    url,
    headers: {
      'x-operator-session': sid,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  };
}

describe('operator management: access control', () => {
  it('refuses an anonymous call', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/operators' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the machine key, which is what CLI and migration tooling uses', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('GET', '/api/operators'));
    expect(res.statusCode).toBe(200);
  });

  it('accepts an operator session', async () => {
    // A person's own session is enough to reach the directory: requiring the machine key
    // here would push every admin action back onto a shell.
    const { app, mint } = await buildApp();
    const { sid } = await mint(OPERATOR_ID);
    const res = await app.inject(as('GET', '/api/operators', sid));
    expect(res.statusCode).toBe(200);
  });
});

describe('operator management: listing', () => {
  it('lists the directory', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('GET', '/api/operators'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ id: OPERATOR_ID, status: 'active' })]);
  });

  it('returns one operator, or 404 for an unknown id', async () => {
    const { app } = await buildApp();
    const found = await app.inject(key('GET', `/api/operators/${OPERATOR_ID}`));
    expect(found.statusCode).toBe(200);
    const missing = await app.inject(key('GET', `/api/operators/${UNKNOWN_ID}`));
    expect(missing.statusCode).toBe(404);
  });

  it('rejects a malformed id rather than querying with it', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('GET', '/api/operators/not-a-uuid'));
    expect(res.statusCode).toBe(400);
  });
});

describe('operator management: inviting', () => {
  it('creates the identity and the row, and returns the temporary password once', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: 'Youssef', email: 'Youssef@Example.com' }));
    expect(res.statusCode).toBe(201);
    // The address is normalised before it is stored or looked up, so casing cannot be
    // used to invite the same person twice.
    expect(mocks.supabase.admin.auth.admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'youssef@example.com', email_confirm: true }),
    );
    expect(mocks.operatorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'youssef@example.com', supabaseUid: SUPABASE_UID }),
    );
    expect(typeof res.json().temporaryPassword).toBe('string');
  });

  it('does not echo a password the caller supplied', async () => {
    const { app } = await buildApp();
    const res = await app.inject(
      key('POST', '/api/operators', { name: 'Youssef', email: 'y@example.com', password: 'a-long-enough-password' }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().temporaryPassword).toBeUndefined();
  });

  it('refuses an address that already administers this install', async () => {
    mocks.operatorRepo.findByEmail.mockResolvedValue(operatorRow());
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: 'Dup', email: 'youssef@example.com' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'operator_already_exists' });
    expect(mocks.supabase.admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('refuses an address that is already a merchant', async () => {
    mocks.clientRepo.findByEmail.mockResolvedValue({ id: 'c1', email: 'owner@ace.com' });
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: 'Youssef', email: 'owner@ace.com' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'email_in_use_by_client' });
    expect(mocks.supabase.admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('refuses a Supabase identity that already belongs to a merchant', async () => {
    // The address checks cannot catch an identity linked to another account under a
    // *different* address — a person who signed up as a merchant and is then invited to
    // administer. The uid check is what closes that.
    mocks.clientRepo.getBySupabaseUid.mockResolvedValue({ id: 'c1', email: 'other@example.com' });
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: 'Youssef', email: 'y@example.com' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'supabase_identity_in_use' });
    expect(mocks.operatorRepo.create).not.toHaveBeenCalled();
  });

  it('removes the identity it just made when the local row cannot be written', async () => {
    // Otherwise a credential nobody was told about is left sitting in the identity
    // provider, waiting for the next invite to pick it up.
    mocks.operatorRepo.create.mockRejectedValue(new Error('db down'));
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: 'Youssef', email: 'y@example.com' }));
    expect(res.statusCode).toBe(503);
    expect(mocks.supabase.admin.auth.admin.deleteUser).toHaveBeenCalledWith(SUPABASE_UID);
  });

  it('does not remove a pre-existing identity that the invite merely reused', async () => {
    mocks.supabase.admin.auth.admin.createUser.mockResolvedValue({
      data: null,
      error: { code: 'user_already_exists' },
    });
    mocks.supabase.findSupabaseUserByEmail.mockResolvedValue({ id: SUPABASE_UID });
    mocks.operatorRepo.create.mockRejectedValue(new Error('db down'));
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: 'Youssef', email: 'y@example.com' }));
    expect(res.statusCode).toBe(503);
    // It belonged to someone before this request; deleting it would be a second, worse
    // failure.
    expect(mocks.supabase.admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed address before touching the identity provider', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: 'X', email: 'not-an-email' }));
    expect(res.statusCode).toBe(400);
    expect(mocks.supabase.admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('rejects a blank name', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('POST', '/api/operators', { name: '   ', email: 'y@example.com' }));
    expect(res.statusCode).toBe(400);
  });
});

describe('operator management: suspension', () => {
  it('suspends an operator and moves their epoch', async () => {
    // The epoch bump is what logs them out of every device now, not at their next login.
    mocks.operatorRepo.list.mockResolvedValue([operatorRow(), operatorRow({ id: OTHER_ID })]);
    const { app } = await buildApp();
    const res = await app.inject(key('PATCH', `/api/operators/${OTHER_ID}/status`, { status: 'suspended' }));
    expect(res.statusCode).toBe(200);
    expect(mocks.operatorRepo.setStatus).toHaveBeenCalledWith(OTHER_ID, 'suspended');
    expect(redisStore.get(`op:sess:epoch:${OTHER_ID}`)?.value).toBeTruthy();
  });

  it('refuses to let an operator suspend themselves', async () => {
    const { app, mint } = await buildApp();
    const { sid } = await mint(OPERATOR_ID);
    const res = await app.inject(as('PATCH', `/api/operators/${OPERATOR_ID}/status`, sid, { status: 'suspended' }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'cannot_suspend_self' });
    expect(mocks.operatorRepo.setStatus).not.toHaveBeenCalled();
  });

  it('refuses to suspend the last person who can sign in', async () => {
    mocks.operatorRepo.list.mockResolvedValue([operatorRow()]);
    const { app } = await buildApp();
    const res = await app.inject(key('PATCH', `/api/operators/${OPERATOR_ID}/status`, { status: 'suspended' }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'last_active_operator' });
    expect(mocks.operatorRepo.setStatus).not.toHaveBeenCalled();
  });

  it('allows reactivation, including of the only active operator', async () => {
    // The last-active rule is about removing access, not about granting it. Refusing a
    // reactivation would leave an install stuck with a suspended operator and no way to
    // bring them back through the UI.
    mocks.operatorRepo.list.mockResolvedValue([operatorRow({ status: 'suspended' })]);
    const { app } = await buildApp();
    const res = await app.inject(key('PATCH', `/api/operators/${OPERATOR_ID}/status`, { status: 'active' }));
    expect(res.statusCode).toBe(200);
    expect(mocks.operatorRepo.setStatus).toHaveBeenCalledWith(OPERATOR_ID, 'active');
  });

  it('rejects a status that is neither active nor suspended', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('PATCH', `/api/operators/${OPERATOR_ID}/status`, { status: 'deleted' }));
    expect(res.statusCode).toBe(400);
  });
});

describe('operator management: credentials', () => {
  it('resets a password and evicts that operator only', async () => {
    const { app } = await buildApp();
    const res = await app.inject(
      key('POST', `/api/operators/${OPERATOR_ID}/reset-password`, { password: 'a-long-enough-password' }),
    );
    expect(res.statusCode).toBe(200);
    expect(mocks.supabase.admin.auth.admin.updateUserById).toHaveBeenCalledWith(SUPABASE_UID, {
      password: 'a-long-enough-password',
    });
    const own = redisStore.get(`op:sess:epoch:${OPERATOR_ID}`)?.value;
    expect(own).toBeTruthy();
    // The install-wide epoch is untouched, so the admin who performed the reset is still
    // signed in on their own device.
    expect(redisStore.get('op:sess:epoch')?.value).toBeUndefined();
  });

  it('refuses to reset a password on a row with no identity', async () => {
    mocks.operatorRepo.get.mockResolvedValue(operatorRow({ supabaseUid: null }));
    const { app } = await buildApp();
    const res = await app.inject(
      key('POST', `/api/operators/${OPERATOR_ID}/reset-password`, { password: 'a-long-enough-password' }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'operator_has_no_identity' });
  });

  it('rejects a short password', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('POST', `/api/operators/${OPERATOR_ID}/reset-password`, { password: 'short' }));
    expect(res.statusCode).toBe(400);
    expect(mocks.supabase.admin.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('logs one operator out of every device without changing their status', async () => {
    const { app } = await buildApp();
    const res = await app.inject(key('POST', `/api/operators/${OPERATOR_ID}/revoke-sessions`));
    expect(res.statusCode).toBe(200);
    expect(mocks.operatorRepo.setStatus).not.toHaveBeenCalled();
    expect(redisStore.get(`op:sess:epoch:${OPERATOR_ID}`)?.value).toBeTruthy();
  });

  it('bumps the install-wide epoch for revoke-all, which also evicts the caller', async () => {
    const { app, mint } = await buildApp();
    const { sid } = await mint(OPERATOR_ID);
    const before = redisStore.get('op:sess:epoch')?.value;
    const res = await app.inject(as('POST', '/api/operators/revoke-all', sid));
    expect(res.statusCode).toBe(200);
    const after = redisStore.get('op:sess:epoch')?.value;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('refuses revoke-all to a machine, which has no operator to attribute it to', async () => {
    // A global revocation is a serious act; doing it with a shared key leaves no person
    // to blame and no session to end. The shell can still do it — see
    // `npm run revoke-operator-sessions` — but the HTTP surface will not hand out the
    // capability without a name attached.
    const { app } = await buildApp();
    redisStore.set('op:sess:epoch', { value: 'before' });
    const res = await app.inject(key('POST', '/api/operators/revoke-all'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'machine_principal_cannot_revoke_all' });
    // A refused call must not have moved the epoch on its way out.
    expect(redisStore.get('op:sess:epoch')?.value).toBe('before');
  });

  it('still lets a machine do every targeted action', async () => {
    // The key exists for CLI and migration tooling, and refusing it the whole surface
    // would mean an incident has to be handled by hand-editing rows.
    const { app } = await buildApp();
    const res = await app.inject(key('POST', `/api/operators/${OTHER_ID}/revoke-sessions`));
    expect(res.statusCode).toBe(200);
  });

  it('refuses revoke-all when the session store is unreachable rather than claiming success', async () => {
    const { app, mint } = await buildApp();
    const { sid } = await mint(OPERATOR_ID);
    const set = infra.redis.set;
    infra.redis.set = async () => {
      throw new Error('redis down');
    };
    try {
      const res = await app.inject(as('POST', '/api/operators/revoke-all', sid));
      expect(res.statusCode).toBe(503);
    } finally {
      infra.redis.set = set;
    }
  });
});
