import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: () => ({ getAll: () => [], set: () => {} }) }));

const { POST: registerPost } = await import('./route');

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

function post(body: unknown): Promise<Response> {
  return registerPost(new Request('http://app.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const VALID = { name: 'Nadia', email: 'n@b.c', password: 'correct-horse-battery' };

beforeEach(() => {
  process.env.API_URL = 'http://upstream.test';
  stubFetch((url) => {
    expect(url).toBe('http://upstream.test/api/auth/client/register');
    return jsonResponse({ ok: true });
  });
});

afterEach(() => {
  delete process.env.API_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/auth/register', () => {
  it('forwards a trimmed body to the API register endpoint', async () => {
    const res = await post({ ...VALID, name: '  Nadia  ', email: '  N@b.c  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const body = JSON.parse(String((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ name: 'Nadia', email: 'N@b.c', password: VALID.password });
  });

  it('rejects empty or oversized fields without calling upstream', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ ...VALID, name: '' })).status).toBe(400);
    expect((await post({ ...VALID, email: '' })).status).toBe(400);
    expect((await post({ ...VALID, email: 'x'.repeat(321) })).status).toBe(400);
    expect((await post({ ...VALID, password: 'short' })).status).toBe(400);
    expect((await post({ ...VALID, password: 'x'.repeat(1025) })).status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('relays the API status (503 while Supabase is unavailable)', async () => {
    stubFetch(() => jsonResponse({ error: 'auth_unavailable' }, 503));
    const res = await post(VALID);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_unavailable' });
  });

  it('fails closed with 503 when the API base is not configured', async () => {
    delete process.env.API_URL;
    const res = await post(VALID);
    expect(res.status).toBe(503);
  });
});