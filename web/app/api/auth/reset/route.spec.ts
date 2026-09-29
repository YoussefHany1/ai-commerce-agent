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
  // One upstream call now: `/api/auth/exchange` with `rotate` both bumps the epoch and
  // mints the session, so there is no window where a pre-reset session survives.
  stubFetch((url) => {
    if (url.endsWith('/exchange')) {
      return jsonResponse({
        ok: true,
        kind: 'client',
        clientId: 'client-1',
        sid: 'sid-1',
        epoch: 'epoch-1',
        expiresIn: 3600,
        name: 'Nadia',
        email: 'n@b.c',
      });
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

  it('verifies, rotates the password, then exchanges with rotate in one call', async () => {
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
    expect(await res.json()).toEqual({ ok: true, kind: 'client' });

    expect(auth.verifyOtp).toHaveBeenCalledWith({
      type: 'recovery',
      email: VALID.email,
      token: VALID.token,
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: VALID.password });

    // One call, carrying the token read *after* the rotation and asking for the bump.
    // The epoch change and the new session are the same transaction upstream, so a
    // pre-reset cookie cannot survive a completed reset.
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).endsWith('/api/auth/exchange')).toBe(true);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      accessToken: 'rotated-token',
      rotate: true,
    });

    expect(cookieStore.written).toHaveLength(1);
    expect(cookieStore.written[0].name).toBe('aca_session');
    const payload = JSON.parse(Buffer.from(cookieStore.written[0].value.split('.')[0], 'base64url').toString('utf8'));
    expect(payload.kind).toBe('client');
    expect(payload.epoch).toBe('epoch-1');
  });

  it('signs an operator in on the same link, with both of its epochs', async () => {
    // The route does not know or care which kind the recovery token resolves to; the
    // API decides, and the cookie has to carry whatever that kind requires.
    auth.verifyOtp.mockResolvedValue({
      data: { session: { access_token: 'verify-token' } },
      error: null,
    });
    auth.updateUser.mockResolvedValue({ error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 'rotated-token' } }, error: null });
    stubFetch((url) =>
      url.endsWith('/exchange')
        ? jsonResponse({
            ok: true,
            kind: 'operator',
            operatorId: 'op-1',
            sid: 'op-sid-1',
            epoch: 'op-epoch-1',
            globalEpoch: 'global-epoch-1',
            expiresIn: 3600,
            name: 'Youssef',
          })
        : jsonResponse({ ok: true }),
    );

    const res = await post(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: 'operator' });
    const payload = JSON.parse(Buffer.from(cookieStore.written[0].value.split('.')[0], 'base64url').toString('utf8'));
    expect(payload).toMatchObject({
      kind: 'operator',
      operatorId: 'op-1',
      epoch: 'op-epoch-1',
      globalEpoch: 'global-epoch-1',
    });
  });

  it('issues no cookie when the answer is not a complete session', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'verify-token' } }, error: null });
    auth.updateUser.mockResolvedValue({ error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 'rotated-token' } }, error: null });
    // A 200 with no sid/epoch: the password was rotated, but nothing can be signed in.
    stubFetch(() => jsonResponse({ ok: true }));

    const res = await post(VALID);
    expect(res.status).toBe(503);
    expect(cookieStore.written).toHaveLength(0);
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
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      accessToken: 'verify-token',
      rotate: true,
    });
  });

  it('returns 400 invalid_link when the password rotate fails', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'verify-token' } }, error: null });
    auth.updateUser.mockResolvedValue({ error: { message: 'password too weak' } });
    const res = await post(VALID);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_link' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('relays an exchange rejection without issuing a cookie', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'verify-token' } }, error: null });
    auth.updateUser.mockResolvedValue({ error: null });
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    stubFetch(() => jsonResponse({ error: 'invalid_credentials' }, 401));

    const res = await post(VALID);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(cookieStore.written).toHaveLength(0);
  });
});