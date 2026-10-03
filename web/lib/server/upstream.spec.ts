import { describe, expect, it } from 'vitest';
import { isAllowed, normalizeApiPath, buildUpstreamHeaders, MAX_BODY_BYTES } from './upstream';

/**
 * Every (method, path) pair the dashboard client actually issues, mirrored from the
 * `api` object in `web/lib/api.ts`.
 *
 * This table is the point of the file: the proxy answers 404 for anything not on the
 * allowlist, so a call site added to the client without a matching rule would fail
 * at runtime with no type error. `clientCallSitesAreAllowed` fails here instead.
 */
const CLIENT_CALL_SITES: ReadonlyArray<[string, string]> = [
  ['GET', '/health'],
  ['GET', '/stores'],
  ['POST', '/stores'],
  ['DELETE', '/stores/abc123'],
  ['GET', '/products/abc123'],
  ['POST', '/session'],
  ['POST', '/chat'],
  ['POST', '/attributions/click'],
  ['GET', '/metrics/abc123'],
  ['GET', '/analytics/abc123/attributions'],
  ['GET', '/analytics/abc123/sources'],
  ['GET', '/analytics/abc123/top-products'],
  ['GET', '/analytics/abc123/conversion-lag'],
  ['GET', '/billing/status/abc123'],
  ['POST', '/billing/checkout'],
  ['POST', '/billing/portal'],
  ['GET', '/whatsapp/channels'],
  ['POST', '/whatsapp/channels'],
  // QR pairing. `/whatsapp/qr-stream` is intentionally absent — it bypasses this
  // proxy via web/app/api/whatsapp/qr-stream/route.ts, which pipes the SSE body
  // through instead of buffering it.
  // No query string here: CLIENT_CALL_SITES is fed to normalizeApiPath(), which sees
  // path segments only. The `?storeId=` in api.ts is applied after that.
  ['GET', '/whatsapp/qr-status'],
  ['POST', '/whatsapp/qr-connect'],
  ['POST', '/whatsapp/qr-pair-code'],
  ['POST', '/whatsapp/qr-acknowledge'],
  ['DELETE', '/whatsapp/qr-disconnect'],
  ['GET', '/automation/rules/abc123'],
  ['POST', '/automation/rules'],
  ['PUT', '/automation/rules/rule1'],
  ['DELETE', '/automation/rules/rule1'],
  ['POST', '/automation/run'],
  ['GET', '/jobs/abc123'],
  ['POST', '/jobs/job1/retry'],
  ['GET', '/clients'],
  ['POST', '/clients'],
  ['PATCH', '/clients/abc123/status'],
  ['POST', '/clients/abc123/reset-password'],
  ['GET', '/stores/abc123/embed-key'],
  ['POST', '/stores/abc123/embed-key'],
];

const OPERATOR: { kind: 'operator'; sid: string } = { kind: 'operator', sid: 'operator-sid-1' };
const CLIENT: { kind: 'client'; sid: string } = { kind: 'client', sid: 'client-sid-1' };

describe('client call sites', () => {
  it.each(CLIENT_CALL_SITES)('allows %s %s', (method, path) => {
    expect(isAllowed(method, path)).toBe(true);
  });
});

describe('isAllowed', () => {
  it('rejects an unknown path', () => {
    expect(isAllowed('GET', '/unknown')).toBe(false);
  });

  it('rejects the wrong method on an allowed path', () => {
    expect(isAllowed('GET', '/automation/run')).toBe(false);
    expect(isAllowed('DELETE', '/chat')).toBe(false);
    expect(isAllowed('POST', '/stores')).toBe(true);
  });

  it('does not let a path segment stand in for a prefix', () => {
    expect(isAllowed('GET', '/stores/abc/keys')).toBe(false);
    expect(isAllowed('GET', '/metrics/abc/extra')).toBe(false);
  });

  it('rejects a second segment appended to a single-segment path', () => {
    expect(isAllowed('GET', '/health/../stores')).toBe(false);
  });

  it.each([
    ['GET', '/oauth/shopify/start'],
    ['GET', '/oauth/shopify/callback'],
    ['POST', '/pdpl/export'],
    ['POST', '/webhooks/shopify'],
    // Every auth route is server-to-server only: the browser reaches the API's
    // unauthenticated auth endpoints through dedicated BFF routes, and the API no
    // longer has an `operator/verify` for the shared password it replaced.
    ['POST', '/auth/operator/login'],
    ['POST', '/auth/operator/verify'],
    ['POST', '/auth/client/login'],
    ['POST', '/auth/exchange'],
    ['POST', '/auth/logout'],
    // The widget mints its own customer session from a public key, from the
    // merchant's own origin. It has no BFF cookie to present, so proxying it would
    // just fail — and allowing it would mean the dashboard's session header could be
    // used to reach a route designed to be called with a key instead.
    ['POST', '/widget/session'],
  ])('excludes the sensitive %s %s route', (method, path) => {
    expect(isAllowed(method, path)).toBe(false);
  });

  it('exposes only the client-admin operations the dashboard uses', () => {
    // Account admin is operator-only at the API; the allowlist mirrors exactly the
    // page's surfaces and no more (no per-client store attach here).
    expect(isAllowed('GET', '/clients')).toBe(true);
    expect(isAllowed('GET', '/clients/abc123')).toBe(false);
    expect(isAllowed('POST', '/clients/abc123/stores')).toBe(false);
    expect(isAllowed('DELETE', '/clients/abc123/stores/store1')).toBe(false);
    expect(isAllowed('PATCH', '/clients/abc123/status')).toBe(true);
    expect(isAllowed('POST', '/clients/abc123/reset-password')).toBe(true);
    expect(isAllowed('PATCH', '/clients')).toBe(false);
  });

  it('rejects a state-changing route reached over GET', () => {
    // The oauth start handlers write a Redis nonce; allowing them over GET would let
    // a cross-site image tag drive a state change.
    expect(isAllowed('GET', '/oauth/shopify/start')).toBe(false);
    expect(isAllowed('POST', '/oauth/shopify/start')).toBe(false);
  });

  it('matches a rule anchored to the whole path, not a prefix', () => {
    expect(isAllowed('GET', '/stores')).toBe(true);
    expect(isAllowed('GET', '/stores-evil')).toBe(false);
    expect(isAllowed('DELETE', '/stores/abc123/extra')).toBe(false);
  });
});

describe('normalizeApiPath', () => {
  it('builds a path from safe segments', () => {
    // The catch-all param is the part below /api: Next strips the route's own `api`
    // folder, so `/api/stores` arrives as ['stores'] and the prefix is re-attached.
    expect(normalizeApiPath(['stores'])).toBe('/api/stores');
    expect(normalizeApiPath(['analytics', 'abc', 'top-products'])).toBe(
      '/api/analytics/abc/top-products',
    );
  });

  it('always produces a path under /api', () => {
    for (const segments of [['stores'], ['health'], ['a', 'b'], ['x-1.2_3~4']]) {
      expect(normalizeApiPath(segments)?.startsWith('/api/')).toBe(true);
    }
  });

  it('round-trips every allowlisted client call site to the path the proxy builds', () => {
    // The table stores paths relative to /api, which is what isAllowed matches. A
    // request arriving as a catch-all param must normalize back to the same path, or
    // the rule that passed above would never be reached at runtime.
    for (const [method, apiPath] of CLIENT_CALL_SITES) {
      const normalized = normalizeApiPath(apiPath.split('/').filter(Boolean));
      expect(normalized, `normalizing ${apiPath}`).toBe(`/api${apiPath}`);
      expect(isAllowed(method, normalized!.slice('/api'.length)), `${method} ${apiPath}`).toBe(true);
    }
  });

  it('rejects traversal in plain and encoded form', () => {
    // `new URL()` collapses a relative segment, so one that survived normalization
    // could step outside the `/api` prefix the allowlist was checked against.
    expect(normalizeApiPath(['..', 'stores'])).toBeNull();
    expect(normalizeApiPath(['.', 'stores'])).toBeNull();
    expect(normalizeApiPath(['...', 'stores'])).toBeNull();
    expect(normalizeApiPath(['%2e%2e', 'stores'])).toBeNull();
    expect(normalizeApiPath(['..%2f..%2fetc', 'passwd'])).toBeNull();
  });

  it('rejects an absolute URL smuggled through a segment', () => {
    // `http:` and the empty segment are both refused, so a target origin cannot be
    // appended after the configured base.
    expect(normalizeApiPath(['http:', '', 'evil.test'])).toBeNull();
    // Normalization only makes a path structurally safe; the allowlist is the gate
    // that decides whether the dashboard may call it.
    expect(normalizeApiPath(['evil.test'])).toBe('/api/evil.test');
    expect(isAllowed('GET', '/evil.test')).toBe(false);
  });

  it('rejects separators and whitespace inside a segment', () => {
    expect(normalizeApiPath(['a/b'])).toBeNull();
    expect(normalizeApiPath(['a\\b'])).toBeNull();
    expect(normalizeApiPath(['a b'])).toBeNull();
    expect(normalizeApiPath(['a b'])).toBeNull();
  });

  it('rejects an empty or missing catch-all', () => {
    expect(normalizeApiPath(undefined)).toBeNull();
    expect(normalizeApiPath([])).toBeNull();
  });

  it('rejects a malformed percent-escape rather than passing it through', () => {
    expect(normalizeApiPath(['%zz'])).toBeNull();
  });

  it('allows the unreserved characters a UUID id is made of', () => {
    expect(normalizeApiPath(['stores', '9f8e7d6c-5b4a-3210-fedc-ba9876543210'])).toBe(
      '/api/stores/9f8e7d6c-5b4a-3210-fedc-ba9876543210',
    );
  });
});

describe('buildUpstreamHeaders', () => {
  it('presents an operator session, not the admin key', () => {
    // The proxy holds a person, not a machine. A stolen operator cookie must not be
    // worth more than the operator it belonged to.
    const headers = buildUpstreamHeaders(new Headers(), null, OPERATOR);
    expect(headers.get('x-operator-session')).toBe('operator-sid-1');
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('x-client-session')).toBeNull();
  });

  it('does not read ADMIN_API_KEY even when the environment sets one', () => {
    // Deliberate regression guard: the proxy used to attach this for operator requests,
    // which made every browser session a shared machine credential in disguise.
    process.env.ADMIN_API_KEY = 'server-side-key';
    try {
      expect(buildUpstreamHeaders(new Headers(), null, OPERATOR).get('x-api-key')).toBeNull();
    } finally {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it('drops a caller-supplied x-api-key rather than replacing it with its own', () => {
    const incoming = new Headers({ 'x-api-key': 'attacker-chosen' });
    expect(buildUpstreamHeaders(incoming, null, OPERATOR).get('x-api-key')).toBeNull();
  });

  it('discards cookies so no session material is relayed upstream', () => {
    const incoming = new Headers({ cookie: 'aca_session=stolen' });
    expect(buildUpstreamHeaders(incoming, null, OPERATOR).get('cookie')).toBeNull();
  });

  it('proxies a client with x-client-session and never an operator header', () => {
    const incoming = new Headers({ 'x-api-key': 'attacker-chosen', cookie: 'aca_session=stolen' });
    const headers = buildUpstreamHeaders(incoming, null, CLIENT);
    // A client request must not silently upgrade to an operator presentation even when
    // the key is unset — the presentation is chosen by the verified cookie, not the env.
    expect(headers.get('x-client-session')).toBe('client-sid-1');
    expect(headers.get('x-operator-session')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
  });

  it('drops a caller-supplied session header of either kind rather than relaying it', () => {
    // Otherwise a client could send its own sid in the operator header and have the
    // proxy pass it straight through.
    for (const header of ['x-client-session', 'x-operator-session']) {
      const incoming = new Headers({ [header]: 'forged-sid' });
      const built = buildUpstreamHeaders(incoming, null, OPERATOR);
      expect(built.get(header)).not.toBe('forged-sid');
    }
  });

  it('keeps the two session headers mutually exclusive', () => {
    // One principal per request: the API rejects a request carrying both, and the proxy
    // should never construct one in the first place.
    for (const principal of [OPERATOR, CLIENT]) {
      const headers = buildUpstreamHeaders(new Headers(), null, principal);
      const present = ['x-client-session', 'x-operator-session'].filter((h) => headers.get(h) !== null);
      expect(present).toEqual(
        principal.kind === 'operator' ? ['x-operator-session'] : ['x-client-session'],
      );
    }
  });

  it('forwards a customer bearer token for the session and chat routes', () => {
    const incoming = new Headers({ authorization: 'Bearer customer-token' });
    expect(buildUpstreamHeaders(incoming, null, OPERATOR).get('authorization')).toBe('Bearer customer-token');
  });

  it('does not relay a caller-asserted x-forwarded-for', () => {
    const incoming = new Headers({ 'x-forwarded-for': '1.2.3.4' });
    // A spoofable value here would mint a fresh per-IP rate-limit bucket per request.
    expect(buildUpstreamHeaders(incoming, null, OPERATOR).get('x-forwarded-for')).toBeNull();
  });

  it('sets the content type only when there is a body', () => {
    expect(buildUpstreamHeaders(new Headers(), null, OPERATOR).get('content-type')).toBeNull();
    expect(buildUpstreamHeaders(new Headers(), 'application/json', OPERATOR).get('content-type')).toBe(
      'application/json',
    );
  });
});

describe('MAX_BODY_BYTES', () => {
  it('caps at 256 KiB', () => {
    expect(MAX_BODY_BYTES).toBe(262_144);
  });
});
