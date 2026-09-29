import 'server-only';

/**
 * Allowlist of upstream API routes the dashboard proxy will forward.
 *
 * This is a method-and-path allowlist, not a path prefix match. Every `GET` here
 * was audited and is read-only: the only state-changing `GET` endpoints in the
 * codebase are the OAuth `start` routes (which write a Redis nonce) and the OAuth
 * callbacks (which write tenant rows), and neither is reachable from the browser —
 * the dashboard links to them directly on the API origin, where the backend's own
 * `redirect_uri` handling keeps the flow on that origin.
 *
 * Deliberately absent:
 *   - the oauth routes       browser navigations, not XHR; proxied redirects break
 *   - the pdpl routes        data export and erasure are back-office operations
 *   - the webhooks routes    platform callbacks with their own HMAC verification
 *   - the auth routes        the operator login verifier, called server-to-server only
 *   - the legacy dashboard   a static page served by the API process
 */
const ALLOWLIST: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/health$/ },
  { method: 'GET', pattern: /^\/stores$/ },
  { method: 'POST', pattern: /^\/stores$/ },
  { method: 'DELETE', pattern: /^\/stores\/[^/]+$/ },
  { method: 'GET', pattern: /^\/products\/[^/]+$/ },
  { method: 'POST', pattern: /^\/session$/ },
  { method: 'POST', pattern: /^\/chat$/ },
  { method: 'POST', pattern: /^\/attributions\/click$/ },
  { method: 'GET', pattern: /^\/metrics\/[^/]+$/ },
  { method: 'GET', pattern: /^\/analytics\/[^/]+\/attributions$/ },
  { method: 'GET', pattern: /^\/analytics\/[^/]+\/sources$/ },
  { method: 'GET', pattern: /^\/analytics\/[^/]+\/top-products$/ },
  { method: 'GET', pattern: /^\/analytics\/[^/]+\/conversion-lag$/ },
  { method: 'GET', pattern: /^\/billing\/status\/[^/]+$/ },
  { method: 'POST', pattern: /^\/billing\/checkout$/ },
  { method: 'POST', pattern: /^\/billing\/portal$/ },
  { method: 'GET', pattern: /^\/whatsapp\/channels$/ },
  { method: 'POST', pattern: /^\/whatsapp\/channels$/ },
  { method: 'GET', pattern: /^\/automation\/rules\/[^/]+$/ },
  { method: 'POST', pattern: /^\/automation\/rules$/ },
  { method: 'PUT', pattern: /^\/automation\/rules\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/automation\/rules\/[^/]+$/ },
  { method: 'POST', pattern: /^\/automation\/run$/ },
  { method: 'GET', pattern: /^\/jobs\/[^/]+$/ },
  { method: 'POST', pattern: /^\/jobs\/[^/]+\/retry$/ },
  // Operator account admin. The API still enforces the admin key on these, so a
  // client session proxied here gets the API's own 401 `unauthorized` rather than
  // any data.
  { method: 'GET', pattern: /^\/clients$/ },
  { method: 'POST', pattern: /^\/clients$/ },
  { method: 'PATCH', pattern: /^\/clients\/[^/]+\/status$/ },
  { method: 'POST', pattern: /^\/clients\/[^/]+\/reset-password$/ },
];

/**
 * Largest request body forwarded upstream. The biggest legitimate payload is a
 * chat message (capped at 2000 characters server-side) or an automation rule, so
 * this is generous while keeping an oversized body from being buffered here.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * A single path segment: unreserved URL characters only, and never a relative
 * navigation token.
 *
 * `..` matches a naive `[A-Za-z0-9._~-]+` and would let a request rewrite the path
 * the upstream request is built from — `new URL()` collapses `/api/../stores` to
 * `/stores`, stepping outside the `/api` prefix the allowlist was checked against.
 * Separators are rejected per segment for the same reason: decoding `%2f` must not
 * be able to split one catch-all segment into two.
 */
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

function isSafeSegment(segment: string): boolean {
  if (!PATH_SEGMENT.test(segment)) return false;
  if (segment === '.' || segment === '..') return false;
  // Defensive: the character class already excludes these, but a segment that is
  // only dots is relative navigation in every encoding.
  if (/^\.+$/.test(segment)) return false;
  return true;
}

export function isAllowed(method: string, apiPath: string): boolean {
  return ALLOWLIST.some((rule) => rule.method === method && rule.pattern.test(apiPath));
}

/** Test seam: the effective allowlist, for asserting coverage in tests. */
export function allowlistRules(): ReadonlyArray<{ method: string; pattern: RegExp }> {
  return ALLOWLIST;
}

/**
 * Splits a catch-all param into a validated `/api/...` path.
 *
 * Returns null for anything that is not a plain sequence of safe segments. This is
 * what stops `..` traversal, absolute URLs, and encoded separators from being used
 * to reach an origin other than the configured API base.
 */
/**
 * Turns a catch-all param into the upstream path to request.
 *
 * `segments` is the part of the URL *below* `/api` — Next strips the route's own
 * `api` folder from the catch-all, so `/api/stores` arrives as `['stores']` and the
 * `/api` prefix is re-attached here. The result always starts `/api/`, which is what
 * the allowlist patterns and the URL builder both expect.
 */
export function normalizeApiPath(segments: string[] | undefined): string | null {
  if (!segments || segments.length === 0) return null;

  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      // A malformed percent-escape is a rejection, not something to pass through.
      return null;
    }
    if (!isSafeSegment(value)) return null;
    decoded.push(value);
  }

  return `/api/${decoded.join('/')}`;
}

/**
 * Which credential the proxy presents to the API for this request.
 *
 * The operator presentation is the admin API key, attached server-side and never
 * seen by the browser. A client session presents the raw session id it holds in
 * its signed cookie, forwarded as `x-client-session`; the API is authoritative
 * for it (Redis liveness + account status), so the proxy hands over only enough
 * to authenticate, never a credential with wider scope than the cookie's owner.
 * A client must never be proxied with the admin key, so the two presentations
 * are mutually exclusive by construction.
 */
export type UpstreamPrincipal =
  | { kind: 'operator' }
  | { kind: 'client'; sid: string };

/**
 * Builds the upstream request headers.
 *
 * The operator's API key is attached here and nowhere else — it is read from a
 * server-only environment variable and never reaches the browser. A client
 * request swaps it for `x-client-session`, so a client's every data call is
 * scoped by the API to exactly the account it belongs to. Any inbound
 * `x-api-key`, `x-client-session` or `cookie` is dropped so a caller cannot
 * inject or override credentials. `authorization` is forwarded because the
 * customer-facing chat and session endpoints authenticate with a bearer token
 * rather than the operator key; no operator-guarded route in the allowlist reads
 * that header.
 *
 * `x-forwarded-for` is deliberately not forwarded. A Next route handler has no
 * trustworthy socket address, so any value available here is client-asserted, and
 * relaying it would let a caller mint a fresh per-IP rate-limit bucket per request.
 * Omitting it means the API sees this service's egress address, which is
 * spoof-proof. The trade-off is documented in DEPLOYMENT.md.
 */
export function buildUpstreamHeaders(
  incoming: Headers,
  contentType: string | null,
  principal: UpstreamPrincipal,
): Headers {
  const headers = new Headers();
  if (principal.kind === 'operator') {
    headers.set('x-api-key', requireApiKey());
  } else {
    headers.set('x-client-session', principal.sid);
  }

  if (contentType) headers.set('content-type', contentType);

  const authorization = incoming.get('authorization');
  if (authorization) headers.set('authorization', authorization);

  return headers;
}

function requireApiKey(): string {
  const key = process.env.ADMIN_API_KEY;
  if (!key) {
    throw new Error('ADMIN_API_KEY is not configured on the web service — the proxy cannot authenticate');
  }
  return key;
}
