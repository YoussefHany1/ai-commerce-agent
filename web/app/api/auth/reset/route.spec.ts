import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'e'.repeat(48);

// The route's only contact with Supabase is `createDashboardSupabaseClient`, so
// the whole SDK module is stubbed; the fake client exposes the three calls the
// flow makes, driven per-test by the `supabaseClient` fixture below.
const createDashboardSupabaseClient = vi.fn();
vi.mock('@/lib/server/supabase', () => ({ createDashboardSupabaseClient }));

// Shared cookie store so the minted `aca_session` is observable.
let cookieStore: { written: Array<{ name: string; value: string; options: Record<string, unknown> }> };

vi.mock('next/headers', () => ({
  cookies: () => cookieStore,
}));

const { POST } = await import('./route');

function makeStore() {
  const written: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  return {
    written,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      written.push({ name, value, options });
    },
    getAll: () => [],
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  ));
}

type AuthStub = {
  verifyOtp: ReturnType<typeof vi.fn>;
  updateUser: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
};

let auth: AuthStub;

function post(body: unknown): Promise<Response> {
  return POST(new Request('http://app.test/api/auth/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const VALID = { email: 'n@b.c', token: 'secret-otp', password: 'new-password-12' };

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.API_URL = 'http://upstream.test';
  cookieStore = makeStore();

  auth = {
    verifyOtp: vi.fn(),
    updateUser: vi.fn(),
    getSession: vi.fn(),
  };
  createDashboardSupabaseClient.mockReset();
  createDashboardSupabaseClient.mockImplementation(() => ({ auth }));
  // Default upstream answers: reset-complete then exchange both succeed.
  stubFetch((url) => {
    if (url.endsWith('/exchange')) {
      return jsonResponse({ ok: true, clientId: 'client-1', sid: 'sid-1', epoch: 'epoch-1', name: 'Nadia', email: 'n@b.c' });
    }
    return jsonResponse({ ok: true });
  });
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.API_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/auth/reset', () => {
  it('rejects an incomplete or short-password body', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ ...VALID, token: '' })).status).toBe(400);
    expect((await post({ ...VALID, password: 'short' })).status).toBe(400);
    expect((await post({ ...VALID, password: 'x'.repeat(1025) })).status).toBe(400);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when Supabase is not configured', async () => {
    createDashboardSupabaseClient.mockReturnValue(null);
    const res = await post(VALID);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_unavailable' });
  });

  it('reports an invalid token as a 400 invalid_link without touching the API', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: { message: 'otp expired' } });
    const res = await post(VALID);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_link' });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('verifies, rotates the password, bumps the epoch, exchanges and signs in', async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'verify-token', user: { id: 'u1' } } },
      error: null,
    });
    auth.updateUser.mockResolvedValue({ error: null });
    // Password rotation rolls the session, so the access token changes.
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'rotated-token' } },
      error: null,
    });

    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(auth.verifyOtp).toHaveBeenCalledWith({
      type: 'recovery',
      email: VALID.email,
      token: VALID.token,
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: VALID.password });

    // The stalest token must not be used: reset-complete and exchange both got the
    // token read *after* the rotation, and in visit order.
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [bump, exchange] = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)),
    }));
    expect(bump.url.endsWith('/api/auth/client/reset-complete')).toBe(true);
    expect(bump.body).toEqual({ accessToken: 'rotated-token' });
    expect(exchange.url.endsWith('/api/auth/client/exchange')).toBe(true);
    expect(exchange.body).toEqual({ accessToken: 'rotated-token' });

    expect(cookieStore.written).toHaveLength(1);
    expect(cookieStore.written[0].name).toBe('aca_session');
    const payload = JSON.parse(Buffer.from(cookieStore.written[0].value.split('.')[0], 'base64url').toString('utf8'));
    expect(payload.kind).toBe('client');
    expect(payload.epoch).toBe('epoch-1');
  });

  it('uses the verified session token when rotation returns no new session', async () => {
    auth.verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'verify-token' } },
      error: null,
    });
    auth.updateUser.mockResolvedValue({ error: null });
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const res = await post(VALID);
    expect(res.status).toBe(200);
    const fetchMock = vi.mocked(globalThis.fetch);
    const [, exchange] = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)),
    );
    expect(exchange).toEqual({ accessToken: 'verify-token' });
  });

  it('returns 400 invalid_link when the password rotate fails', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'verify-token' } }, error: null });
    auth.updateUser.mockResolvedValue({ error: { message: 'password too weak' } });
    const res = await post(VALID);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_link' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('relays a reset-complete rejection without issuing a cookie', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'verify-token' } }, error: null });
    auth.updateUser.mockResolvedValue({ error: null });
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    stubFetch((url) => {
      if (url.endsWith('/reset-complete')) return jsonResponse({ error: 'invalid_credentials' }, 401);
      return jsonResponse({ ok: true });
    });

    const res = await post(VALID);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(cookieStore.written).toHaveLength(0);
  });
});