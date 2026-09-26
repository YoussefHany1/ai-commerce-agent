import { NextResponse, type NextRequest } from 'next/server';
import { verifySessionCookieShape } from '@/lib/server/session-edge';

/**
 * Per-request CSP nonce.
 *
 * A strict `script-src` cannot use 'unsafe-inline' because the theme/locale
 * bootstrap in `app/layout.tsx` and Next's own hydration payload are inline
 * scripts. A nonce lets both run while keeping `script-src` free of
 * 'unsafe-inline', so an injected inline script still cannot execute.
 *
 * Two headers have to carry this, and they serve different consumers:
 *
 *  - `content-security-policy` is what Next itself parses. It reads the nonce
 *    out of the request's CSP header and stamps it on every script it emits.
 *  - `x-nonce` is our own convention, read by `app/layout.tsx` so the theme
 *    and locale bootstrap script can carry the same nonce. Next never looks at
 *    it.
 *
 * Setting only the response CSP looks correct and silently breaks hydration:
 * Next emits scripts with no nonce while the browser enforces a script-src
 * containing a nonce source, and under CSP3 the presence of a nonce source
 * makes 'self' be ignored. Every script is then blocked - the HTML paints and
 * nothing executes.
 */
function mintNonce(): string {
  // Web Crypto, not node:crypto: this file runs in the Edge runtime, where the
  // node: builtins are not all available. A 128-bit value keeps the nonce
  // unguessable, which is the property CSP nonces actually depend on.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function csp(nonce: string): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonced Next bootstrap load the hashed chunks it
    // needs without enumerating them in the policy. Browsers that do not support
    // it fall back to the 'self' entry.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Tailwind and React inline `style` attributes both need this; style-src is
    // not where XSS executes, so 'unsafe-inline' here is an accepted trade.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src ' + "'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    // Every data call is a same-origin request to this app's own /api proxy
    // (see lib/api.ts), so no third-party origin belongs here. This is what
    // stops a stolen session from being exfiltrated to an attacker's host.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** The nonce embedded in a policy built by `csp`, for handing to app/layout.tsx. */
function nonceIn(policy: string): string {
  return /'nonce-([A-Za-z0-9+/_-]+={0,2})'/.exec(policy)?.[1] ?? '';
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

/**
 * HSTS is gated on the request actually arriving over TLS, not on NODE_ENV.
 *
 * NODE_ENV is `production` in the local docker-compose stack too, and that one
 * serves plain http — a browser would then pin localhost to https and break the
 * dev loop. A browser also ignores HSTS delivered over http, so keying off the
 * protocol costs nothing when TLS terminates at the edge.
 */
function hsts(request: NextRequest): string | null {
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  return proto === 'https' ? 'max-age=63072000; includeSubDomains' : null;
}

function applyHeaders(res: NextResponse, request: NextRequest, policy: string): NextResponse {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  const strict = hsts(request);
  if (strict) res.headers.set('Strict-Transport-Security', strict);
  res.headers.set('Content-Security-Policy', policy);
  return res;
}

/**
 * Sends signed-out visitors to the login page before any dashboard page or data
 * request is served, and attaches the security headers to every response.
 *
 * The session check here is structural and expiry-only - see
 * `lib/server/session-edge.ts` for why the Edge runtime verifies no signature.
 * The Node-runtime proxy under app/api is the authoritative gate: it checks the
 * HMAC and the operator session epoch on every data request, so a forged or
 * revoked cookie reaches a dashboard shell whose first request fails with 401,
 * and nothing is served on the strength of this check.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const policy = csp(mintNonce());
  const requestHeaders = new Headers(request.headers);
  // The request-side CSP is what Next parses to nonce its own scripts; the
  // response-side copy in applyHeaders is what the browser enforces. Both must
  // carry the same policy, or the browser enforces a nonce no script holds.
  requestHeaders.set('content-security-policy', policy);
  // Read by app/layout.tsx for our own bootstrap script, which Next does not tag.
  requestHeaders.set('x-nonce', nonceIn(policy));

  const isDashboard = request.nextUrl.pathname.startsWith('/dashboard');
  const token = request.cookies.get('aca_session')?.value;
  if (!isDashboard || verifySessionCookieShape(token).ok) {
    return applyHeaders(
      NextResponse.next({ request: { headers: requestHeaders } }),
      request,
      policy,
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  // Preserved so the login page can return the operator to where they were headed.
  if (request.nextUrl.pathname !== '/') url.searchParams.set('next', request.nextUrl.pathname);
  return applyHeaders(NextResponse.redirect(url), request, policy);
}

export const config = {
  matcher: [
    // Everything except Next's own static output, so the nonce is available to
    // the root layout on the login page as well as the dashboard.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
