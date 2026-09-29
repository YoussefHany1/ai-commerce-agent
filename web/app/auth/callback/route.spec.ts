import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'f'.repeat(48);

// The callback trades the PKCE session for this app's own cookie; the Supabase SDK
// is stubbed away, everything else under the route is real.
const createDashboardSupabaseClient = vi.fn();
vi.mock('@/lib/server/supabase', () => ({ createDashboardSupabaseClient }));

let cookieStore: { written: Array<{ name: string; value: string; options: Record<string, unknown> }> };

vi.mock('next/headers', () => ({
  cookies: () => cookieStore,
}));

const { GET } = await import('./route');

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
  exchangeCodeForSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
};

let auth: AuthStub;

function callbackUrl(params: string[] = []): Request {
  const qs = params.length ? `?${params.join('&')}` : '';
  return new Request(`http://app.test/auth/callback${qs}`);
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.API_URL = 'http://upstream.test';
  cookieStore = makeStore();

  auth = {
    exchangeCodeForSession: vi.fn(),
    getSession: vi.fn(),
  };
  createDashboardSupabaseClient.mockReset();
  createDashboardSupabaseClient.mockImplementation(() => ({ auth }));
  stubFetch(() =>
    jsonResponse({ ok: true, clientId: 'client-1', sid: 'sid-1', epoch: 'epoch-1', name: 'Nadia', email: 'n@b.c' }),
  );
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.API_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /auth/callback', () => {
  it('redirects to /login when the code parameter is missing', async () => {
    const res = await GET(callbackUrl());
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://app.test/login?error=auth_callback');
  });

  it('fails closed when Supabase is not configured', async () => {
    createDashboardSupabaseClient.mockReturnValue(null);
    const res = await GET(callbackUrl(['code=code-1']));
    expect(res.headers.get('location')).toBe('http://app.test/login?error=auth_unavailable');
  });

  it('redirects to /login when the code exchange fails', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: 'bad code' } });
    const res = await GET(callbackUrl(['code=code-1']));
    expect(res.headers.get('location')).toBe('http://app.test/login?error=auth_callback');
  });

  it('trades the token for this app session and lands on the dashboard', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: 'pkce-token' } },
      error: null,
    });
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: 'pkce-token' } },
      error: null,
    });

    const res = await GET(callbackUrl(['code=code-1']));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://app.test/dashboard');

    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('code-1');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    const exchangeBody = JSON.parse(String((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body));
    expect(exchangeBody).toEqual({ accessToken: 'pkce-token' });

    expect(cookieStore.written).toHaveLength(1);
    expect(cookieStore.written[0].name).toBe('aca_session');
  });

  it('honors a same-origin redirect_to after signing in', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });

    const res = await GET(callbackUrl(['code=code-1', 'redirect_to=/dashboard/stores']));
    expect(res.headers.get('location')).toBe('http://app.test/dashboard/stores');
  });

  it('ignores an off-origin redirect_to and signs in to the dashboard anyway', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });

    const res = await GET(callbackUrl(['code=code-1', 'redirect_to=https://evil.test/stores']));
    expect(res.headers.get('location')).toBe('http://app.test/dashboard');
  });

  it('does not sign in when the API rejects the token', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    stubFetch(() => jsonResponse({ error: 'invalid_credentials' }, 401));

    const res = await GET(callbackUrl(['code=code-1']));
    expect(res.headers.get('location')).toBe('http://app.test/login?error=auth_unavailable');
    expect(cookieStore.written).toHaveLength(0);
  });
});