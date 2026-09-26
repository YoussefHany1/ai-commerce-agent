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
const EPOCH = 'smoke-epoch-0001';
const SECRET = 'b'.repeat(48);
const ADMIN_KEY = 'smoke-upstream-admin-key-0123456789';

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
  const store = new Map([['op:sess:epoch', EPOCH]]);

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
 * It also implements the one upstream endpoint the dashboard calls directly: the
 * operator password check. That is what lets this drive the real login route and
 * use the cookie it issues, instead of only testing cookies minted here.
 */
function startStubUpstream() {
  const PASSWORD = 'correct-horse-battery-staple';

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');

      if (req.url === '/api/auth/operator/verify' && req.method === 'POST') {
        let password = null;
        try {
          password = JSON.parse(body).password;
        } catch {
          /* fall through to the 401 below */
        }
        if (password === PASSWORD) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, epoch: EPOCH }));
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

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          apiKey: req.headers['x-api-key'] ?? null,
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
      ADMIN_API_KEY: ADMIN_KEY,
      API_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
      REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
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

function mintCookie(epoch, expSeconds) {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iat: Math.floor(Date.now() / 1000), exp: expSeconds, epoch }),
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

    const good = `aca_session=${mintCookie(EPOCH, future())}`;

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
        headers: { cookie: `aca_session=${mintCookie(EPOCH, future(-10))}` },
      })).status,
      401,
    );
    check(
      'cookie bound to a revoked epoch -> 401',
      (await call(`${base}/api/stores`, {
        headers: { cookie: `aca_session=${mintCookie('a-previous-epoch', future())}` },
      })).status,
      401,
    );

    console.log('\nauthenticated proxying');
    {
      const res = await call(`${base}/api/stores?limit=5`, { headers: { cookie: good } });
      const body = await res.json();
      check('allowlisted GET reaches upstream', res.status, 200);
      check('upstream received the server-side key', body.apiKey, ADMIN_KEY);
      check('no cookie relayed upstream', body.cookie, null);
      check('query string forwarded', body.url, '/api/stores?limit=5');
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
          'x-forwarded-for': '1.2.3.4',
          authorization: 'Bearer customer-token',
        },
        body: '{}',
      });
      const body = await res.json();
      check('caller x-api-key discarded', body.apiKey, ADMIN_KEY);
      check('caller x-forwarded-for not relayed', body.forwardedFor, null);
      check('customer bearer token forwarded', body.authorization, 'Bearer customer-token');
    }

    console.log('\nnot proxied');
    for (const path of [
      '/api/oauth/shopify/start',
      '/api/pdpl/export',
      '/api/auth/operator/verify',
      '/api/webhooks/shopify',
    ]) {
      check(`${path} -> 404`, (await call(`${base}${path}`, { headers: { cookie: good } })).status, 404);
    }
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
      // The real path: password in, session cookie out, cookie then works. Everything
      // above used a cookie minted here, so nothing yet proved that the route which
      // issues cookies produces one the proxy accepts.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'correct-horse-battery-staple' }),
      });
      const setCookie = res.headers.get('set-cookie') ?? '';
      check('correct password -> 200', res.status, 200);
      check('issues the session cookie', /aca_session=[^;]+/.test(setCookie), true);
      check('cookie is HttpOnly', /HttpOnly/i.test(setCookie), true);
      // Lax, not Strict: the Shopify OAuth callback is a top-level cross-site GET
      // navigation, and Strict would drop the cookie on the way back.
      check('cookie is SameSite=Lax', /SameSite=Lax/i.test(setCookie), true);
      check('cookie is scoped to the site', /Path=\//i.test(setCookie), true);

      const issued = setCookie.split(';')[0];
      const proxied = await call(`${base}/api/stores`, { headers: { cookie: issued } });
      check('the issued cookie authenticates a proxied request', proxied.status, 200);
    }
    {
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      check('wrong password -> 401', res.status, 401);
      check('no cookie issued on failure', res.headers.get('set-cookie'), null);
    }
    {
      // The API owns the attempt counter, so a lockout has to survive the proxy and
      // keep its Retry-After or the form cannot tell the operator when to retry.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'locked-out' }),
      });
      check('upstream lockout -> 429', res.status, 429);
      check('Retry-After preserved', res.headers.get('retry-after'), '42');
    }
    {
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'x'.repeat(2000) }),
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
      // refusing it here is a CSRF control on the password exchange itself.
      const res = await call(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=correct-horse-battery-staple',
      });
      check('form-encoded login -> 400', res.status, 400);
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
