/**
 * End-to-end smoke test for the dashboard BFF: runs the built Next standalone
 * server against stub Redis and upstream processes, signs in for real, and asserts
 * what the upstream actually received.
 *
 * Complements the unit tests, which cover path normalization, allowlisting, and
 * cookie signing in isolation. What only this can catch is a mismatch between the
 * route's runtime params and the helpers — the `params.path` shape being the one
 * that actually shipped broken.
 *
 * Run: node scripts/smoke-bff.mjs   (requires `npm run build` in web/ first)
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB_PORT = Number(process.env.SMOKE_WEB_PORT ?? 3391);
const UPSTREAM_PORT = WEB_PORT + 1;
const REDIS_PORT = WEB_PORT + 2;
/** Install-wide operator epoch. One bump logs every operator out. */
const GLOBAL_EPOCH = 'smoke-global-epoch-0001';
/** Per-operator epoch. Moving just this signs one person out. */
const OPERATOR_EPOCH = 'smoke-operator-epoch-0001';
const OPERATOR_ID = 'smoke-operator-0001';
const OPERATOR_SID = 'smoke-operator-sid-0001';
const CLIENT_ID = 'smoke-client-0001';
const CLIENT_EPOCH = 'smoke-client-epoch-0001';
const CLIENT_SID = 'smoke-client-sid-0001';
const SECRET = 'b'.repeat(48);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');

const children = [];
let pass = 0;
let fail = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every request is bounded. Without this a proxy that accepts a connection and
 * never answers hangs the suite forever instead of failing it, and CI just times
 * out with no indication of which assertion stalled.
 */
const REQUEST_TIMEOUT_MS = 10_000;

function call(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await call(url, { redirect: 'manual' });
      return true;
    } catch {
      await sleep(250);
    }
  }
  return false;
}

/**
 * Minimal RESP server: enough for the client handshake and the epoch GET/SET.
 *
 * The parser is positional rather than split-based, because a command can arrive
 * split across TCP segments or batched with the next one, and only a byte-accurate
 * parse handles both. An earlier split-counting version silently stalled on
 * well-formed input, which showed up as a hung test rather than a clear failure.
 */
function startStubRedis() {
  // Every epoch the proxy reads is seeded. A missing per-account key is seeded by the
  // reader with a fresh random value, which would then not match a cookie minted here —
  // so an unseeded key looks exactly like a revoked session, and the harness would be
  // testing the wrong thing.
  const store = new Map([
    ['op:sess:epoch', GLOBAL_EPOCH],
    [`op:sess:epoch:${OPERATOR_ID}`, OPERATOR_EPOCH],
    [`cli:sess:epoch:${CLIENT_ID}`, CLIENT_EPOCH],
  ]);

  /** Returns the command's args, or null when more bytes are needed. */
  function parseCommand(buffer) {
    const crlf = buffer.indexOf('\r\n');
    if (crlf < 0 || buffer[0] !== '*') return null;
    const count = Number(buffer.slice(1, crlf));
    if (!Number.isInteger(count) || count < 1) return null;

    const args = [];
    let at = crlf + 2;
    for (let i = 0; i < count; i++) {
      if (buffer[at] !== '$') return null;
      const lenEnd = buffer.indexOf('\r\n', at);
      if (lenEnd < 0) return null;
      const len = Number(buffer.slice(at + 1, lenEnd));
      const start = lenEnd + 2;
      if (!Number.isInteger(len) || len < 0) return null;
      if (buffer.length < start + len + 2) return null;
      args.push(buffer.slice(start, start + len));
      at = start + len + 2;
    }
    return { args, rest: buffer.slice(at) };
  }

  // Raw TCP, not HTTP: RESP is not a request/response protocol, so this must not be
  // the node:http server used for the upstream stub below.
  const server = createTcpServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const command = parseCommand(buffer);
        if (!command) return;
        buffer = command.rest;
        const command0 = command.args;
        // Only the command name is case-insensitive. Uppercasing the arguments would
        // corrupt the epoch the client seeds, which then fails every valid cookie.
        const cmd = (command0[0] ?? '').toUpperCase();
        const args = command0.slice(1);
        const key = args[0];

        if (cmd === 'PING') socket.write('+PONG\r\n');
        else if (cmd === 'GET') {
          const value = store.get(key);
          socket.write(
            value === undefined ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`,
          );
        } else if (cmd === 'SET') {
          const [k, value, ...flags] = args;
          if (flags.includes('NX') && store.has(k)) socket.write('$-1\r\n');
          else {
            store.set(k, value);
            socket.write('+OK\r\n');
          }
        } else {
          // node-redis sends CLIENT SETINFO and friends during setup; it tolerates
          // errors there, and anything unexpected still fails loudly via a timeout.
          socket.write('-ERR unsupported\r\n');
        }
      }
    });
  });
  return listen(server, REDIS_PORT);
}

/**
 * Reports back exactly what the proxy forwarded, so assertions test behavior.
 *
 * It also implements the two upstream endpoints the dashboard calls directly: the
 * operator and client sign-in exchanges, and the unified token exchange. That is what
 * lets this drive the real login route and use the cookie it issues, instead of only
 * testing cookies minted here.
 *
 * Note what it does NOT receive: this service is started with no ADMIN_API_KEY, and
 * `upstreamEcho` reports `apiKey` so an assertion can prove the proxy never sends one.
 * Sessions travel as a header naming a person, not as a key naming the whole install.
 */
function startStubUpstream() {
  const PASSWORD = 'correct-horse-battery-staple';

  function session(kind, email) {
    return kind === 'operator'
      ? {
          kind: 'operator',
          operatorId: OPERATOR_ID,
          name: 'Smoke Operator',
          email,
          sid: OPERATOR_SID,
          epoch: OPERATOR_EPOCH,
          globalEpoch: GLOBAL_EPOCH,
          expiresIn: 3600,
        }
      : {
          kind: 'client',
          clientId: CLIENT_ID,
          name: 'Smoke Store',
          email,
          sid: CLIENT_SID,
          epoch: CLIENT_EPOCH,
          expiresIn: 3600,
        };
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');

      // Both sign-in endpoints now take an email and a password: there is no shared
      // install-wide operator password left, so an operator is addressed like anyone
      // else and the API decides which table the identity belongs to.
      const loginMatch = /^\/api\/auth\/(operator|client)\/login$/.exec(req.url ?? '');
      if (loginMatch && req.method === 'POST') {
        let password = null;
        let email = null;
        try {
          ({ password, email } = JSON.parse(body));
        } catch {
          /* fall through to the 401 below */
        }
        if (password === PASSWORD) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(session(loginMatch[1], email)));
          return;
        }
        if (password === 'locked-out') {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '42' });
          res.end(JSON.stringify({ error: 'too_many_attempts' }));
          return;
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_credentials' }));
        return;
      }

      if (req.url === '/api/auth/exchange' && req.method === 'POST') {
        // One endpoint for both kinds: the API resolves the token and names the kind, so
        // the BFF never has to guess which cookie to mint.
        let token = null;
        let rotate = false;
        try {
          ({ accessToken: token, rotate } = JSON.parse(body));
        } catch {
          /* fall through to the 401 below */
        }
        if (token === 'client-token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(session('client', 'merchant@example.com')));
          return;
        }
        if (token === 'operator-token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(session('operator', 'operator@example.com')));
          return;
        }
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_credentials' }));
        return;
      }

      if (req.url === '/api/auth/logout' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          apiKey: req.headers['x-api-key'] ?? null,
          operatorSession: req.headers['x-operator-session'] ?? null,
          clientSession: req.headers['x-client-session'] ?? null,
          cookie: req.headers.cookie ?? null,
          authorization: req.headers.authorization ?? null,
          forwardedFor: req.headers['x-forwarded-for'] ?? null,
          bodyBytes: Buffer.concat(chunks).length,
        }),
      );
    });
  });
  return listen(server, UPSTREAM_PORT);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function startWeb() {
  const entry = join(webDir, '.next', 'standalone', 'server.js');
  const child = spawn(process.execPath, [entry], {
    cwd: join(webDir, '.next', 'standalone'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(WEB_PORT),
      HOSTNAME: '127.0.0.1',
      SESSION_SECRET: SECRET,
      // Deliberately NO ADMIN_API_KEY. The proxy authenticates the caller from the
      // session cookie and forwards the session id, so this service has no
      // install-wide credential. Setting one here would let the harness prove the
      // proxy still reads it, which is the opposite of what should hold.
      API_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
      SUPABASE_URL: process.env.SUPABASE_URL ?? 'https://smoke.supabase.co',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? 'smoke-anon-key',
      // The smoke test speaks plain http, where a browser would drop a Secure cookie.
      SESSION_COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.env.VERBOSE && console.error('[web]', String(d).trim()));
  children.push(child);
  return child;
}

function cleanup(servers) {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already exited */
    }
  }
  for (const server of servers) {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
}



function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`         expected ${JSON.stringify(expected)}`);
    console.log(`         actual   ${JSON.stringify(actual)}`);
  }
}

/** Like `check`, but for substring/pattern assertions where the value is not fixed. */
function checkMatch(name, actual, pattern) {
  const ok = typeof actual === 'string' && pattern.test(actual);
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`         expected to match ${pattern}`);
    console.log(`         actual            ${JSON.stringify(actual)}`);
  }
}

/**
 * Mints a v3 operator cookie: `operatorId` and `sid` are both required, and the payload
 * is bound to the per-operator epoch *and* the install-wide one, so a revoke of either
 * scope invalidates it.
 */
function mintCookie(epoch, expSeconds, overrides = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 3,
      kind: 'operator',
      iat: Math.floor(Date.now() / 1000),
      exp: expSeconds,
      operatorId: OPERATOR_ID,
      sid: OPERATOR_SID,
      epoch,
      globalEpoch: GLOBAL_EPOCH,
      ...overrides,
    }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

/** A v3 client cookie, for the merchant-session side of the proxy. */
function mintClientCookie(epoch, expSeconds) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 3,
      kind: 'client',
      iat: Math.floor(Date.now() / 1000),
      exp: expSeconds,
      clientId: CLIENT_ID,
      sid: CLIENT_SID,
      epoch,
      name: 'Smoke Store',
      email: 'merchant@example.com',
    }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

const future = (offset = 3600) => Math.floor(Date.now() / 1000) + offset;

async function main() {
  const servers = [];
  try {
    servers.push(await startStubRedis());
    servers.push(await startStubUpstream());
    startWeb();

    const base = `http://127.0.0.1:${WEB_PORT}`;
    if (!(await waitFor(`${base}/login`))) throw new Error(`web server did not start on ${WEB_PORT}`);

    const good = `aca_session=${mintCookie(OPERATOR_EPOCH, future())}`;
    const goodClient = `aca_session=${mintClientCookie(CLIENT_EPOCH, future())}`;

    console.log('\nsecurity headers');
    {
      const res = await call(`${base}/login`);
      const csp = res.headers.get('content-security-policy') ?? '';
      check('nosniff on the login page', res.headers.get('x-content-type-options'), 'nosniff');
      check('frame options deny', res.headers.get('x-frame-options'), 'DENY');
      check(
        'referrer policy',
        res.headers.get('referrer-policy'),
        'strict-origin-when-cross-origin',
      );
      // The whole point of the nonce: script-src must not carry 'unsafe-inline',
      // otherwise the inline bootstrap in app/layout.tsx is unconstrained.
      checkMatch("script-src excludes 'unsafe-inline'", csp, /script-src/);
      check(
        "script-src has no 'unsafe-inline'",
        /script-src[^;]*'unsafe-inline'/.test(csp),
        false,
      );
      checkMatch('frame-ancestors none', csp, /frame-ancestors 'none'/);
      checkMatch('object-src none', csp, /object-src 'none'/);
      checkMatch('connect-src self only', csp, /connect-src 'self'/);
      checkMatch('nonce present in script-src', csp, /script-src[^;]*'nonce-[0-9a-f]{32}'/);
      // Two responses must not share a nonce, or it stops being per-request.
      const second = (await call(`${base}/login`)).headers.get('content-security-policy') ?? '';
      check('nonce differs per response', csp === second, false);
      // HSTS is gated on TLS; this harness speaks plain http, so it must be absent.
      check('no HSTS over plain http', res.headers.get('strict-transport-security'), null);
    }

    console.log('\nunauthenticated');
    check('no cookie -> 401', (await call(`${base}/api/stores`)).status, 401);
    check(
      'forged cookie -> 401',
      (await call(`${base}/api/stores`, { headers: { cookie: 'aca_session=forged.sig' } })).status,
      401,
    );
    check(
      'expired cookie -> 401',
      (await call(`${base}/api/stores`, {
        headers: { cookie: `aca_session=${mintCookie(OPERATOR_EPOCH, future(-10))}` },
      })).status,
      401,
    );
    // Both epochs are load-bearing, so both are asserted: this harness would pass with
    // only one checked, and the other is the one a per-person revoke depends on.
    check(
      'cookie bound to a revoked per-operator epoch -> 401',
      (await call(`${base}/api/stores`, {
        headers: { cookie: `aca_session=${mintCookie('a-previous-epoch', future())}` },
      })).status,
      401,
    );
    check(
      'cookie bound to a revoked install-wide epoch -> 401',
      (await call(`${base}/api/stores`, {
        headers: {
          cookie: `aca_session=${mintCookie(OPERATOR_EPOCH, future(), { globalEpoch: 'a-previous-global-epoch' })}`,
        },
      })).status,
      401,
    );
    check(
      'v2-era operator cookie -> 401',
      (await call(`${base}/api/stores`, {
        headers: {
          cookie: `aca_session=${(() => {
            const p = Buffer.from(
              JSON.stringify({ v: 2, kind: 'operator', iat: Math.floor(Date.now() / 1000), exp: future(), epoch: OPERATOR_EPOCH }),
            ).toString('base64url');
            return `${p}.${createHmac('sha256', SECRET).update(p).digest('base64url')}`;
          })()}`,
        },
      })).status,
      401,
    );

    console.log('\nauthenticated proxying');
    {
      const res = await call(`${base}/api/stores?limit=5`, { headers: { cookie: good } });
      const body = await res.json();
      check('allowlisted GET reaches upstream', res.status, 200);
      // The whole point of the change: the session travels as a header naming a person,
      // and this service never holds the install-wide key. `apiKey` is null here because
      // the process was started without one, so a non-null value could only mean the
      // proxy invented it or picked it up from somewhere it should not.
      check('no admin key is sent upstream', body.apiKey, null);
      check('operator session header forwarded', body.operatorSession, OPERATOR_SID);
      check('client session header not set for an operator', body.clientSession, null);
      check('no cookie relayed upstream', body.cookie, null);
      check('query string forwarded', body.url, '/api/stores?limit=5');
    }
    {
      const res = await call(`${base}/api/stores`, { headers: { cookie: goodClient } });
      const body = await res.json();
      check('client session reaches upstream', body.clientSession, CLIENT_SID);
      check('operator session header not set for a client', body.operatorSession, null);
      check('no admin key is sent for a client session either', body.apiKey, null);
    }
    {
      const res = await call(`${base}/api/stores`, {
        method: 'POST',
        headers: { cookie: good, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });
      const body = await res.json();
      check('allowlisted POST reaches upstream', body.method, 'POST');
      check('body forwarded intact', body.bodyBytes, JSON.stringify({ name: 'Test' }).length);
    }
    {
      const res = await call(`${base}/api/automation/rules`, {
        method: 'POST',
        headers: { cookie: good, 'content-type': 'application/json' },
        body: JSON.stringify({ storeId: 's1' }),
      });
      check('allowlisted POST on a nested path', (await res.json()).url, '/api/automation/rules');
    }
    {
      // Regression: DELETE was excluded from the bodied-method set, so a bodied
      // DELETE reached the API with no body and req.body ?? {} failed zod
      // validation. The dashboard's "delete automation rule" was always a 400.
      const res = await call(`${base}/api/automation/rules/rule1`, {
        method: 'DELETE',
        headers: { cookie: good, 'content-type': 'application/json' },
        body: JSON.stringify({ storeId: 's1' }),
      });
      const body = await res.json();
      check('allowlisted DELETE reaches upstream', body.method, 'DELETE');
      check('DELETE body forwarded intact', body.bodyBytes, JSON.stringify({ storeId: 's1' }).length);
      check('DELETE on a rule path', body.url, '/api/automation/rules/rule1');
    }
    {
      // Saved message templates. PUT is the interesting one: the dashboard replaces the
      // whole list, and a PUT dropped from the bodied-method set would reach the API
      // with no body and fail validation — the same class of bug as the DELETE above.
      const read = await call(`${base}/api/automation/templates/s1`, { headers: { cookie: good } });
      check('allowlisted GET on a template path', (await read.json()).url, '/api/automation/templates/s1');
      const put = await call(`${base}/api/automation/templates/s1`, {
        method: 'PUT',
        headers: { cookie: good, 'content-type': 'application/json' },
        body: JSON.stringify({ templates: [{ id: 't1', name: 'Price', text: 'our price' }] }),
      });
      const putBody = await put.json();
      check('allowlisted PUT on a template path', putBody.method, 'PUT');
      check('PUT template body forwarded intact', putBody.bodyBytes, JSON.stringify({
        templates: [{ id: 't1', name: 'Price', text: 'our price' }],
      }).length);
    }
    {
      // A DELETE with no body must still work, so this cannot regress the other way.
      const res = await call(`${base}/api/stores/abc123`, { method: 'DELETE', headers: { cookie: good } });
      const body = await res.json();
      check('bodyless DELETE still reaches upstream', body.method, 'DELETE');
      check('bodyless DELETE sends no body', body.bodyBytes, 0);
    }
    check(
      'form-encoded body -> 415',
      (await call(`${base}/api/chat`, {
        method: 'POST',
        headers: { cookie: good, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'message=hi',
      })).status,
      415,
    );
    check(
      'form-encoded DELETE -> 415',
      (await call(`${base}/api/automation/rules/rule1`, {
        method: 'DELETE',
        headers: { cookie: good, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'storeId=s1',
      })).status,
      415,
    );
    check(
      'oversized body -> 413',
      (await call(`${base}/api/chat`, {
        method: 'POST',
        headers: { cookie: good, 'content-type': 'application/json' },
        body: 'x'.repeat(300 * 1024),
      })).status,
      413,
    );

    console.log('\nheader policy');
    {
      const res = await call(`${base}/api/session`, {
        method: 'POST',
        headers: {
          cookie: good,
          'content-type': 'application/json',
          'x-api-key': 'attacker-chosen',
          'x-operator-session': 'attacker-chosen-sid',
          'x-forwarded-for': '1.2.3.4',
          authorization: 'Bearer customer-token',
        },
        body: '{}',
      });
      const body = await res.json();
      // A caller-supplied session header must not be able to substitute their own,
      // the same way a caller-supplied x-api-key could not.
      check('caller x-api-key discarded', body.apiKey, null);
      check('caller x-operator-session discarded', body.operatorSession, OPERATOR_SID);
      check('caller x-forwarded-for not relayed', body.forwardedFor, null);
      check('customer bearer token forwarded', body.authorization, 'Bearer customer-token');
    }

    console.log('\nnot proxied');
    for (const path of [
      '/api/pdpl/export',
      // Kept as a regression guard: the shared-password endpoint is gone, and nothing
      // should reintroduce a route that authenticates an operator by a bare password.
      '/api/auth/operator/verify',
      '/api/webhooks/shopify',
    ]) {
      check(`${path} -> 404`, (await call(`${base}${path}`, { headers: { cookie: good } })).status, 404);
    }
    // `/api/oauth/shopify/start` was listed above as a path that must never be proxied.
    // It is now a BFF route in its own right, so the dashboard can start an install
    // through the same origin that holds the session cookie. The guard that still
    // matters is the one underneath: unauthenticated, the BFF refuses it outright, so an
    // install can never be started by an anonymous caller riding the proxy.
    check(
      '/api/oauth/shopify/start without a session -> 401',
      (await call(`${base}/api/oauth/shopify/start`)).status,
      401,
    );
    check(
      'state change over GET -> 404',
      (await call(`${base}/api/automation/run`, { headers: { cookie: good } })).status,
      404,
    );
    check(
      'unknown path -> 404',
      (await call(`${base}/api/nope/nope`, { headers: { cookie: good } })).status,
      404,
    );
    check(
      'extra path segment on an allowed prefix -> 404',
      (await call(`${base}/api/stores/abc/keys`, { headers: { cookie: good } })).status,
      404,
    );

    console.log('\nlogin route');
    {
      // The real path: credentials in, session cookie out, cookie then works. Everything
      // above used a cookie minted here, so nothing yet proved that the route which
      // issues cookies produces one the proxy accepts. An operator now signs in with an
      // email like anyone else, because a shared password is not an identity.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'operator',
          email: 'operator@example.com',
          password: 'correct-horse-battery-staple',
        }),
      });
      const setCookie = res.headers.get('set-cookie') ?? '';
      check('correct credentials -> 200', res.status, 200);
      check('issues the session cookie', /aca_session=[^;]+/.test(setCookie), true);
      check('cookie is HttpOnly', /HttpOnly/i.test(setCookie), true);
      // Lax, not Strict: the Shopify OAuth callback is a top-level cross-site GET
      // navigation, and Strict would drop the cookie on the way back.
      check('cookie is SameSite=Lax', /SameSite=Lax/i.test(setCookie), true);
      check('cookie is scoped to the site', /Path=\//i.test(setCookie), true);

      const issued = setCookie.split(';')[0];
      const proxied = await call(`${base}/api/stores`, { headers: { cookie: issued } });
      check('the issued cookie authenticates a proxied request', proxied.status, 200);
      // The cookie the login route mints must name the same session the API issued, or
      // the proxy would be forwarding a session the API has no record of.
      check('issued cookie forwards the API-minted sid', (await proxied.json()).operatorSession, OPERATOR_SID);
    }
    {
      // A merchant signs in through the same route and a different upstream endpoint.
      // The kind is explicit, so a client typing an operator's address cannot mint an
      // operator cookie: the API answers 401 and this route passes that through.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'client',
          email: 'merchant@example.com',
          password: 'correct-horse-battery-staple',
        }),
      });
      check('client sign-in -> 200', res.status, 200);
      const issued = (res.headers.get('set-cookie') ?? '').split(';')[0];
      const proxied = await call(`${base}/api/stores`, { headers: { cookie: issued } });
      check('client cookie forwards the client sid', (await proxied.json()).clientSession, CLIENT_SID);
    }
    {
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'operator', email: 'operator@example.com', password: 'wrong' }),
      });
      check('wrong password -> 401', res.status, 401);
      check('no cookie issued on failure', res.headers.get('set-cookie'), null);
    }
    {
      // A missing email is now a malformed body, not a valid operator sign-in attempt:
      // there is no username-less operator to fall back to.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'operator', password: 'correct-horse-battery-staple' }),
      });
      check('operator sign-in without an email -> 400', res.status, 400);
    }
    {
      // The API owns the attempt counter, so a lockout has to survive the proxy and
      // keep its Retry-After or the form cannot tell the operator when to retry.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'operator',
          email: 'operator@example.com',
          password: 'locked-out',
        }),
      });
      check('upstream lockout -> 429', res.status, 429);
      check('Retry-After preserved', res.headers.get('retry-after'), '42');
    }
    {
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'operator',
          email: 'operator@example.com',
          password: 'x'.repeat(2000),
        }),
      });
      check('oversized password -> 400', res.status, 400);
    }
    {
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      check('malformed login body -> 400', res.status, 400);
    }
    {
      // A cross-origin form can produce urlencoded or multipart, never JSON, so
      // refusing it here is a CSRF control on the credential exchange itself.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=operator@example.com&password=correct-horse-battery-staple',
      });
      check('form-encoded login -> 400', res.status, 400);
    }

    console.log('\nunified exchange route');
    {
      // The OAuth callback cannot know whether its token belongs to a merchant or an
      // operator, so it hands the token over and mints whichever session comes back.
      // Both directions are asserted: guessing would either lock a merchant out or hand
      // somebody the operator cookie.
      for (const [token, kind, header] of [
        ['client-token', 'client', 'clientSession'],
        ['operator-token', 'operator', 'operatorSession'],
      ]) {
        const res = await call(`${base}/api/auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accessToken: token }),
        });
        check(`exchange of a ${kind} token -> 200`, res.status, 200);
        check(`exchange reports ${kind}`, (await res.json()).kind, kind);
        const issued = (res.headers.get('set-cookie') ?? '').split(';')[0];
        const proxied = await call(`${base}/api/stores`, { headers: { cookie: issued } });
        check(`exchanged ${kind} cookie authenticates`, proxied.status, 200);
        check(
          `exchanged ${kind} cookie forwards the right header`,
          (await proxied.json())[header] !== null,
          true,
        );
      }
    }
    {
      const res = await call(`${base}/api/auth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: 'nonsense' }),
      });
      check('unrecognized token -> 401', res.status, 401);
      check('no cookie minted for a bad token', res.headers.get('set-cookie'), null);
    }

    console.log('\nsession endpoints');
    check(
      'session reports authenticated',
      (await (await call(`${base}/api/auth/session`, { headers: { cookie: good } })).json()).authenticated,
      true,
    );
    check(
      'session reports unauthenticated without a cookie',
      (await (await call(`${base}/api/auth/session`)).json()).authenticated,
      false,
    );
    {
      const setCookie = (await call(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: good } }))
        .headers.get('set-cookie');
      check('logout clears the cookie', /aca_session=;/.test(setCookie ?? ''), true);
      check('logout expires the cookie immediately', /Max-Age=0/i.test(setCookie ?? ''), true);
      check('logout keeps HttpOnly', /HttpOnly/i.test(setCookie ?? ''), true);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    cleanup(servers);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
