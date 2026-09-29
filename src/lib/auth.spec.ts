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

const clientSession = vi.hoisted(() => ({
  CLIENT_SESSION_HEADER: 'x-client-session',
  resolveClientSession: vi.fn(),
}));
vi.mock('./clientSession.js', () => clientSession);

const operatorSession = vi.hoisted(() => ({
  OPERATOR_SESSION_HEADER: 'x-operator-session',
  resolveOperatorSession: vi.fn(),
}));
vi.mock('./operatorSession.js', () => operatorSession);

const repos = vi.hoisted(() => ({
  storeRepo: { belongsToClient: vi.fn() },
}));
vi.mock('../db/repos.js', () => repos);

vi.mock('../db/client.js', () => ({
  withTenant: async () => [{ hash: 'unused', hint: 'unused' }],
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

function operatorReq(ip: string, sid: string, key?: string): FastifyRequest {
  const headers: Record<string, string | string[] | undefined> = { 'x-operator-session': sid };
  if (key) headers['x-api-key'] = key;
  return { headers, socket: { remoteAddress: ip } } as any;
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

describe('requireOperator', () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
    operatorSession.resolveOperatorSession.mockReset();
    operatorSession.resolveOperatorSession.mockResolvedValue(null);
  });
  afterEach(() => vi.resetModules());

  it('accepts a valid key and resets the brute-force counter', async () => {
    const { requireOperator } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    store.set('rl:apikey:1.2.3.4', 29);
    const r = reply();
    await requireOperator(req('1.2.3.4', ADMIN_KEY), r);
    expect(r.out.code).toBe(0);
    expect(store.has('rl:apikey:1.2.3.4')).toBe(false);
  });

  it('rejects a wrong key with 401', async () => {
    const { requireOperator } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    const r = reply();
    await requireOperator(req('1.2.3.4', 'wrong-key'), r);
    expect(r.out.code).toBe(401);
    expect(r.out.body).toMatchObject({ error: 'unauthorized' });
  });

  it('locks the IP out with 429 after the brute-force limit', async () => {
    const { requireOperator } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    for (let i = 0; i < 30; i++) {
      const r = reply();
      await requireOperator(req('9.9.9.9', 'wrong'), r);
      expect(r.out.code).toBe(401);
    }
    const locked = reply();
    await requireOperator(req('9.9.9.9', 'wrong'), locked);
    expect(locked.out.code).toBe(429);
  });

  it('locks out a different IP independently', async () => {
    const { requireOperator } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    for (let i = 0; i < 31; i++) {
      const r = reply();
      await requireOperator(req('5.5.5.5', 'wrong'), r);
    }
    const ok = reply();
    await requireOperator(req('5.5.5.6', ADMIN_KEY), ok);
    expect(ok.out.code).toBe(0);
  });

  it('returns 503 when no admin key is configured', async () => {
    const { requireOperator } = await loadAuth({}, ['ADMIN_API_KEY']);
    const r = reply();
    await requireOperator(req('1.1.1.1', ADMIN_KEY), r);
    expect(r.out.code).toBe(503);
  });

  it('accepts a person session and attaches who they are', async () => {
    const { requireOperator } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    operatorSession.resolveOperatorSession.mockResolvedValue({
      operatorId: 'op-1',
      email: 'youssef@example.com',
      name: 'Youssef',
    });
    const r = reply();
    const request = operatorReq('1.2.3.4', 'sid-1');
    await requireOperator(request, r);
    expect(r.out.code).toBe(0);
    expect((request as any).principal).toEqual({
      kind: 'operator',
      operatorId: 'op-1',
      email: 'youssef@example.com',
      name: 'Youssef',
      via: 'session',
    });
  });

  it('does not fall through to the admin key when a session is rejected', async () => {
    // A revoked cookie must not be rescued by a key that happens to be on the same
    // request: the request is a person's browser, and they are signed out. Mirrors the
    // real resolver, which sends the 401 itself and returns the `undefined` sentinel.
    const { requireOperator } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    operatorSession.resolveOperatorSession.mockImplementation(async (_req, rep) => {
      (rep as any).code(401).send({ error: 'invalid_session' });
      return undefined as any;
    });
    const r = reply();
    const request = operatorReq('1.2.3.4', 'dead-sid', ADMIN_KEY);
    await requireOperator(request, r);
    expect(r.out.code).toBe(401);
    // `invalid_session`, not the key path's `unauthorized`: proof the key was never
    // considered, since a valid key would have been accepted outright.
    expect(r.out.body).toMatchObject({ error: 'invalid_session' });
    expect((request as any).principal).toBeUndefined();
  });
});

describe('requireDashboard', () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
    clientSession.resolveClientSession.mockReset();
    operatorSession.resolveOperatorSession.mockReset();
    operatorSession.resolveOperatorSession.mockResolvedValue(null);
    repos.storeRepo.belongsToClient.mockReset();
  });
  afterEach(() => vi.resetModules());

  function adminReq(ip: string): FastifyRequest {
    return { headers: { 'x-api-key': ADMIN_KEY }, socket: { remoteAddress: ip } } as any;
  }

  function clientReq(
    sid = 'some-sid',
    storeId = 's1',
  ): FastifyRequest {
    return {
      headers: { 'x-client-session': sid, 'x-store-id': storeId, 'x-api-key': ADMIN_KEY },
      socket: { remoteAddress: '1.1.1.1' },
      params: { storeId },
    } as any;
  }

  it('derives a machine operator principal from the admin key', async () => {
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    const r = reply();
    const req = adminReq('1.1.1.1');
    await requireDashboard()(req, r);
    // A key is not a person: it carries no identity, which is why the admin surfaces
    // need the operators table before they can say who acted.
    expect((req as any).principal).toEqual({
      kind: 'operator',
      operatorId: null,
      email: null,
      name: null,
      via: 'admin_key',
    });
    expect(r.out.code).toBe(0);
  });

  it('derives a person operator principal from a session', async () => {
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    operatorSession.resolveOperatorSession.mockResolvedValue({
      operatorId: 'op-1',
      email: 'youssef@example.com',
      name: 'Youssef',
    });
    const r = reply();
    const req = operatorReq('1.1.1.1', 'sid-1');
    await requireDashboard()(req, r);
    expect((req as any).principal).toMatchObject({ kind: 'operator', operatorId: 'op-1', via: 'session' });
  });

  it('does not let a client session upgrade into the operator scope', async () => {
    // The dashboard proxies with the admin key attached for compatibility; a client
    // cookie on the same request must still land as a client, not as an operator.
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    clientSession.resolveClientSession.mockResolvedValue({
      clientId: 'client-a',
      name: 'Ace',
      email: 'a@example.com',
    });
    repos.storeRepo.belongsToClient.mockResolvedValue(true);
    const r = reply();
    const req = clientReq();
    await requireDashboard((x) => (x.params as any).storeId)(req, r);
    expect((req as any).principal.kind).toBe('client');
  });

  it('derives a client principal for an owned store', async () => {
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    clientSession.resolveClientSession.mockResolvedValue({
      clientId: 'client-a',
      name: 'Ace',
      email: 'a@example.com',
    });
    repos.storeRepo.belongsToClient.mockResolvedValue(true);
    const r = reply();
    const req = clientReq();
    await requireDashboard((x) => (x.params as any).storeId)(req, r);
    expect((req as any).principal).toEqual({
      kind: 'client',
      clientId: 'client-a',
      name: 'Ace',
      email: 'a@example.com',
    });
    expect(repos.storeRepo.belongsToClient).toHaveBeenCalledWith('s1', 'client-a');
    expect(r.out.code).toBe(0);
  });

  it('rejects a client reaching a store it does not own with 404', async () => {
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    clientSession.resolveClientSession.mockResolvedValue({
      clientId: 'client-a',
      name: 'Ace',
      email: 'a@example.com',
    });
    repos.storeRepo.belongsToClient.mockResolvedValue(false);
    const r = reply();
    await requireDashboard((x) => (x.params as any).storeId)(clientReq(), r);
    expect(r.out.code).toBe(404);
    expect(r.out.body).toMatchObject({ error: 'store_not_found' });
  });

  it('rejects a client request with no store id with 400', async () => {
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    clientSession.resolveClientSession.mockResolvedValue({
      clientId: 'client-a',
      name: 'Ace',
      email: 'a@example.com',
    });
    const r = reply();
    await requireDashboard(() => undefined)(clientReq('sid', ''), r);
    expect(r.out.code).toBe(400);
    expect(r.out.body).toMatchObject({ error: 'store_required' });
  });

  it('resolves a client ahead of a valid admin key on the same request', async () => {
    // Least privilege wins: a request carrying both credentials must act as the
    // session, not silently upgrade to the operator scope.
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    clientSession.resolveClientSession.mockResolvedValue({
      clientId: 'client-a',
      name: 'Ace',
      email: 'a@example.com',
    });
    repos.storeRepo.belongsToClient.mockResolvedValue(true);
    const r = reply();
    const req = clientReq();
    await requireDashboard((x) => (x.params as any).storeId)(req, r);
    expect((req as any).principal.kind).toBe('client');
  });

  it('lets the resolver reply (401/503) and stops without a principal', async () => {
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    // Simulate the resolver having already sent its 401 and returned null.
    clientSession.resolveClientSession.mockResolvedValue(null);
    const r = reply();
    const req = clientReq();
    await requireDashboard((x) => (x.params as any).storeId)(req, r);
    expect((req as any).principal).toBeUndefined();
  });

  it('rejects a request with no credential with 401', async () => {
    const { requireDashboard } = await loadAuth({ ADMIN_API_KEY: ADMIN_KEY });
    const r = reply();
    const req = { headers: {}, socket: { remoteAddress: '1.1.1.1' } } as any;
    await requireDashboard()(req, r);
    expect(r.out.code).toBe(401);
    expect(r.out.body).toMatchObject({ error: 'unauthorized' });
  });
});