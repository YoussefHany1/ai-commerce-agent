/**
 * Finds which `makeWASocket` option stops a QR from ever arriving.
 *
 * The raw socket pairs in under a second; the service's socket loops on `connecting`
 * forever. Rather than guess which option is responsible, this drives the real socket
 * with the service's options applied one at a time and reports which one first causes
 * the QR to disappear.
 *
 *   node scripts/diagnose-socket-options.mjs
 */
import { initAuthCreds, makeWASocket, Browsers } from 'baileys';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true once a QR appears, false on timeout or an early close. */
function attempt(label, extra, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let sock;
    const creds = initAuthCreds({ registered: false });
    let done = false;
    const finish = (gotQr, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.end(undefined); } catch {}
      resolve({ label, gotQr, note });
    };

    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);

    try {
      sock = makeWASocket(
        {
          auth: {
            creds,
            keys: { get: async () => undefined, set: async () => undefined, clear: () => {} },
          },
          printQRInTerminal: false,
          browser: Browsers.ubuntu('Chrome'),
          ...extra,
        },
        { logger: { level: 'silent', log: () => {}, info: () => {}, error: () => {}, debug: () => {}, child: function () { return this; } } },
      );
    } catch (err) {
      return finish(false, `threw: ${err.message}`);
    }

    let connecting = 0;
    sock.ev.on('connection.update', (u) => {
      if (u.qr) return finish(true, 'qr');
      if (u.connection === 'connecting') connecting++;
      if (u.connection === 'close') {
        return finish(false, `closed code=${u.lastDisconnect?.error?.output?.statusCode ?? '?'} after ${connecting} connecting`);
      }
    });
  });
}

const cases = [
  ['service options (all)', {
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 25_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  }],
  ['keepAliveIntervalMs only', { keepAliveIntervalMs: 25_000 }],
  ['connectTimeoutMs only', { connectTimeoutMs: 60_000 }],
  ['markOnlineOnConnect only', { markOnlineOnConnect: false }],
  ['syncFullHistory only', { syncFullHistory: false }],
  ['defaultQueryTimeoutMs only', { defaultQueryTimeoutMs: undefined }],
  ['bare (no extras)', {}],
];

console.log('Testing makeWASocket options until a QR arrives (20s each)...\n');
for (const [label, extra] of cases) {
  const r = await attempt(label, extra);
  console.log(`${r.gotQr ? 'QR  ' : 'FAIL'} ${label.padEnd(30)} ${r.note}`);
  // A failing case poisons the next: Baileys may share global state per process, so give
  // the following attempt a moment to settle rather than reading a cascade as a cause.
  await sleep(1_000);
}