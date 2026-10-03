import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An SSE body that yields the given frames. */
function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.chatStream', () => {
  it('mints a session, then parses products, deltas, and the done reply', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        if (url.endsWith('/api/session')) return jsonResponse({ token: 'tok', conversationId: 'c1' });
        return sseResponse([
          'data: {"type":"products","products":[{"id":"p1","title":"Serum","price":10,"currency":"SAR"}]}\n\n',
          'data: {"type":"delta","delta":"مرح"}\n\n',
          'data: {"type":"delta","delta":"با"}\n\n',
          'data: {"type":"done","reply":"مرحبا"}\n\n',
        ]);
      }),
    );

    let streamed = '';
    const seenProducts: string[] = [];
    const res = await api.chatStream('s1', 'hi', {
      onProducts: (products) => seenProducts.push(...products.map((p) => p.id)),
      onDelta: (delta) => {
        streamed += delta;
      },
    });

    expect(res.reply).toBe('مرحبا');
    expect(res.token).toBe('tok');
    expect(res.products.map((p) => p.id)).toEqual(['p1']);
    expect(streamed).toBe('مرحبا');
    expect(seenProducts).toEqual(['p1']);

    expect(calls[1]!.url).toBe('/api/chat/stream');
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.accept).toBe('text/event-stream');
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('raises an ApiError when the stream reports an error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/session')) return jsonResponse({ token: 'tok', conversationId: 'c1' });
        return sseResponse(['data: {"type":"error","message":"agent_error"}\n\n']);
      }),
    );

    await expect(api.chatStream('s1', 'hi', {})).rejects.toBeInstanceOf(ApiError);
  });
});
