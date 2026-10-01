/**
 * The pairing flow that actually reaches the merchant.
 *
 * Three bugs shipped as "Connecting…" with a dead Reconnect button, all invisible to
 * the unit suite because every test injects a socket factory and never calls
 * makeWASocket:
 *
 *   1. `require('baileys')` — a ReferenceError in this ESM package.
 *   2. `silentLogger()` returned a plain object for `child`, which Baileys calls as a
 *      function.
 *   3. A new pairing seeded `creds = {}` instead of `initAuthCreds()`. Baileys' Noise
 *      handshake reads the credential fields immediately, so the socket connected,
 *      never received a QR, and closed inside a second — retried forever on backoff,
 *      with the dashboard showing a permanent spinner and no error.
 *
 * This compiles the service with the project's tsconfig and runs it under plain Node,
 * stubbing only the DB/Redis layer, then waits for a real QR to reach a real subscriber.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
// Inside the repo so Node resolves the bare 'baileys' specifier via node_modules.
const tmp = mkdtempSync(join(repoRoot, '.tmp-baileys-esm-'));

const log = [];
function makeStubLogger() {
  const l = {
    level: 'silent',
    info: (...a) => log.push(['info', ...a]),
    warn: (...a) => log.push(['warn', ...a]),
    error: (...a) => log.push(['error', ...a]),
    debug: () => {},
    trace: () => {},
    fatal: (...a) => log.push(['fatal', ...a]),
  };
  l.child = () => l;
  return l;
}

const statuses = [];
const stubs = {
  '../lib/logger.js': { logger: makeStubLogger() },
  '../config.js': {
    config: {
      WHATSAPP_BAILEYS_ENABLED: '1',
      WHATSAPP_BAILEYS_MAX_SESSIONS: 1,
      WHATSAPP_BAILEYS_TOS_VERSION: '2026-01',
      RATE_LIMIT_PER_MIN: 60,
    },
  },
  '../db/repos.js': {
    baileysSessionRepo: {
      listOpen: async () => [],
      get: async () => null,
      saveState: async () => undefined,
      setStatus: async (storeId, status, extra) => {
        statuses.push({ status, extra: extra ?? null, at: Date.now() - t0 });
      },
      clear: async () => undefined,
      listAll: async () => [],
      decryptState: () => ({ creds: {}, keys: {} }),
    },
    eventRepo: { record: async () => true },
  },
  '../lib/lock.js': {
    acquireLock: async () => ({ renew: async () => true, release: async () => undefined }),
  },
  './whatsappInbound.js': { handleInboundText: async () => undefined },
  '../lib/phone.js': {
    normalizeJid: (s) => String(s).split('@')[0].split(':')[0] || null,
    toJid: (d) => (d ? `${d}@s.whatsapp.net` : null),
  },
  './agent.js': { answerWithTools: async () => '', toChatHistory: () => [] },
  '../db/schema.js': {},
};

globalThis.__stubs = stubs;
const t0 = Date.now();

function stubUrl(spec) {
  const file = join(tmp, spec.replace(/[^\w]/g, '_') + '.mjs');
  const s = `globalThis.__stubs[${JSON.stringify(spec)}]`;
  writeFileSync(
    file,
    [
      `const s = ${s};`,
      `export default s;`,
      `export const logger = s.logger;`,
      `export const config = s.config;`,
      `export const baileysSessionRepo = s.baileysSessionRepo;`,
      `export const eventRepo = s.eventRepo;`,
      `export const acquireLock = s.acquireLock;`,
      `export const handleInboundText = s.handleInboundText;`,
      `export const normalizeJid = s.normalizeJid;`,
      `export const toJid = s.toJid;`,
      `export const answerWithTools = s.answerWithTools;`,
      `export const toChatHistory = s.toChatHistory;`,
      '',
    ].join('\n'),
  );
  return pathToFileURL(file).href;
}

function finish(code) {
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

try {
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', join(tmp, 'out')],
    { cwd: repoRoot, stdio: 'pipe' },
  );
  let patched = readFileSync(join(tmp, 'out/services/whatsappSession.js'), 'utf8');
  for (const spec of Object.keys(stubs)) patched = patched.split(`'${spec}'`).join(`'${stubUrl(spec)}'`);
  const patchedFile = join(tmp, 'out/services/whatsappSessionPatched.js');
  writeFileSync(patchedFile, patched);

  const mod = await import(pathToFileURL(patchedFile).href);

  // Subscribe exactly as the SSE route does, before pairing starts.
  const received = [];
  mod.subscribe('pairing-e2e', (e) => {
    received.push({ type: e.type, status: e.status ?? null, hasQr: Boolean(e.qr), at: Date.now() - t0 });
    console.log(`+${Date.now() - t0}ms EVENT ${e.type}${e.status ? ' ' + e.status : ''}${e.qr ? ' (data URL)' : ''}`);
  });

  await mod.startSession('pairing-e2e');
  console.log(`+${Date.now() - t0}ms startSession resolved; status=${mod.statusFor('pairing-e2e')}`);

  await new Promise((r) => setTimeout(r, 9000));

  const qr = received.find((e) => e.type === 'qr');
  const stuck = received.filter((e) => e.status === 'connecting').length;

  console.log('\n--- summary ---');
  console.log('status transitions:', JSON.stringify(statuses.map((s) => s.status)));
  console.log('events:', JSON.stringify(received));
  console.log('final status:', mod.statusFor('pairing-e2e'));
  console.log('connecting events:', stuck, stuck > 4 ? '(reconnect loop)' : '');

  if (!qr) {
    console.log('\nVERDICT: no QR reached the subscriber.');
    try { mod.socketFor('pairing-e2e')?.end(undefined); } catch {}
    finish(7);
  }
  if (stuck > 4) {
    console.log('\nVERDICT: QR arrived but the socket is also looping on connecting.');
    try { mod.socketFor('pairing-e2e')?.end(undefined); } catch {}
    finish(8);
  }

  console.log('\nVERDICT: pairing works — a real QR reached a real subscriber.');
  try { mod.socketFor('pairing-e2e')?.end(undefined); } catch {}
  finish(0);
} catch (err) {
  console.error('harness failed:', err && (err.stack || err.message));
  console.error('log tail:', JSON.stringify(log.slice(-6)));
  finish(1);
}