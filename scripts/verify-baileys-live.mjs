/**
 * Proves whether Baileys can complete registration *from this machine*.
 *
 * Production shows a socket that opens (`status: open`, inbound decrypts) while
 * `creds.registered` stays false, so sends are written and then discarded by WhatsApp.
 * That is the signature of a rejected handshake, and the usual cause for a specific
 * machine is the source IP — Render runs in a datacenter range that WhatsApp throttles or
 * blocks, while a laptop on a residential connection is not.
 *
 * The unit suite cannot answer this: every test injects a socket factory and never calls
 * `makeWASocket`, so nothing there ever performs a Noise handshake. This harness compiles
 * the real service, stubs only the DB/Redis layer, and drives a genuine pairing:
 *
 *   1. a real QR reaches the terminal and is written to a PNG you can scan
 *   2. after you scan, it waits for WhatsApp to confirm registration
 *   3. it sends a real outbound message and reports whether it was accepted
 *
 * Run it from your laptop:  npm run verify:live
 *
 * A pass here plus the same failure on Render isolates the cause to the deployment IP
 * rather than to the application, which is the question this script exists to answer.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const STORE = 'live-verify';
const tmp = mkdtempSync(join(repoRoot, '.tmp-baileys-live-'));
const qrPath = join(process.cwd(), 'baileys-live-qr.png');

/** Printed alongside the PNG so the result is legible if the image will not open. */
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
const credsSeen = [];
// Must be null, not `{}`: `loadAuthState` treats any truthy `parsed.creds` as a real
  // pairing and skips `initAuthCreds()`. Seeding `{}` here reproduced the production
  // symptom exactly — socket connects, no QR, reconnect loop — and made the harness, not
  // the service, look broken.
  let state = null;

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
      // null models a store that has never paired: `loadAuthState` then seeds
      // `initAuthCreds()`. A row here would restore creds instead of pairing fresh,
      // which is the opposite of what this harness needs to exercise.
      get: async () => null,
      saveState: async (_storeId, next) => {
        state = next;
      },
      setStatus: async (storeId, status, extra) => {
        statuses.push({ status, extra: extra ?? null, at: Date.now() - t0 });
        console.log(`+${Date.now() - t0}ms status=${status}${extra?.phone ? ' phone=' + extra.phone : ''}`);
      },
      clear: async () => {
        state = null;
      },
      listAll: async () => [],
      decryptState: () => {
        if (!state) throw new Error('no stored state');
        return state;
      },
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
    // Mirror src/lib/phone.ts: a LID stays a LID, and only digits reach jidEncode.
    parseJid: (s) => {
      const raw = String(s ?? '').trim().toLowerCase();
      const at = raw.lastIndexOf('@');
      if (at === -1) return null;
      const server = raw.slice(at + 1);
      if (!['s.whatsapp.net', 'c.us', 'lid'].includes(server)) return null;
      const digits = raw.slice(0, at).split(':')[0].replace(/\D/g, '');
      if (!digits) return null;
      return { digits, jid: server === 'lid' ? `${digits}@lid` : `${digits}@s.whatsapp.net` };
    },
    addressForSend: (jid, digits) => {
      if (jid && String(jid).includes('@')) return String(jid).trim().toLowerCase();
      const d = String(digits ?? '').replace(/\D/g, '');
      return d ? `${d}@s.whatsapp.net` : null;
    },
    pairingDigits: (input) => {
      if (!input) return null;
      const digits = String(input).replace(/\D/g, '');
      return digits || null;
    },
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
      `export const parseJid = s.parseJid;`,
      `export const addressForSend = s.addressForSend;`,
      `export const pairingDigits = s.pairingDigits;`,
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

/** A PNG the merchant can actually scan; the data URL alone is not openable. */
function writeQrPng(dataUrl) {
  const b64 = String(dataUrl).split(',')[1];
  if (!b64) return null;
  writeFileSync(qrPath, Buffer.from(b64, 'base64'));
  return qrPath;
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

  const received = [];
  mod.subscribe(STORE, (e) => {
    received.push({ type: e.type, status: e.status ?? null, hasQr: Boolean(e.qr), at: Date.now() - t0 });
    if (e.type === 'qr') {
      const p = writeQrPng(e.qr);
      console.log(`+${Date.now() - t0}ms QR received -> ${p ?? '(could not write PNG)'}`);
    } else {
      console.log(`+${Date.now() - t0}ms EVENT ${e.type}${e.status ? ' ' + e.status : ''}`);
    }
  });

  console.log('Starting a real Baileys pairing from this machine.\n');
  await mod.startSession(STORE);
  console.log(`+${Date.now() - t0}ms startSession resolved; status=${mod.statusFor(STORE)}`);

  // Phase 1: a QR must arrive. Without one there is nothing to scan and no point waiting.
  // The QR often takes 10-20s on a cold handshake, and repeated `connecting` transitions
  // are normal before that: Baileys retries the websocket before it ever asks WhatsApp
  // for a pairing code. Giving up on a fixed count of them produced false failures.
  const qrDeadline = Date.now() + 90_000;
  while (Date.now() < qrDeadline && !received.some((e) => e.type === 'qr')) {
    await new Promise((r) => setTimeout(r, 250));
  }

  const qr = received.find((e) => e.type === 'qr');
  if (!qr) {
    console.log('\nVERDICT: no QR reached the subscriber — the handshake never started.');
    console.log('JSON:', JSON.stringify(received));
    try { mod.socketFor(STORE)?.end(undefined); } catch {}
    finish(7);
  }

  console.log('\nScan the QR now (WhatsApp -> Linked devices -> Link a device).');
  console.log(`Image: ${qrPath}`);
  console.log('Waiting up to 120s for WhatsApp to confirm registration...\n');

  // Phase 2: wait for the socket to open and WhatsApp to assign this device an identity.
  // An assigned `me.id` is the real proof that linking succeeded.
  const regDeadline = Date.now() + 120_000;
  while (Date.now() < regDeadline) {
    if (state?.creds?.me?.id) break;
    if (mod.statusFor(STORE) === 'open') {
      credsSeen.push({ registered: state?.creds?.registered === true, phone: state?.creds?.me?.id ?? null });
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const registered = state?.creds?.registered === true;
  const phone = state?.creds?.me?.id ?? null;
  const finalStatus = mod.statusFor(STORE);

  console.log('\n--- summary ---');
  console.log('status transitions:', JSON.stringify(statuses.map((s) => s.status)));
  console.log('final status:', finalStatus);
  console.log('creds.registered:', registered, '(informational only — not a readiness signal)');
  console.log('creds.me:', phone);
  console.log('open-socket samples:', JSON.stringify(credsSeen.slice(-3)));

  // Phase 3: prove a real send is accepted. Gated on the open socket, not on
  // `creds.registered`: that flag is set only at the end of companion pairing and never
  // cleared, so gating on it reported a working session as a failure.
  let sendResult = null;
  if (finalStatus === 'open' && phone) {
    const to = process.env.VERIFY_SEND_TO ?? '966500000000';
    const ok = await mod.sendTextOverSocket(STORE, to, 'Baileys live verification — registration works from this machine.');
    sendResult = ok;
    console.log(`send to ${to}:`, ok);
  }

  try { mod.socketFor(STORE)?.end(undefined); } catch {}

  console.log('\n--- result ---');
  if (phone && sendResult === true) {
    console.log('VERDICT: PASS — the device was linked and a real send was accepted from this machine.');
    console.log('So this machine is not blocked; any production failure is specific to the deployment.');
    finish(0);
  }
  if (!phone) {
    console.log('VERDICT: FAIL — the socket never received a device identity. The scan did not complete.');
    console.log('That is reproducible off Render, so it is not purely a deployment problem.');
    finish(9);
  }
  console.log('VERDICT: PARTIAL — linked, but the send was refused or failed. See "send to" above.');
  finish(10);
} catch (err) {
  console.error('harness failed:', err && (err.stack || err.message));
  console.error('log tail:', JSON.stringify(log.slice(-6)));
  finish(1);
}