import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

/**
 * Regression cover for the per-request CSP nonce.
 *
 * Next does not read an `x-nonce` header. It parses the nonce out of the
 * `content-security-policy` REQUEST header (see next/dist/server/app-render/
 * get-script-nonce-from-header.js, which is handed `headers['content-security-policy']`
 * by app-render) and stamps it onto every script it emits. If the policy is only
 * on the response, Next emits no nonces while the browser enforces a script-src
 * that contains a nonce source - and under CSP3 the presence of a nonce source
 * makes 'self' be ignored. Every script is then blocked: the HTML paints and
 * nothing executes, so the dashboard silently ships dead.
 *
 * These assertions are on the plumbing rather than on rendered HTML, which is
 * what let this regress in the first place - CI only ever checked the HTTP
 * status of /login, never whether the scripts carried a nonce.
 */

/** Header names Next uses to hand forwarded request headers back to its server. */
const OVERRIDE_LIST = 'x-middleware-override-headers';
const overridePrefix = 'x-middleware-request-';

/** NextRequest narrows RequestInit (its `signal` is not nullable), so borrow its type. */
type NextInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init: NextInit = {}, origin = 'https://dashboard.example'): NextRequest {
  return new NextRequest(`${origin}${path}`, init);
}

/** The policy Next would parse to nonce its scripts, or undefined if none was forwarded. */
function forwardedPolicy(res: Response): string | null {
  const overridden = res.headers.get(OVERRIDE_LIST);
  if (!overridden?.split(',').includes('content-security-policy')) return null;
  return res.headers.get(`${overridePrefix}content-security-policy`);
}

/** The value app/layout.tsx reads via headers().get('x-nonce'). */
function forwardedLayoutNonce(res: Response): string | null {
  const overridden = res.headers.get(OVERRIDE_LIST);
  if (!overridden?.split(',').includes('x-nonce')) return null;
  return res.headers.get(`${overridePrefix}x-nonce`);
}

function nonceIn(policy: string | null): string | null {
  return policy?.match(/'nonce-([A-Za-z0-9+/_-]+={0,2})'/)?.[1] ?? null;
}

describe('proxy CSP nonce plumbing', () => {
  it('forwards the policy to Next on the request, not only on the response', async () => {
    const res = await proxy(request('/login'));

    // The half that was missing: without this, Next never learns the nonce.
    expect(forwardedPolicy(res)).toBeTruthy();
    expect(nonceIn(forwardedPolicy(res))).toBeTruthy();
  });

  it('uses one nonce for both the forwarded request and the enforced response', async () => {
    const res = await proxy(request('/login'));

    // A mismatch would enforce a nonce that no emitted script holds, which
    // fails exactly like having no nonce at all.
    expect(nonceIn(forwardedPolicy(res))).toBe(nonceIn(res.headers.get('Content-Security-Policy')));
  });

  it('forwards the nonce to app/layout.tsx as x-nonce', async () => {
    // The theme/locale bootstrap in app/layout.tsx is ours, so Next does not tag
    // it. The layout reads it back out of headers().get('x-nonce'); drop this
    // header and that one script renders with nonce="" and gets blocked.
    const res = await proxy(request('/login'));

    expect(forwardedLayoutNonce(res)).toBe(nonceIn(res.headers.get('Content-Security-Policy')));
    expect(forwardedLayoutNonce(res)).toBeTruthy();
  });

  it('mints a fresh nonce per request', async () => {
    const [a, b] = await Promise.all([proxy(request('/login')), proxy(request('/login'))]);

    expect(nonceIn(a.headers.get('Content-Security-Policy'))).toBeTruthy();
    expect(nonceIn(a.headers.get('Content-Security-Policy'))).not.toBe(
      nonceIn(b.headers.get('Content-Security-Policy')),
    );
  });

  it('keeps strict-dynamic and never falls back to unsafe-inline', async () => {
    const res = await proxy(request('/login'));
    const scriptSrc = res.headers
      .get('Content-Security-Policy')!
      .split(';')
      .find((d) => d.trim().startsWith('script-src'))!;

    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('forwards the policy on the dashboard redirect too', async () => {
    // The signed-out branch returns a redirect rather than NextResponse.next(),
    // so it takes a different path through applyHeaders.
    const res = await proxy(request('/dashboard/stores'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(nonceIn(res.headers.get('Content-Security-Policy'))).toBeTruthy();
  });

  it('keeps the baseline security headers on every response', async () => {
    const res = await proxy(request('/login'));

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('adds HSTS only when the request actually arrived over TLS', async () => {
    // Plain http must not be pinned, or the local compose loop would break.
    const plain = await proxy(request('/login', {}, 'http://dashboard.example'));
    const secure = await proxy(request('/login', { headers: { 'x-forwarded-proto': 'https' } }));

    expect(plain.headers.get('Strict-Transport-Security')).toBeNull();
    expect(secure.headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
  });
});
