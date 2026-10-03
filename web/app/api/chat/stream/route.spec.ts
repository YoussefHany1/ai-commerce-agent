import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ verifySession: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: () => ({ get: () => ({ value: 'cookie' }) }) }));
vi.mock('@/lib/server/session', () => ({
  SESSION_COOKIE: 'aca_session',
  verifySession: mocks.verifySession,
}));

const { POST } = await import('./route');

/** An SSE body that yields the given frames. */
function streamResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})),
  );
}

function post(): Promise<Response> {
  return POST(
    new Request('http://app.test/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer guest-token' },
      body: JSON.stringify({ message: 'hi' }),
    }),
  );
}

beforeEach(() => {
  process.env.API_URL = 'http://upstream.test';
  mocks.verifySession.mockResolvedValue({ ok: true, payload: { kind: 'client', sid: 'sid-1' } });
  stubFetch(() => streamResponse(['data: {"type":"done","reply":"ok"}\n\n']));
});

afterEach(() => {
  delete process.env.API_URL;
  mocks.verifySession.mockReset();
  vi.unstubAllGlobals();
});

describe('POST /api/chat/stream', () => {
  it('forwards the guest bearer token and pipes the SSE body through', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {"type":"done","reply":"ok"}\n\n');

    const call = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(call[0])).toBe('http://upstream.test/api/chat');
    const init = call[1]!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Headers;
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('authorization')).toBe('Bearer guest-token');
    expect(headers.get('x-client-session')).toBe('sid-1');
    expect(headers.get('cookie')).toBeNull();
  });

  it('relays an upstream error instead of opening a stream', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'rate_limit_exceeded' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = await post();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limit_exceeded' });
  });

  it('rejects a request with no valid session', async () => {
    mocks.verifySession.mockResolvedValue({ ok: false, reason: 'expired' });
    const res = await post();
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the API base is not configured', async () => {
    delete process.env.API_URL;
    const res = await post();
    expect(res.status).toBe(503);
  });
});
