/**
 * Outbound HTTP with a hard deadline.
 *
 * A bare `fetch` has no timeout. If the peer accepts the connection and then
 * goes silent — a half-open TCP session, a proxy that never forwards, an
 * upstream that stalls — the promise never settles. Inside a worker that is
 * worse than a failed call, because the worker's Redis lease is renewed for as
 * long as the call is outstanding: one hung request takes that worker out of
 * service across every replica, and pins a `postgres` connection from the
 * `max: 10` pool for the same duration.
 *
 * `AbortSignal.timeout` also covers the response-body read, which an
 * AbortController wired only around `fetch` itself would miss.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Long enough for a bulk catalog page from a slow merchant API. */
export const LONG_TIMEOUT_MS = 30_000;

export class UpstreamTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`upstream_timeout after ${timeoutMs}ms: ${redactUrl(url)}`);
    this.name = 'UpstreamTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Strips the query string before a URL reaches a log line or an error message.
 *
 * OAuth callbacks carry the code and state in the query, and several merchant
 * APIs accept an API key as a query parameter, so an unredacted URL in a log is
 * a credential leak.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException. Normalising
    // it here keeps every call site's catch block from having to know that.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new UpstreamTimeoutError(url, timeoutMs);
    }
    throw err;
  }
}
