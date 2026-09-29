import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: () => ({ getAll: () => [], set: () => {} }) }));

const { POST } = await import('./route');

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
  return POST(new Request('http://app.test/api/auth/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  process.env.API_URL = 'http://upstream.test';
  stubFetch(() => jsonResponse({ ok: true }));
});

afterEach(() => {
  delete process.env.API_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/auth/forgot', () => {
  it('forwards the trimmed email to the API forgot endpoint', async () => {
    const res = await post({ email: '  N@b.c  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const body = JSON.parse(String((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ email: 'N@b.c' });
  });

  it('is uniformly successful even when the account is unknown (no enumeration)', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const res = await post({ email: 'ghost@nowhere.test' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects a malformed email without calling upstream', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ email: '' })).status).toBe(400);
    expect((await post({ email: 42 })).status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the API base is not configured', async () => {
    delete process.env.API_URL;
    const res = await post({ email: 'n@b.c' });
    expect(res.status).toBe(503);
  });
});