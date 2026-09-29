import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/server/session';
import {
  buildUpstreamHeaders,
  isAllowed,
  MAX_BODY_BYTES,
  normalizeApiPath,
  type UpstreamPrincipal,
} from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

/**
 * Methods that may carry a body.
 *
 * DELETE is included because the API takes a `storeId` body on delete routes
 * (e.g. DELETE /automation/rules/:id) and the client sends it. Excluding DELETE
 * silently dropped the body, so the upstream parsed `req.body ?? {}` and failed
 * validation on every call. Including it also means a bodied DELETE must send
 * application/json, which extends the CSRF property below to DELETE. PATCH is
 * included the same way for the account status route.
 */
const BODIED = new Set<Method>(['POST', 'PUT', 'PATCH', 'DELETE']);

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status });
}

function apiBase(): string | null {
  const base = process.env.API_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

/**
 * Reads the body, refusing anything over the cap.
 *
 * The declared Content-Length is rejected before a single byte is buffered, and the
 * stream is then capped as it is read so a chunked request that understates its
 * length still cannot grow unbounded here.
 */
async function readBody(request: Request): Promise<{ ok: true; body: ArrayBuffer } | { ok: false }> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) return { ok: false };
    if (size > MAX_BODY_BYTES) return { ok: false };
  }

  if (!request.body) return { ok: true, body: new ArrayBuffer(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: body.buffer };
}

async function handler(request: Request, ctx: { params: Promise<{ path?: string[] }> }): Promise<NextResponse> {
  const method = request.method.toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const base = apiBase();
  if (!base) return json({ error: 'upstream_not_configured' }, 503);

  // Authoritative session check: signature, expiry, and the session epoch.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session.ok) {
    console.log('[api-proxy] session validation failed:', session.reason, 'for path:', apiPath);
    if (session.reason === 'unavailable') return json({ error: 'auth_unavailable' }, 503);
    // `session_expired`, not `unauthorized`: the upstream's own key rejection uses
    // the same `unauthorized` body (src/lib/auth.ts), and a relayed upstream 401
    // would otherwise be indistinguishable from a dead session. The client reads
    // this code to decide whether to send the session holder back to /login, so a
    // misconfigured proxy surfaces as a server error instead of a login loop.
    return json({ error: 'session_expired' }, 401);
  }

  // The cookie's kind decides which credential the upstream sees, and both are the
  // session id from the cookie — the proxy holds no wider credential for either. An
  // operator's `sid` is forwarded in `x-operator-session`, not as the admin key, so the
  // API resolves a person and the browser session stays revocable on its own.
  const principal: UpstreamPrincipal = {
    kind: session.payload.kind,
    sid: session.payload.sid!,
  };

  const { path } = await ctx.params;
  const apiPath = normalizeApiPath(path);
  if (!apiPath) return json({ error: 'not_found' }, 404);

  if (!isAllowed(method, apiPath.slice('/api'.length))) {
    return json({ error: 'not_found' }, 404);
  }

  let body: ArrayBuffer | null = null;
  if (BODIED.has(method as Method)) {
    // A bodied method may still legitimately send nothing: DELETE /stores/:id
    // takes its identifier from the path. Only when the request actually carries
    // content is JSON mandatory, and that requirement is a CSRF layer — a
    // cross-origin HTML form can produce urlencoded or multipart, never
    // application/json, so a form cannot forge these calls.
    const contentType = request.headers.get('content-type');
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    // `content-length: 0` is an explicit empty body, not a declared one, so it
    // must not drag a bodyless request into the JSON requirement.
    const declaresBody =
      contentType !== null ||
      (Number.isFinite(contentLength) && contentLength > 0) ||
      request.headers.get('transfer-encoding') !== null;

    if (declaresBody) {
      if (!contentType?.toLowerCase().startsWith('application/json')) {
        return json({ error: 'unsupported_media_type' }, 415);
      }
      const read = await readBody(request);
      if (!read.ok) return json({ error: 'payload_too_large' }, 413);
      body = read.body;
    }
  }

  const target = new URL(`${base}${apiPath}`);
  target.search = new URL(request.url).search;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: buildUpstreamHeaders(request.headers, body ? 'application/json' : null, principal),
      body,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return json({ error: 'upstream_unreachable' }, 502);
  }

  const payload = await upstream.text();
  const contentType = upstream.headers.get('content-type');
  const location = upstream.headers.get('location');

  return new NextResponse(payload, {
    status: upstream.status,
    headers: {
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(location ? { location } : {}),
      'cache-control': 'no-store',
    },
  });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
