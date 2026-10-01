/**
 * Executes the REAL session service under plain Node, so the module system matches
 * production. Vitest transpiles to CJS and injects `require`, which is why
 * `require('baileys')` passed 60 unit tests and then made qr-connect 500 on Render, and
 * why a malformed Baileys logger never surfaced: every test injects a socket factory and
 * so never calls makeWASocket.
 *
 * This drives a real startSession() with only the DB/Redis layer stubbed.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
// Inside the repo so Node can resolve the bare 'baileys' specifier via node_modules.
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
      setStatus: async () => undefined,
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

function stubUrl(spec) {
  const file = join(tmp, spec.replace(/[^\w]/g, '_') + '.mjs');
  const ref = `globalThis.__stubs[${JSON.stringify(spec)}]`;
  writeFileSync(
    file,
    [
      `const s = ${ref};`,
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

function fail(msg, err) {
  console.error(msg);
  if (err) console.error(String(err.stack || err));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

try {
  // Compile with the project's own config so the emitted JS is what Render runs.
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', join(tmp, 'out')],
    { cwd: repoRoot, stdio: 'pipe' },
  );

  let patched = readFileSync(join(tmp, 'out/services/whatsappSession.js'), 'utf8');
  for (const spec of Object.keys(stubs)) {
    patched = patched.split(`'${spec}'`).join(`'${stubUrl(spec)}'`);
  }
  const patchedFile = join(tmp, 'out/services/whatsappSessionPatched.js');
  writeFileSync(patchedFile, patched);

  // No socket factory: this must reach the real makeWASocket, which is where the
  // logger.child bug lived.
  const mod = await import(pathToFileURL(patchedFile).href);
  await mod.startSession('store-real-esm');

  const live = mod.isLive('store-real-esm');
  const hasSocket = mod.socketFor('store-real-esm') !== null;
  console.log('resolved baileys and created a socket');
  console.log('isLive:', live, '| socket present:', hasSocket);

  rmSync(tmp, { recursive: true, force: true });
  // Stop the socket and close the Baileys/WS transport so the harness can exit.
  process.exit(live && hasSocket ? 0 : 2);
} catch (err) {
  fail('ESM harness failed:', err);
}