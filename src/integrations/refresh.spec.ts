import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';

const ORIG = {
  sallaId: process.env.SALLA_CLIENT_ID,
  sallaSecret: process.env.SALLA_CLIENT_SECRET,
  zidId: process.env.ZID_CLIENT_ID,
  zidSecret: process.env.ZID_CLIENT_SECRET,
};

function setEnv() {
  process.env.SALLA_CLIENT_ID = 'salla-id';
  process.env.SALLA_CLIENT_SECRET = 'salla-secret';
  process.env.ZID_CLIENT_ID = 'zid-id';
  process.env.ZID_CLIENT_SECRET = 'zid-secret';
}

function restoreEnv() {
  const orig = ORIG;
  for (const [k, v] of Object.entries(orig)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('refreshProviderToken', () => {
  afterAll(restoreEnv);
  afterEach(() => vi.unstubAllGlobals());

  it('refreshes a Salla token with client credentials', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(String(url)).toBe('https://accounts.salla.sa/oauth2/token');
        const body = new URLSearchParams(init.body as string);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('client_id')).toBe('salla-id');
        expect(body.get('client_secret')).toBe('salla-secret');
        expect(body.get('refresh_token')).toBe('rt-old');
        return new Response(JSON.stringify({ access_token: 'acc-2', refresh_token: 'rt-2', expires_in: 1209600 }), { status: 200 });
      }),
    );
    vi.resetModules();
    const { refreshProviderToken } = await import('./refresh.js');
    const res = await refreshProviderToken('salla', 'rt-old');
    expect(res?.accessToken).toBe('acc-2');
    expect(res?.refreshToken).toBe('rt-2');
    expect(res?.expiresAt).toBeInstanceOf(Date);
    expect(res?.metadata).toBeUndefined();
  });

  it('refreshes a Zid token and returns authorization metadata', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'mgr-2', authorization: 'jwt-2', refresh_token: 'zrt-2', expires_in: 31536000 }),
          { status: 200 },
        ),
      ),
    );
    vi.resetModules();
    const { refreshProviderToken } = await import('./refresh.js');
    const res = await refreshProviderToken('zid', 'zrt-1');
    expect(res?.accessToken).toBe('mgr-2');
    expect(res?.metadata?.zidAuthorization).toBe('jwt-2');
  });

  it('returns null when provider credentials are unconfigured', async () => {
    delete process.env.SALLA_CLIENT_ID;
    delete process.env.SALLA_CLIENT_SECRET;
    delete process.env.ZID_CLIENT_ID;
    delete process.env.ZID_CLIENT_SECRET;
    vi.resetModules();
    const { refreshProviderToken } = await import('./refresh.js');
    expect(await refreshProviderToken('salla', 'rt')).toBeNull();
    expect(await refreshProviderToken('zid', 'rt')).toBeNull();
    expect(await refreshProviderToken('shopify', 'rt')).toBeNull();
  });
});