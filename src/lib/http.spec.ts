import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchWithTimeout, UpstreamTimeoutError, DEFAULT_TIMEOUT_MS } from './http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchWithTimeout', () => {
  it('passes an AbortSignal so the request cannot hang forever', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await fetchWithTimeout('https://example.com/x', { method: 'POST' });
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the response untouched on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 201 }));
    const res = await fetchWithTimeout('https://example.com/x');
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('aborts a hanging request and normalises the rejection', async () => {
    // A real hang, not a mock: a server that accepts and never responds is the
    // exact case that used to pin a worker lease open indefinitely.
    const server = await import('node:http').then((http) =>
      http.createServer(() => {
        /* deliberately never responds */
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      await expect(fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 150)).rejects.toThrow(UpstreamTimeoutError);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  it('does not mask a non-timeout network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchWithTimeout('https://example.com/x')).rejects.toThrow(TypeError);
  });

  it('keeps the query string out of the timeout error message', async () => {
    const err = new UpstreamTimeoutError('https://shop.example.com/admin/oauth/access_token?code=SECRET&hmac=SECRET2', 100);
    expect(err.message).not.toContain('SECRET');
    expect(err.message).toContain('/admin/oauth/access_token');
  });

  it('degrades gracefully when the url is not parseable', () => {
    const err = new UpstreamTimeoutError('not a url?token=abc', 100);
    expect(err.message).not.toContain('abc');
  });
});

describe('timeouts', () => {
  it('defaults to a bounded value', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
