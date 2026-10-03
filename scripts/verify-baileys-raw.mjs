/**
 * Raw Baileys pairing with none of this project's code.
 *
 * `verify-baileys-live.mjs` drives the real service, so a failure there cannot say
 * *which* layer broke. This strips it to a direct `makeWASocket` call: if this prints a
 * QR and registers, Baileys and this network are fine and any failure belongs to the
 * application. If this also loops on `connecting`, the network or IP is the problem and
 * no amount of application debugging will help.
 *
 *   node scripts/verify-baileys-raw.mjs
 */
import { initAuthCreds, makeWASocket, DisconnectReason } from 'baileys';
import { writeFileSync } from 'node:fs';

const phoneOut = process.env.VERIFY_SEND_TO ?? '966500000000';
const t0 = Date.now();
const at = () => `+${Date.now() - t0}ms`;

let creds = initAuthCreds({ registered: false });
let printedQr = false;
const transitions = [];

const sock = makeWASocket(
  {
    auth: {
      creds,
      keys: {
        get: async (_type, id) => undefined,
        set: async () => undefined,
        clear: () => {},
      },
    },
    printQRInTerminal: false,
    browser: ['Baileys-LiveVerify', '1.0.0', '1'],
    // Baileys swallows the reason otherwise, and a rejected handshake is exactly the
    // thing this script is meant to distinguish from a network fault.
    syncFullHistory: false,
  },
  {
    logger: {
      level: 'warn',
      log: (...args) => console.log(`${at()} baileys:`, ...args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a))),
      info: () => {},
      error: () => {},
      debug: () => {},
      child: function () { return this; },
    },
  },
);

sock.ev.on('connection.update', async (u) => {
  if (u.connection) {
    transitions.push(u.connection);
    console.log(`${at()} connection=${u.connection}`);
  }
  if (u.qr) {
    printedQr = true;
    const b64 = u.qr.split(',')[1];
    const p = `${process.cwd()}/baileys-raw-qr.png`;
    writeFileSync(p, Buffer.from(b64, 'base64'));
    console.log(`${at()} QR -> ${p}`);
    console.log('Scan it, then wait for registered=true.');
  }
  if (u.connection === 'open') {
    console.log(`${at()} creds.registered=${creds.registered} me=${creds.me?.id}`);
    if (creds.registered === true) {
      try {
        const sent = await sock.sendMessage(`${phoneOut}@s.whatsapp.net`, { text: 'Raw Baileys verification.' });
        console.log(`${at()} send accepted, id=${sent?.key?.id ?? 'unknown'}`);
      } catch (e) {
        console.log(`${at()} send threw: ${e?.message ?? e}`);
      }
      finish(0);
    } else {
      console.log(`${at()} socket open but NOT registered — this is the production signature.`);
      finish(3);
    }
  }
  if (u.connection === 'close') {
    const code = u.lastDisconnect?.error?.output?.statusCode;
    console.log(`${at()} closed reason=${code ?? 'unknown'} (loggedOut=${code === DisconnectReason.loggedOut})`);
    if (code === DisconnectReason.loggedOut || code === 401) finish(4);
  }
});

function finish(code) {
  try { sock.end(undefined); } catch {}
  console.log('\n--- result ---');
  console.log('transitions:', JSON.stringify(transitions.slice(0, 30)), `${transitions.length} total`);
  console.log('qr received:', printedQr);
  setTimeout(() => process.exit(code), 300);
}

const deadline = Date.now() + 90_000;
const poll = setInterval(() => {
  if (Date.now() > deadline) {
    clearInterval(poll);
    console.log(`\nVERDICT: no QR and no registration within 90s.`);
    console.log('transitions:', JSON.stringify(transitions.slice(0, 30)), `${transitions.length} total`);
    console.log('If this loops, Baileys cannot reach WhatsApp from this machine at all.');
    try { sock.end(undefined); } catch {}
    process.exit(5);
  }
}, 500);