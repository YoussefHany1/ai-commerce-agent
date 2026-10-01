import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { baileysSessionRepo, eventRepo } from '../db/repos.js';
import type { WhatsappBaileysSessionStatus } from '../db/schema.js';
import { normalizeJid, toJid } from '../lib/phone.js';
import { acquireLock, type Lock } from '../lib/lock.js';
import { handleInboundText } from './whatsappInbound.js';
// Type-only: erased at compile time, so this does not defeat the lazy `require` of the
// runtime module in createSocket() below.
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalKeyStore } from 'baileys';

/**
 * WhatsApp Web (Baileys) pairing sessions.
 *
 * One socket per paired number, persisted so a redeploy does not force a re-scan, and
 * leased so two API replicas cannot hold the same number at once. The design notes
 * that matter are inline; the plan this implements is whatsapp_qr_plan.md.
 *
 * The Baileys socket is reached through `socketFactory` rather than imported directly
 * so the lifecycle can be tested without a live WhatsApp account — the reconnect
 * ladder and the disconnect-reason handling are the parts most likely to be wrong, and
 * they are the parts a unit test can actually pin down.
 */

/**
 * Reply sent when a customer sends something we cannot read.
 *
 * Declining explicitly matters more than the wording: a handler that reads only
 * `message.conversation` treats an image as "no text", skips it silently, and the
 * merchant concludes the bot is broken. Silence reads as an outage.
 *
 * A module constant rather than an inline literal so the wording is changeable in one
 * place, and so tests assert against the constant instead of a duplicated copy.
 */
export const MEDIA_UNSUPPORTED = 'Sorry, I cannot read images at the moment.';

/**
 * Attachment types we decline with `MEDIA_UNSUPPORTED`.
 *
 * `reactionMessage` is deliberately absent. A reaction carries no attachment the
 * merchant expects an answer to, and replying "I cannot read images" to a thumbs-up is
 * worse than saying nothing — so reactions fall through to `ignore`.
 */
const MEDIA_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'locationMessage',
  'contactMessage',
] as const;

export type InboundClassification = 'text' | 'media' | 'ignore';

type AnyMessage = {
  message?: Record<string, unknown> | null;
  key?: { remoteJid?: string | null; fromMe?: boolean | null; id?: string | null };
};

/**
 * Text wins over media when a message carries both (a caption plus an image): the
 * caption is what the customer meant to say, and the agent can act on it.
 */
export function classifyInbound(message: Record<string, unknown> | null | undefined): InboundClassification {
  if (typeof message?.conversation === 'string' && message.conversation.trim()) return 'text';
  for (const key of MEDIA_KEYS) if (key in (message ?? {})) return 'media';
  return 'ignore';
}

/**
 * Last known status per store, kept across teardown.
 *
 * Terminal states are recorded here rather than only in Postgres because the live map
 * entry is gone the moment the socket closes — and `logged_out` / `replaced` are exactly
 * the states the dashboard needs to show a re-scan prompt for. Without this, a terminal
 * disconnect reads as `idle` until the status query happens to hit the DB.
 */
const lastStatus = new Map<string, WhatsappBaileysSessionStatus>();

export type SessionEvent = {
  type: 'status' | 'qr';
  status?: WhatsappBaileysSessionStatus;
  /** Base64 QR payload, `type: 'qr'` only. */
  qr?: string;
  phone?: string | null;
  error?: string | null;
  at: string;
};

/** Minimal structural view of a Baileys socket: what we actually call. */
export type SocketLike = {
  ev: {
    on(event: 'connection.update', cb: (update: ConnectionUpdate) => void): void;
    on(event: 'creds.update', cb: () => void): void;
    on(event: 'messages.upsert', cb: (arg: { messages: AnyMessage[]; type: string }) => void): void;
  };
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  /** Unlinks the device from WhatsApp. This is the *disconnect* path. */
  logout?(): Promise<void>;
  /** Drops the local socket without unlinking. Used on replica handover. */
  end(error?: Error): void;
};

export type ConnectionUpdate = {
  connection?: 'open' | 'connecting' | 'close';
  lastDisconnect?: { error?: unknown } | null;
  isNewLogin?: boolean;
  qr?: string;
  receivedPendingNotifications?: boolean;
};

/**
 * Auth state, plus the knobs this service drives.
 *
 * Baileys 6.x takes `keys` as a bulk `SignalKeyStore` (`get(type, ids[])` /
 * `set(SignalDataSet)`), not the older per-id `SignalDataStore`. The distinction is
 * not cosmetic: `set` arrives in bursts as pre-key and session records land, which is
 * exactly what the debounced flush below is for.
 */
type AuthState = AuthenticationState & {
  /** Persist `{ creds, keys }` now. `creds.update` bypasses the debounce. */
  flush: () => Promise<void>;
};

/** Disconnect reasons that must not be retried: retrying them is either futile or harmful. */
const TERMINAL_REASONS = new Set<number>([
  401, // loggedOut — the number was unlinked, only a re-scan fixes it
  440, // connectionReplaced — another device took the session; reconnecting fights it
  403, // forbidden
]);

/** Close codes treated as transient, i.e. worth a reconnect. */
const RETRYABLE_REASONS = new Set<number>([408, 428, 500, 503, 515]);

/**
 * Reconnect ladder: 1s, 2s, 4s, 8s, 16s, 30s, 60s, capped.
 *
 * The cap and the jitter are load-bearing, not decoration. Rapid reconnect loops are a
 * documented trigger for Meta rate-limiting or banning a number, so a tight retry
 * interval trades a transient blip for a permanent outage of the merchant's channel.
 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000];

/** Lease TTL for socket ownership. Renewed while the session lives. */
const LEASE_TTL_MS = 60_000;
const LEASE_NAME = 'whatsapp:baileys';

export class SessionLimitError extends Error {
  readonly openSessions: number;
  constructor(openSessions: number) {
    super('whatsapp session limit reached');
    this.name = 'SessionLimitError';
    this.openSessions = openSessions;
  }
}

export class SessionBusyError extends Error {
  constructor() {
    super('another replica holds this whatsapp session');
    this.name = 'SessionBusyError';
  }
}

/** Minimum gap between two inbound messages from the same contact, per store. */
const INBOUND_THROTTLE_MS = 1_000;

/** Live sessions, keyed by store. Presence here — not the DB — is what makes a session sendable. */
const live = new Map<string, LiveSession>();
/** SSE subscribers per store. */
const subscribers = new Map<string, Set<(e: SessionEvent) => void>>();
/** Last inbound timestamp per `${storeId}:${phone}`, for the throttle. */
const lastInbound = new Map<string, number>();

type LiveSession = {
  storeId: string;
  socket: SocketLike;
  lock: Lock;
  leaseTimer: NodeJS.Timeout;
  status: WhatsappBaileysSessionStatus;
  /** Set once the socket opens; bare digits, never a JID. */
  phone: string | null;
  attempts: number;
  closing: boolean;
};

type SocketFactory = (opts: { auth: AuthState; storeId: string }) => SocketLike;

/** Injected in tests; defaults to the real Baileys socket. */
let socketFactory: SocketFactory | null = null;

/** Test seam. Passing null restores the real Baileys socket. */
export function __setSocketFactory(factory: SocketFactory | null): void {
  socketFactory = factory;
}

function jitter(base: number): number {
  const spread = base * 0.2;
  return Math.round(base - spread + Math.random() * spread * 2);
}

function backoffFor(attempt: number): number {
  return jitter(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
}

function emit(storeId: string, event: Omit<SessionEvent, 'at'>): void {
  const full: SessionEvent = { ...event, at: new Date().toISOString() };
  for (const fn of subscribers.get(storeId) ?? []) {
    try {
      fn(full);
    } catch (err) {
      // One broken SSE pipe must not stop the others, nor the session itself.
      logger.warn({ err, storeId }, 'whatsapp: session listener threw');
    }
  }
}

/**
 * Rebuilds auth state from the encrypted row.
 *
 * The *whole* `{ creds, keys }` blob is restored. Keeping only `creds` is the trap
 * this replaces: it looks paired, the QR never reappears, and every send fails because
 * the Signal pre-key and session records are gone.
 *
 * Key writes are debounced because Baileys flushes pre-key/session records in bursts;
 * persisting each one would hammer Postgres. `creds` updates bypass the debounce —
 * they are rare and losing them costs a re-scan.
 */
async function loadAuthState(storeId: string): Promise<AuthState> {
  const row = await baileysSessionRepo.get(storeId);
  let creds = {} as AuthenticationCreds;
  let storedKeys: Record<string, SignalDataSet> = {};

  if (row) {
    try {
      const parsed = baileysSessionRepo.decryptState(row) as {
        creds?: AuthenticationCreds;
        keys?: Record<string, SignalDataSet>;
      };
      creds = parsed.creds ?? ({} as AuthenticationCreds);
      storedKeys = parsed.keys ?? {};
    } catch {
      // A failed decrypt means the encryption key rotated without a re-encrypt, or the
      // blob is corrupt. Refuse to connect rather than pairing over the top of state we
      // could not read: starting fresh would leave the merchant's number still linked on
      // WhatsApp while this install holds an unpaired row it believes is live.
      throw new Error(
        'whatsapp: stored pairing state could not be decrypted — re-pair this number from the dashboard',
      );
    }
  }

  // type -> id -> value. Seeded from the persisted blob so reads never touch the DB.
  const cache = new Map<string, Map<string, unknown>>();
  for (const [type, set] of Object.entries(storedKeys)) {
    const m = new Map<string, unknown>();
    for (const [id, value] of Object.entries(set ?? {})) {
      if (value != null) m.set(id, value);
    }
    cache.set(type, m);
  }

  let flushTimer: NodeJS.Timeout | null = null;
  let pending = false;

  const snapshot = (): Record<string, SignalDataSet> => {
    const out: Record<string, SignalDataSet> = {};
    for (const [type, m] of cache) out[type] = Object.fromEntries(m) as SignalDataSet;
    return out;
  };

  const flush = async (): Promise<void> => {
    try {
      await baileysSessionRepo.saveState(storeId, { creds, keys: snapshot() });
    } catch (err) {
      logger.error({ err, storeId }, 'whatsapp: failed to persist pairing state');
    }
  };

  const schedule = (): void => {
    if (pending) return;
    pending = true;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      pending = false;
      void flush();
    }, 1_000);
    flushTimer.unref?.();
  };

  const store: SignalKeyStore = {
    async get(type, ids) {
      const m = cache.get(type);
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        const value = m?.get(id);
        if (value !== undefined) out[id] = value;
      }
      return out as never;
    },
    async set(data) {
      for (const [type, entries] of Object.entries(data)) {
        const m = cache.get(type) ?? new Map<string, unknown>();
        for (const [id, value] of Object.entries(entries ?? {})) {
          // A null value is Baileys' deletion signal, not a stored null.
          if (value == null) m.delete(id);
          else m.set(id, value);
        }
        cache.set(type, m);
      }
      schedule();
    },
    async clear() {
      cache.clear();
      schedule();
    },
  };

  // Baileys' own wrapper adds request-level caching and read/write batching. Without it
  // every encryption round-trip re-reads the store, which is the expensive path.
  const baileys = requireBaileys();
  return {
    creds,
    keys: baileys.makeCacheableSignalKeyStore(store),
    flush,
  };
}

function parseReason(error: unknown): number | null {
  const out = (error as { output?: { statusCode?: number } } | null)?.output?.statusCode;
  return typeof out === 'number' ? out : null;
}

/**
 * Renders a Baileys QR payload as a PNG data URL.
 *
 * Done here rather than in the browser so the QR library never enters the dashboard
 * bundle: the dashboard receives a finished image and renders it as an `<img>`, and a
 * QR rotates about every 20 seconds so there is nothing to cache either way. The raw
 * payload is an opaque WhatsApp string — exposing it to page JS would buy nothing.
 *
 * Falls back to the raw payload if rendering fails, so a QR is never withheld from the
 * merchant over a cosmetic failure. `web/proxy.ts` already permits `data:` images, which
 * is what lets this shape render without loosening CSP.
 */
async function qrToDataUrl(payload: string): Promise<string> {
  try {
    const { default: QRCode } = await import('qrcode');
    return await QRCode.toDataURL(payload, { margin: 1, width: 320 });
  } catch (err) {
    logger.warn({ err, storeId: 'qr' }, 'whatsapp: failed to render QR image');
    return payload;
  }
}

/** True when this store already holds a live socket on this replica. */
export function isLive(storeId: string): boolean {
  return live.has(storeId);
}

/** Live phone for a store, or null when not connected. */
export function livePhone(storeId: string): string | null {
  return live.get(storeId)?.phone ?? null;
}

/** The socket for a store, for the send dispatcher. */
export function socketFor(storeId: string): SocketLike | null {
  return live.get(storeId)?.socket ?? null;
}

export function statusFor(storeId: string): WhatsappBaileysSessionStatus | null {
  return live.get(storeId)?.status ?? lastStatus.get(storeId) ?? null;
}

/** Subscribes to session events. Returns an unsubscribe function. */
export function subscribe(storeId: string, fn: (e: SessionEvent) => void): () => void {
  const set = subscribers.get(storeId) ?? new Set();
  set.add(fn);
  subscribers.set(storeId, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(storeId);
  };
}

/** Drops the auth state so the next start pairs from scratch. */
export async function resetSession(storeId: string): Promise<void> {
  await baileysSessionRepo.clear(storeId);
}

/**
 * Starts (or resumes) the socket for a store.
 *
 * Refuses when the limit is already met — but exempts a store re-pairing *its own*
 * session, because the re-scan path after `connectionReplaced` would otherwise deadlock
 * against the very limit it just tripped.
 */
export async function startSession(storeId: string): Promise<{ resumed: boolean }> {
  const existing = live.get(storeId);
  if (existing && !existing.closing) return { resumed: true };

  const open = await baileysSessionRepo.listOpen();
  if (!open.some((s) => s.storeId === storeId)) {
    if (open.length >= config.WHATSAPP_BAILEYS_MAX_SESSIONS) {
      throw new SessionLimitError(open.length);
    }
  }

  const lock = await acquireLock(LEASE_NAME, LEASE_TTL_MS);
  if (!lock) throw new SessionBusyError();

  const leaseTimer = setInterval(() => {
    void lock.renew().then((ok) => {
      if (!ok) {
        // Another replica took the number. Tear down rather than keep sending on a
        // session this replica no longer owns.
        logger.warn({ storeId }, 'whatsapp: lease lost, closing session');
        void stopSession(storeId, { logout: false });
      }
    });
  }, LEASE_TTL_MS / 3);
  leaseTimer.unref?.();

  // Everything past the lease must be able to fail without stranding it. The lease is
  // global and its renewal timer runs until cleared, so a throw here would otherwise
  // wedge the number for every store until the process restarts.
  let auth: Awaited<ReturnType<typeof loadAuthState>>;
  try {
    auth = await loadAuthState(storeId);
  } catch (err) {
    clearInterval(leaseTimer);
    await lock.release().catch(() => undefined);
    throw err;
  }

  const socket = createSocket({ auth, storeId });

  const session: LiveSession = {
    storeId,
    socket,
    lock,
    leaseTimer,
    status: 'connecting',
    phone: null,
    attempts: 0,
    closing: false,
  };
  live.set(storeId, session);
  lastStatus.set(storeId, 'connecting');
  await baileysSessionRepo.setStatus(storeId, 'connecting').catch(() => undefined);
  emit(storeId, { type: 'status', status: 'connecting' });

  wireSocket(session, auth);
  return { resumed: false };
}

function createSocket(opts: { auth: AuthState; storeId: string }): SocketLike {
  if (socketFactory) return socketFactory(opts);
  const baileys = requireBaileys();
  return baileys.makeWASocket({
    auth: opts.auth,
    // The QR goes to the dashboard over SSE, never to a deploy log nobody reads.
    printQRInTerminal: false,
    browser: baileys.Browsers.ubuntu('Chrome'),
    // A permanently-present presence badge invites "why is this bot always online".
    markOnlineOnConnect: false,
    // We only need new messages; history sync costs a full re-download of the account.
    syncFullHistory: false,
    logger: silentLogger() as any,
  }) as unknown as SocketLike;
}

/** Baileys is imported lazily so a deployment with the flag off never loads it. */
let baileysModule: typeof import('baileys') | null = null;
function requireBaileys(): typeof import('baileys') {
  if (!baileysModule) baileysModule = require('baileys') as typeof import('baileys');
  return baileysModule;
}

/**
 * Baileys logs through pino and is extremely chatty at info level. Silencing it keeps
 * reconnect storms out of the app log; the lifecycle events we care about are already
 * recorded explicitly via `baileysSessionRepo.setStatus` and the session events.
 */
function silentLogger(): Record<string, unknown> {
  return { level: 'silent', child: { level: 'silent' } } as never;
}

function wireSocket(session: LiveSession, auth: AuthState): void {
  const { storeId, socket } = session;

  socket.ev.on('creds.update', () => {
    // Rare and critical — persist immediately so a redeploy cannot lose the pairing.
    void auth.flush();
  });

  socket.ev.on('connection.update', (update) => {
    void onConnectionUpdate(session, auth, update);
  });

  socket.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    void handleUpsert(storeId, messages ?? []);
  });
}

async function onConnectionUpdate(session: LiveSession, auth: AuthState, update: ConnectionUpdate): Promise<void> {
  const { storeId } = session;
  if (session.closing) return;

  /** Records a transition in memory as well as in Postgres. */
  const move = async (
    status: WhatsappBaileysSessionStatus,
    extra: { phone?: string | null; lastError?: string | null } = {},
  ): Promise<void> => {
    session.status = status;
    lastStatus.set(storeId, status);
    await baileysSessionRepo.setStatus(storeId, status, extra).catch(() => undefined);
  };

  if (update.qr) {
    await move('qr');
    emit(storeId, { type: 'qr', qr: await qrToDataUrl(update.qr) });
    return;
  }

  if (update.connection === 'open') {
    session.attempts = 0;
    const phone = normalizeJid((auth.creds as { me?: { id?: string } } | undefined)?.me?.id ?? null);
    session.phone = phone;
    await auth.flush();
    await move('open', { phone });
    emit(storeId, { type: 'status', status: 'open', phone });
    return;
  }

  if (update.connection !== 'close') return;

  const reason = parseReason(update.lastDisconnect?.error);

  if (reason !== null && TERMINAL_REASONS.has(reason)) {
    // loggedOut / replaced / forbidden: reconnecting fights WhatsApp. Persist the
    // terminal status so the dashboard offers a re-scan instead of a spinner.
    const status: WhatsappBaileysSessionStatus = reason === 440 ? 'replaced' : 'logged_out';
    await move(status, { lastError: `disconnect ${reason}` });
    emit(storeId, { type: 'status', status });
    await teardown(session, { logout: false, keepState: true });
    return;
  }

  if (reason !== null && !RETRYABLE_REASONS.has(reason)) {
    await move('error', { lastError: `disconnect ${reason}` });
    emit(storeId, { type: 'status', status: 'error', error: `disconnect ${reason}` });
    await teardown(session, { logout: false, keepState: true });
    return;
  }

  // Transient. Back off before retrying.
  const delay = backoffFor(session.attempts++);
  logger.warn({ storeId, reason, delay }, 'whatsapp: transient disconnect, reconnecting');
  await move('connecting');
  emit(storeId, { type: 'status', status: 'connecting' });
  await teardown(session, { logout: false, keepState: true });
  setTimeout(() => {
    void startSession(storeId).catch((err) => logger.error({ err, storeId }, 'whatsapp: reconnect failed'));
  }, delay).unref?.();
}

/**
 * Tears down the socket and releases the lease.
 *
 * `logout` is the *disconnect* path (unlinks the number from WhatsApp) and is only
 * called from an explicit merchant disconnect — never from a reconnect, where calling
 * it would unlink a perfectly good pairing.
 */
async function teardown(
  session: LiveSession,
  opts: { logout: boolean; keepState: boolean },
): Promise<void> {
  session.closing = true;
  clearInterval(session.leaseTimer);
  try {
    if (opts.logout) await session.socket.logout?.();
    else session.socket.end();
  } catch (err) {
    logger.warn({ err, storeId: session.storeId }, 'whatsapp: socket teardown failed');
  }
  live.delete(session.storeId);
  await session.lock.release();
  if (!opts.keepState) {
    await baileysSessionRepo.clear(session.storeId).catch(() => undefined);
  }
  session.closing = false;
}

/**
 * Stops a store's session.
 *
 * `logout: true` unlinks the number from WhatsApp and drops the stored state — the
 * merchant asked to disconnect, so the pairing is finished.
 */
export async function stopSession(
  storeId: string,
  opts: { logout: boolean },
): Promise<void> {
  const session = live.get(storeId);
  if (!session) {
    if (opts.logout) await resetSession(storeId);
    return;
  }
  await teardown(session, { logout: opts.logout, keepState: !opts.logout });
  if (opts.logout) {
    lastStatus.set(storeId, 'logged_out');
    await baileysSessionRepo.setStatus(storeId, 'logged_out').catch(() => undefined);
    emit(storeId, { type: 'status', status: 'logged_out' });
  }
}

/**
 * Routes an inbound message batch.
 *
 * `fromMe` is skipped so the paired number never talks to itself, and group or status
 * JIDs are dropped by `normalizeJid` returning null.
 */
async function handleUpsert(storeId: string, messages: AnyMessage[]): Promise<void> {
  for (const msg of messages) {
    if (msg.key?.fromMe) continue;
    const phone = normalizeJid(msg.key?.remoteJid ?? null);
    if (!phone) continue;

    const kind = classifyInbound(msg.message ?? undefined);
    if (kind === 'ignore') continue;

    // Throttle per contact, or a customer sending rapid images becomes a send loop.
    const throttleKey = `${storeId}:${phone}`;
    const now = Date.now();
    if (now - (lastInbound.get(throttleKey) ?? 0) < INBOUND_THROTTLE_MS) continue;
    lastInbound.set(throttleKey, now);

    try {
      if (kind === 'text') {
        const text = (msg.message as { conversation?: unknown }).conversation;
        if (typeof text === 'string') await handleInboundText(storeId, phone, text);
      } else {
        await handleInboundMedia(storeId, phone, msg.key?.id ?? null);
      }
    } catch (err) {
      logger.error({ err, storeId, phone }, 'whatsapp: inbound message failed');
    }
  }
}

/**
 * Declines an attachment we cannot read.
 *
 * No LLM call — the agent cannot see the image, so calling it would spend tokens to
 * produce a generic reply and risk it inventing a description of content it never
 * received. No conversation write either: a `messages` row needs a paired `user` turn
 * and there is no text to store, so an assistant row alone would orphan the transcript
 * and render as a message with no preceding user turn. The interaction goes to
 * `events` instead, where it is observable without corrupting message order.
 */
async function handleInboundMedia(storeId: string, phone: string, messageId: string | null): Promise<void> {
  await sendTextOverSocket(storeId, phone, MEDIA_UNSUPPORTED);
  await eventRepo
    .record({
      storeId,
      type: 'whatsapp.media_unsupported',
      dedupKey: messageId,
      payload: { phone, reply: MEDIA_UNSUPPORTED },
    })
    .catch((err) => logger.warn({ err, storeId }, 'whatsapp: failed to log unsupported media'));
}

/**
 * Sends text over the live socket.
 *
 * @returns whether the send was attempted on an open socket.
 */
export async function sendTextOverSocket(storeId: string, to: string, body: string): Promise<boolean> {
  const session = live.get(storeId);
  if (!session || session.status !== 'open') {
    logger.warn({ storeId, to }, 'whatsapp: no open baileys session for send');
    return false;
  }
  const jid = toJid(to);
  if (!jid) return false;
  try {
    await session.socket.sendMessage(jid, { text: body });
    return true;
  } catch (err) {
    logger.warn({ err, storeId, to }, 'whatsapp: baileys send failed');
    return false;
  }
}

/**
 * Reconnects every persisted session at boot.
 *
 * Called once, after the server is listening and only when the feature flag is on.
 * A failure for one store is logged and skipped so a single bad blob does not stop the
 * others from restoring.
 */
export async function restoreAllSessions(): Promise<void> {
  const rows = await baileysSessionRepo.listAll();
  const max = config.WHATSAPP_BAILEYS_MAX_SESSIONS;
  let started = 0;
  for (const row of rows) {
    if (started >= max) {
      logger.warn({ storeId: row.storeId }, 'whatsapp: session limit reached at boot, leaving store offline');
      await baileysSessionRepo.setStatus(row.storeId, 'idle', { lastError: 'session limit reached' }).catch(() => undefined);
      continue;
    }
    try {
      await startSession(row.storeId);
      started += 1;
    } catch (err) {
      logger.error({ err, storeId: row.storeId }, 'whatsapp: failed to restore session at boot');
    }
  }
  logger.info({ restored: started, total: rows.length }, 'whatsapp: boot restore complete');
}

/** Test seam: forget all live state without touching the DB. */
export function __resetLiveForTest(): void {
  for (const s of live.values()) {
    clearInterval(s.leaseTimer);
    s.closing = true;
  }
  live.clear();
  lastStatus.clear();
  subscribers.clear();
  lastInbound.clear();
}