# WhatsApp QR-Code Pairing (Cartat-Style) Integration — Corrected Plan

> **Status:** revised. Supersedes the previous draft, which had seven blockers that would
> have shipped a non-functional feature. Every substantive change is marked **[CORRECTED]**
> with the reason, and §3 tabulates them.

## Goal

Add a second WhatsApp connection method alongside the existing Meta Cloud API integration,
where a merchant opens Settings, scans a QR code with their phone, and is connected — with
no Meta Business account, WABA, or raw API credentials.

Implemented with [`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys)
over the WhatsApp Web Multi-Device protocol: TypeScript-native, no headless browser,
~100–200 MB per session.

---

## 1. Operating constraints (read before designing)

### 1.1 Hosting: free for trials, paid for clients

The API runs on a free Render instance (`render.yaml:57`, `plan: free`) while trialling, and
moves to a paid instance once a client signs up. This shapes the design in three ways:

- **Free sleeps after ~15 minutes idle.** An *outbound* WebSocket to WhatsApp does not count
  as activity for Render's purposes, so the instance sleeps, the socket dies, and it
  reconnects on wake. A trial merchant may have to re-scan. That is acceptable for a trial
  and must be labelled as such in the UI.
- **Memory.** 512 MB against ~100–200 MB per Baileys session. One session, no headroom. The
  cap is an env var, so raising it for paid tier is a config change, not a code change.
- **Migration to paid is one env change.** No code differences between tiers.

Fast reconnect loops are what get a number banned by Meta, so reconnect uses exponential
backoff with jitter and a hard cap. See §5.4.

### 1.2 One number per deployment

**This is a product limit, not a memory workaround.** The service supports exactly one paired
WhatsApp number. A second store's pairing attempt is refused with an explicit message, not a
generic error — the merchant needs to know it is a product boundary rather than a bug.

On the free tier this coincides with the memory ceiling (§1.1), so the refusal reason differs
by tier: on free it is a capacity limit, on paid it is the product limit. Both are stated
plainly in the error.

### 1.3 Legal / ToS — acknowledgement required before access

> [!IMPORTANT]
> WhatsApp Web protocol pairing is **unofficial**. Meta's Terms of Service do not endorse
> third-party automation over the Web protocol. Legitimate business use (order status, cart
> recovery) is widely tolerated, but a number can be temporarily or permanently banned.
> WPPConnect, Evolution API and Cartat all work this way.

**Placement: before the user accesses the service.** The merchant must read and accept the
warning *before* they can reach the pairing flow at all — not as a checkbox inside the card,
and not in operator documentation. Concretely:

- The pairing UI is gated behind a required acknowledgement interstitial, shown before any QR
  is requested.
- **Enforced server-side.** `POST /api/whatsapp/qr-connect` returns `403 tos_not_acknowledged`
  until the store has an acknowledgement recorded. Hiding the UI is a courtesy; refusing the
  session mint is the control. A client that skips the interstitial must not get a number.
- Persisted per store (in `stores.settings`) so it is asked once, not on every page load, and
  so an acceptance can be re-prompted if the terms are revised (store the version alongside).
- The acceptance timestamp is retained as a record of consent.

Rationale for not burying it in the card: the merchant is the party whose number gets banned,
and a checkbox inside a card they are already scanning past is not informed consent. It goes
before access.

See §7.1 (server gate) and §9.2 (UI gate).

### 1.3 Replica coordination

`render.yaml:89` states the API scales out freely. A Baileys session must **not** run on every
replica: N replicas opening the same credentials means WhatsApp keeps one and kicks the rest,
producing a reconnect storm and eventual ban.

`src/lib/lock.ts` already provides `acquireLock` / `renew` / `release` and exists precisely for
this. Each session holds a Redis lease for its lifetime; only the lease holder opens a socket.
See §5.5.

---

## 2. What the original plan got wrong

Read this table first — it explains most of the structural changes.

| # | Original claim | Reality | Resolution |
|---|---|---|---|
| 1 | Store creds in `whatsapp_channels.baileys_creds_enc` | `phoneNumberId` is `NOT NULL` with a unique index (`src/db/schema.ts:421`). During QR pairing no phone number exists yet — but creds must persist *before* `open`. The row cannot be inserted. | Separate `whatsapp_baileys_sessions` table (§4) |
| 2 | Migration `drizzle/0014_whatsapp_baileys.sql` | `0014_attribution_impressions.sql` already exists from the analytics work. Two migrations would claim one index. | Renamed to `0015` (§4) |
| 3 | "Baileys routes inbound through `handleInboundText`" | **No code path existed.** `handleInboundText` is called only from `handleWhatsappPayload` (`src/routes/whatsapp.ts:85`), which is the Meta webhook. The verification steps assumed the product worked; it did not exist. | `messages.upsert` handler (§6.1) — this *is* the product |
| 4 | Inbound `phone` used directly | Baileys emits `966501234567@s.whatsapp.net`. Passed straight to `customerRepo.upsert({ phone })` and back out to `sendText`. | `normalizeJid()` / `toJid()` helpers (§5.2) |
| 5 | `phoneNumberId` uniqueness permits coexistence | One store = one row. Baileys pairing overwrites `phoneNumberId` with a phone number; a later Meta `upsert` clobbers `baileys_creds_enc`. And `byStore` is `.limit(1)` with no `ORDER BY` (`src/db/repos.ts:808`) — with two rows, which transport `sendText` picks is nondeterministic. | Separate table removes all three (§4) |
| 6 | `stopSession()` + `clearBaileysCreds()` disconnects | `sock.end()` drops the server session but leaves the device **linked in the merchant's phone**. They must unlink it manually. | `sock.logout()` (§6.3) |
| 7 | Persist `state.creds` only | Baileys' `MultiFileAuthState` persists `creds` **and** a `SignalDataStore` (`keys`). Without keys, inbound message decryption fails after restart. | Persist whole auth state (§5.3) |

Additional gaps found in review, not in the original's own claim table:

| # | Gap | Resolution |
|---|---|---|
| 8 | `connection.replace` unhandled | WhatsApp kicks the session when it connects elsewhere. Without handling, the dashboard reads "Connected" while messages go nowhere. | Clear creds, force re-scan (§5.4) |
| 9 | No inbound throttle | Meta inbound is signature-verified, but Baileys inbound reaches `answerWithTools` — real LLM spend per message, from anyone messaging the number. | Per-phone cooldown (§6.1) |
| 10 | `qr-connect` had no rate limit | Every other mutating route in this codebase uses `storeRateLimitWindow`. A client could loop-restart sessions. | Added (§7) |
| 11 | `useMultiFileAuthState` imported in the sketch, then described as unused | Self-contradictory; the sketch was not the design. | Replaced with an explicit DB-backed auth state (§5.3) |
| 12 | `makeCacheableSignalKeyStore(/* ... */)` | A stub. | Full `SignalDataStore` spec + tests (§5.3, §10) |
| 13 | `stateEnc` encryption version not stored | `whatsapp_channels` has `keyVersion`; a key rotation would orphan every session silently. | `key_version` column (§4) |
| 14 | SSE omitted proxy-critical details | `dynamic = 'force-dynamic'`, no buffering, keepalive pings, `writableEnded` guard, O(1) listener cleanup. | §7.2 |
| 15 | No `qr-status` route | UI would know connection state only from a live event, not on page load. | Added (§7) |
| 16 | `web/lib/server/upstream.spec.ts` untouched | `CLIENT_CALL_SITES` is the *only* thing enforcing allowlist/client parity; new paths would drift silently. | Updated (§9.4) |
| 17 | Manual-only verification | Repo runs 468 tests; this adds socket lifecycle, credential storage, and inbound routing. | §10 |
| 18 | Latest Baileys tag assumed safe | `latest` is `7.0.0-rc14` — a release candidate. | Pin `legacy: 6.7.24` (§3) |

---

## 3. Layer 1 — Dependencies

**[CORRECTED] Pin the legacy tag.**

```
npm view @whiskeysockets/baileys dist-tags
  latest: 7.0.0-rc14      <-- release candidate
  legacy: 6.7.24          <-- stable
```

The original's `^6.7.18` would resolve to the 7.x RC. A release candidate on a production
credential-handling path is not acceptable.

```diff
  "dependencies": {
+   "@whiskeysockets/baileys": "6.7.24",
+   "qrcode": "^1.5.4",
  },
  "devDependencies": {
+   "@types/qrcode": "^1.5.6",
  },
```

`qrcode` converts Baileys' raw QR **string** to a PNG data URL. Baileys does not emit an image.

---

## 4. Layer 2 — Database

**[CORRECTED] New table, not new columns.** Rationale in §2 rows 1 and 5.

### `src/db/schema.ts`

```ts
export const whatsappBaileysSessions = pgTable('whatsapp_baileys_sessions', {
  /**
   * One live session per store, enforced by the primary key rather than by convention.
   * A separate table (rather than columns on `whatsapp_channels`) because:
   *  - `whatsapp_channels.phone_number_id` is NOT NULL + unique, and no phone exists yet
   *    during QR pairing, so creds could not be persisted before `open`;
   *  - a shared row lets the two transports overwrite each other's credentials;
   *  - `byStore()` is `.limit(1)` with no ORDER BY, so a second row makes outbound
   *    transport selection nondeterministic.
   */
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => stores.id, { onDelete: 'cascade' }),

  /** Full Baileys auth state ({ creds, keys }), AES-256-GCM encrypted. */
  stateEnc: text('state_enc'),

  /**
   * Encryption key version, matching `whatsapp_channels.keyVersion`. Without it a key
   * rotation cannot find sessions to re-wrap, and they fail at first decrypt with
   * "no encryption key for version" long after the rotation.
   */
  keyVersion: text('key_version').notNull().default('v1'),

  /** E.164 digits, e.g. 966501234567. Discovered on `open`; null while pairing. */
  phone: text('phone'),

  /** 'idle' | 'connecting' | 'qr' | 'open' | 'logged_out' | 'replaced' | 'error' */
  status: text('status').notNull().default('idle'),

  lastError: text('last_error'),
  updatedAt: ts(),
});
```

`whatsapp_channels` is **unchanged** and remains Meta-only. `onDelete: 'cascade'` matches it.

### `drizzle/0015_whatsapp_baileys.sql`

```sql
CREATE TABLE IF NOT EXISTS whatsapp_baileys_sessions (
  store_id    uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  state_enc   text,
  key_version text NOT NULL DEFAULT 'v1',
  phone       text,
  status      text NOT NULL DEFAULT 'idle',
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_baileys_sessions_status_idx
  ON whatsapp_baileys_sessions (status);
```

Also add to `drizzle/meta/_journal.json` (currently 15 entries, last `0014_attribution_impressions`):

```json
{ "idx": 15, "version": "7", "when": <timestamp>, "tag": "0015_whatsapp_baileys", "breakpoints": true }
```

> Migrations are an **operator step on Render**, not a deploy step — free web services
> cannot run one-off jobs, and a `preDeployCommand` makes Render reject the entire Blueprint
> (`render.yaml:62-67`). Run `PGADMIN_URL=… npm run db:bootstrap` from CI or a shell before
> deploying. Existing order: `db:bootstrap` = `db:migrate` + `db:apply-rls`.

---

## 5. Layer 3 — Baileys session manager

### 5.1 `src/services/whatsappSession.ts`

**[CORRECTED] Highest-risk file in this plan.** The original's `makeCacheableSignalKeyStore(/* … */)`
was a stub, and it imported `useMultiFileAuthState` in the same sketch that described a custom
adapter. The `SignalKeyStore` contract is the part that must be exactly right.

**[CORRECTED AGAIN, at implementation time]** The package is `baileys`, not
`@whiskeysockets/baileys` — the scoped name is the abandoned pre-fork address, and installing it
would pull a different, incompatible tree. Baileys 6.x also replaced the per-id
`SignalDataStore` interface with a **bulk** `SignalKeyStore`; see §5.3, which is now written
against the real API rather than the sketch.

```ts
import { makeWASocket, DisconnectReason, initAuthCreds } from 'baileys';
import type {
  AuthenticationState,
  AuthenticationCreds,
  SignalKeyStore,
  SignalDataSet,
  WASocket,
} from 'baileys';
```

`baileys` is loaded through a local `requireBaileys()` helper (a memoised dynamic `import`) so the
module is never evaluated when the feature flag is off (§8). Types are imported with `import type`
and therefore erased at build time, so the flag-off path carries no runtime dependency.

### 5.2 JID normalisation — `src/lib/phone.ts`

New file. Addresses §2 row 4.

```ts
/** '966501234567@s.whatsapp.net' | '…@c.us' | '…@lid' | '…:12' -> '966501234567' */
export function normalizeJid(input: string): string | null;

/** '966501234567' -> '966501234567@s.whatsapp.net' */
export function toJid(digits: string): string | null;
```

Strips `@s.whatsapp.net`, `@c.us`, `@lid`, and the `:device` part. Returns `null` rather than
an empty string for non-numeric input, so a malformed JID fails loudly at the boundary instead
of sending to `@s.whatsapp.net`.

Both directions are needed: inbound `remoteJid` must be reduced to digits before
`customerRepo.upsert({ phone })`, and outbound `sendText` must re-attach the suffix.

### 5.3 Auth state

**[CORRECTED]** Baileys 6.x switched from per-id key methods to **bulk** key operations. The store
implements `SignalKeyStore` with `get(type, ids[])` and `set(SignalDataSet)`, not individual
`get/set` by id. The sketch's `SignalDataStore` pseudocode is **obsolete** and will not compile against
`baileys@6.7.24`.

The implementation persists the entire `{ creds, keys }` object as one encrypted JSON blob in
`whatsapp_baileys_sessions.stateEnc` (see `decryptState`/`saveState` in `src/db/repos.ts`). Keys are
seeded into an in-memory cache on load; a null value passed to `set` is the Baileys deletion signal
and is treated as `m.delete(id)` rather than writing `null` back to the persisted blob.

```ts
const cache = new Map<string, Map<string, unknown>>();
for (const [type, set] of Object.entries(storedKeys)) {
  const m = new Map<string, unknown>();
  for (const [id, value] of Object.entries(set ?? {})) {
    if (value != null) m.set(id, value);
  }
  cache.set(type, m);
}

const store: SignalKeyStore = {
  async get(type, ids) {
    const m = cache.get(type);
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const v = m?.get(id);
      if (v !== undefined) out[id] = v;
    }
    return out as never;
  },
  async set(data) {
    for (const [type, entries] of Object.entries(data)) {
      const m = cache.get(type) ?? new Map();
      for (const [id, v] of Object.entries(entries ?? {})) {
        if (v == null) m.delete(id);
        else m.set(id, v);
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
const { makeCacheableSignalKeyStore } = requireBaileys();
return { creds, keys: makeCacheableSignalKeyStore(store), flush };
```

- The whole `{ creds, keys }` state serialises to one JSON blob in `stateEnc`.
- Persist on every `credsUpdated` (these are rare and critical).
- **Debounce `keys` writes.** Persisting on every `keys.set` hammers Postgres; Baileys writes
  pre-key/session records in bursts.
- `decryptKey()` failure (e.g. after an encryption key rotation) must be caught, and the
  session marked `status: 'error'` with a clear message — not crash the process at startup.

Unit-test the `SignalDataStore` implementation against Baileys' own in-memory reference
*before* wiring the socket. This is the part most likely to be subtly wrong.

### 5.4 Connection lifecycle

```ts
sock.ev.on('connection.update', ({ connection }) => {
  if (connection === 'open') { /* discover phone, persist, emit 'open' */ }
});

sock.ev.on('connection.close', ({ lastDisconnect }) => {
  const reason = lastDisconnect?.error?.output?.statusCode;
  if (reason === DisconnectReason.loggedOut) {
    // Merchant unlinked the device, or 401 auth failure. Cannot reconnect.
    await repo.clear(storeId);
    emit({ type: 'disconnected', reason: 'logged_out', needsRescan: true });
    return;                                   // do NOT reconnect
  }
  if (reason === DisconnectReason.connectionReplaced) {
    // [CORRECTED] WhatsApp kicked us because the same account connected elsewhere.
    // Must clear creds, or the UI claims "Connected" while messages go nowhere and
    // the merchant has no way to discover why.
    await repo.clear(storeId);
    emit({ type: 'disconnected', reason: 'replaced', needsRescan: true });
    return;
  }
  scheduleReconnect();                        // backoff + jitter, capped
});
```

Reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s, 60s (cap), each ±20% jitter. **[CORRECTED]** Fast
reconnect loops are the documented trigger for Meta rate-limiting or banning a number
(§1.1), so the cap and jitter are load-bearing, not cosmetic.

### 5.4a One-session enforcement

**[NEW]** Enforced in `startSession`, before any socket is opened:

```ts
const open = await repo.listOpen();
if (open.length >= config.WHATSAPP_BAILEYS_MAX_SESSIONS && !open.includes(storeId)) {
  throw new SessionLimitError(open.length);
}
```

`MAX_SESSIONS` is `1` (§1.2). A store re-pairing its *own* existing session is exempt, so a
re-scan after `replaced` (§5.4) is not blocked by its own prior row — otherwise the re-scan path
would deadlock against the limit it just tripped.

### 5.5 Replica ownership

```ts
const LEASE_NAME = 'whatsapp:baileys';
const lease = await acquireLock(LEASE_NAME, LEASE_TTL_MS);
if (!lease) throw new SessionBusyError(); // another replica owns the session
const leaseTimer = setInterval(() => {
  void lease.renew().then((ok) => {
    if (!ok) {
      logger.warn({ storeId }, 'whatsapp: lease lost, closing session');
      void stopSession(storeId, { logout: false });
    }
  });
}, LEASE_TTL_MS / 3);
leaseTimer.unref?.();

// If loadAuthState throws (decrypt failure) the lease and timer are released
// before bubbling the error (§5.1/5.3), so the global lease cannot be stranded.
```

Renewing at a third of the TTL matches `withLock`'s existing rationale (`src/lib/lock.ts:105-108`).
If renewal fails — Render restart, Redis blip — stop renewing, let the lease lapse, and let
another replica take over. `restoreAllSessions()` on startup is safe under this model.

### 5.6 Event fan-out

**[CORRECTED]** The original used one global `EventEmitter` and filtered by `storeId` in the
listener. Replace with a per-store subscriber map: O(1) add/remove, no cross-store leakage,
and no listener leak on a dropped SSE connection.

---

## 6. Layer 4 — Inbound and dispatch

### 6.1 Inbound: `messages.upsert`

**[CORRECTED] This is the product.** It did not exist in the original plan; the verification
section assumed it did.

```ts
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const m of messages) {
    if (m.key.fromMe) continue;                                    // never echo our own sends
    if (!m.message?.conversation) continue;                       // skip status/broadcast updates
    const phone = normalizeJid(m.key.remoteJid ?? '');
    if (!phone) continue;
    if (throttled(storeId, phone)) continue;                      // [NEW] see below
    const text = m.message.conversation;
    if (typeof text !== 'string' || !text.trim()) continue;
    await handleInboundText(storeId, phone, text);
  }
});
```

Reuses the **existing** `handleInboundText` (`src/routes/whatsapp.ts:91`) unchanged, so
conversation upsert, history, and the agent call are shared with the Meta path.

### 6.1a Media messages — decline explicitly, never silently

**Decision:** the bot replies *"Sorry, I cannot read images at the moment."* and drops the
attachment.

The failure this prevents is the important part. A handler that only reads
`m.message.conversation` sees an image as "no text" and skips it — the merchant sends a photo of
a product, gets nothing at all, and concludes the bot is broken. Silent drops read as outages.

```ts
const MEDIA_UNSUPPORTED = 'Sorry, I cannot read images at the moment.';

const MEDIA_KEYS = [
  'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage',
  'locationMessage', 'contactMessage',
] as const;

function classify(message: BaileysMessage): 'text' | 'media' | 'ignore' {
  if (typeof message.conversation === 'string' && message.conversation.trim()) return 'text';
  for (const k of MEDIA_KEYS) if (k in message) return 'media';
  return 'ignore';   // receipts, reactions, protocol noise, unknown types
}
```

Rules for the `media` branch:

- Reply via the same `sendText` dispatch as any other reply, so a media-only inbound still
  exercises the transport and the merchant sees the bot is alive.
- **No LLM call.** The agent cannot see the image, so calling it would spend tokens to produce
  a generic reply and risk it hallucinating a description of content it never received.
- **No conversation write.** A `messages` row needs a `user` turn to pair with, and there is
  no text to store. Writing an assistant row alone would leave an orphan message in the
  transcript, and the dashboard renders message order — an assistant message with no preceding
  user message looks like a bug. The interaction is recorded as an `eventRepo` row instead,
  so it is observable in logs without corrupting the transcript.
- The throttle (§6.1) applies here too, or a contact sending rapid images becomes a send loop.
- **`reactionMessage` is deliberately not in `MEDIA_KEYS`**, so it classifies as `ignore`. A
  reaction carries no text and no image the merchant expects a reply to; answering a 👍 with
  "I cannot read images" is worse than staying quiet.

The string is a module constant, not inline text, so changing the wording later is a
one-line edit and the test asserts against the constant rather than a duplicated literal.

**[NEW] Per-phone throttle.** The Meta webhook is signature-verified, so its inbound is already
trusted. Baileys inbound arrives over an authenticated socket but is still *arbitrary* traffic
from anyone who messages the merchant's number, and each message reaches `answerWithTools` —
real LLM spend. A spammer could burn the merchant's budget in minutes. A short per-phone
cooldown (Redis, mirroring `storeRateLimitWindow`'s approach) is the minimum.

### 6.2 `src/lib/phone.ts` consumers

`handleInboundText` stores `phone` via `customerRepo.upsert({ phone })`. That column is
compared against order phone numbers in `markConversionsForOrder`, so the value must be bare
E.164 digits — which is exactly what `normalizeJid` returns. No change needed there.

### 6.3 `src/integrations/whatsapp.ts` — unified dispatch

**[CORRECTED]** The original dispatched on a stored `connectionType` column. Dispatch on
**live session state** instead, because a stored flag lies: the row can say `baileys` while the
socket is down after a free-tier sleep.

```ts
export async function sendText(to: string, body: string, storeId: string): Promise<boolean> {
const live = sessionManager.socketFor(storeId);
if (live) return sendViaSocket(storeId, to, body);
const channel = await whatsappRepo.byStore(storeId);
if (channel) return sendViaMeta(to, body, channel);
return false;
```

**Signature change:** `sendText` currently takes `(to, body, channel)` and callers look the
channel up themselves. Both call sites (`src/routes/whatsapp.ts:102`, automation) must switch
to passing `storeId`, and `handleInboundText` must stop calling `whatsappRepo.byStore`
(`src/routes/whatsapp.ts:101`) — otherwise a Baileys-only store, which has **no**
`whatsapp_channels` row, sends nothing.

### 6.4 Disconnect semantics

**[CORRECTED]** `stopSession()` must call `sock.logout()`, not `sock.end()`.

| Call | Effect |
|---|---|
| `sock.end()` | Drops the server-side session. Device **stays linked** in the merchant's WhatsApp, occupying a Linked-Devices slot they can only clear by hand. |
| `sock.logout()` | Sends a logout request, unlinking the device remotely. |

On the free tier this matters more than usual: a trial merchant who cannot unlink cleanly will
hit WhatsApp's 4-linked-device limit and break their *primary* phone.

---

## 7. Layer 5 — Fastify routes

### 7.1 Four routes, all `requireDashboard` with a storeId ref

```ts
const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
```

- `POST /api/whatsapp/qr-connect` — start pairing. **[CORRECTED] + `storeRateLimitWindow`**
  (matches every other mutating route; the original had none, so a client could loop-restart
  sessions and each restart is a fresh QR handshake).
  **[NEW] Gated on the ToS acknowledgement (§1.3)** — `403 tos_not_acknowledged` until
  `stores.settings.whatsappQrAcknowledged` matches the current terms version. Enforced here
  rather than only in the UI, because this is the route that creates the session and a client
  that skips the interstitial must not get a number.
  **[NEW] Enforces the one-number limit (§1.2)** — `409 session_limit_reached` when
  `MAX_SESSIONS` sessions are already open.
- `DELETE /api/whatsapp/qr-disconnect` — `sock.logout()` then `repo.clear()`.
- `GET /api/whatsapp/qr-status` — **[NEW]** `{ status, phone, needsRescan, lastError }`, so the
  card renders correct state on page load. Without it the UI only learns state from a live event.
- `GET /api/whatsapp/qr-stream` — SSE, below.

Authorization: `requireDashboard((req) => …storeId, { allowStoreKey: true })`, consistent with
`POST /api/whatsapp/channels`. A client-admin user pairing a customer's number is legitimate.

### 7.2 SSE

**[CORRECTED]** The original sketch omitted everything that makes SSE work behind a proxy.

```ts
export const dynamic = 'force-dynamic';   // Next.js must not cache this route
```

- `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`.
- **No response buffering.** Render's edge will hold a buffered stream indefinitely.
- **Keepalive `: ping` comment every ~20s.** Both Render and nginx close idle streams; a QR wait
  can exceed 30s while a merchant fetches their phone.
- **Guard every write with `reply.raw.writableEnded`.** The original's bare
  `reply.raw.write()` throws on a closed socket and crashes the handler.
- `req.raw.on('close', cleanup)` to unsubscribe (§5.6).
- Auth rides the **same-origin cookie** — `EventSource` cannot set headers, which is precisely
  why this must be a BFF proxy route and not a direct browser→API call.

**`connect-src 'self'`** (`web/proxy.ts:51`) already covers a same-origin `/api/` stream. No
CSP change needed. The QR image is a `data:` URL and `img-src 'self' data: blob:`
(`web/proxy.ts:47`) already allows it. The original's §9 assessment was correct.

---

## 8. Layer 6 — Config

```diff
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),
+ /** Gates the entire QR feature. Off by default: see §1.1. */
+ WHATSAPP_BAILEYS_ENABLED: z.enum(['1', '0', 'true', 'false']).default('0'),
+ /** One number per deployment (§1.2). Coincides with the free tier's memory ceiling. */
+ WHATSAPP_BAILEYS_MAX_SESSIONS: z.coerce.number().int().positive().default(1),
+ /** Terms version a store must have acknowledged. Bump to re-prompt every merchant. */
+ WHATSAPP_BAILEYS_TOS_VERSION: z.string().default('2026-01'),
```

Route registration and `restoreAllSessions()` both check `WHATSAPP_BAILEYS_ENABLED`. With it
off, Baileys is never imported at runtime, no socket opens, and the UI card is hidden.

---

## 9. Layer 7 — Frontend

### 9.1 `web/lib/api.ts`

```ts
whatsappQrConnect:  (storeId: string) => request<{ ok: true }>('/api/whatsapp/qr-connect', { method: 'POST', body: { storeId } }),
whatsappQrDisconnect: (storeId: string) => request<{ ok: true }>('/api/whatsapp/qr-disconnect', { method: 'DELETE', body: { storeId } }),
whatsappQrStatus:   (storeId: string) => request<QrStatus>('/api/whatsapp/qr-status'),
```

### 9.2 `web/components/dashboard/WhatsAppQrCard.tsx` (new)

States: `tos | idle | connecting | qr | open | needsRescan | limitReached | error`. Beyond the
original sketch:

- **`tos` is the first state, and it gates the rest** (§1.3). The component does not request a
  QR until acceptance is recorded. A separate acknowledgement call persists
  `stores.settings.whatsappQrAcknowledged = { version, at }`.
- **[NEW] `limitReached`** for the one-number case (§1.2), stating it as a product limit
  rather than surfacing a raw `409`.
- **ToS wording before access**, not inside the card. Restated here so the component author
  does not reintroduce it as a checkbox.
- **Load state from `qr-status` on mount**, not only from live events.
- **`needsRescan` state** for `logged_out` / `replaced` — distinct from `error`, and it must
  offer a re-scan button. After a free-tier sleep this is the *expected* path, not a failure.
- **Trial notice** when sessions are capped at 1: "Trial instance — this connection may drop
  after 15 minutes of inactivity."
- SSE reconnect: `EventSource` auto-reconnects, but the server only holds the stream open while
  pairing. On error, re-`connect()` rather than showing a hard error.
- **[NEW] Media notice is not rendered here** — the unsupported-media reply is a WhatsApp-side
  message (§6.1a), not a dashboard concern.

### 9.3 `web/app/dashboard/settings/page.tsx`

Render `<WhatsAppQrCard storeId={storeId} />` in the existing grid beside the Meta card, gated on
`whatsappQrStatus` succeeding (i.e. the feature is enabled). The Meta card is untouched.

### 9.4 BFF proxy routes + allowlist

New: `web/app/api/whatsapp/qr-connect|qr-stream|qr-disconnect|qr-status/route.ts`.

**[CORRECTED] Also update `web/lib/server/upstream.spec.ts`.** Its `CLIENT_CALL_SITES` table is
hand-maintained and is the *only* thing enforcing parity between the client's `api` object and
the proxy allowlist — the file's own header says so. Adding call sites without updating it lets
the two drift with no type error, and the call fails at runtime with a 404.

Whether these go through the generic `[...path]` proxy or dedicated routes: the SSE route needs
dedicated handling for streaming, so all four should be dedicated for consistency.

---

## 10. Layer 8 — Server startup

```ts
if (config.WHATSAPP_BAILEYS_ENABLED) {
  const { restoreAllSessions } = await import('./services/whatsappSession.js');
  void restoreAllSessions();     // lease-gated: see §5.5
}
```

Dynamic `import()` so Baileys is not loaded when the feature is off — it is a large dependency
and pulls in `libsignal`. `restoreAllSessions` honours `MAX_SESSIONS` and per-store leases.

---

## 11. Tests

**[CORRECTED]** The original verification was manual-only. The repo runs 468 tests; this adds
socket lifecycle, credential storage, and inbound routing. The socket itself is mocked; the
logic around it is not.

| Area | Coverage |
|---|---|
| `src/lib/phone.ts` | `normalizeJid` strips `@s.whatsapp.net` / `@c.us` / `@lid` / `:device`; `toJid` re-attaches; round-trip; returns `null` for empty/non-numeric; case-insensitive |
| Auth state | Bulk `SignalKeyStore` `get`/`set`/`clear`; a key Baileys wrote earlier is readable without a re-read; a `null` write deletes and is not served back from the persisted blob; `flush()` writes keys through to `saveState`; decrypt failure surfaces a re-pair error and leaves no live session |
| Lifecycle | `loggedOut` and `connectionReplaced` both clear `stateEnc`; neither schedules a reconnect; other reasons back off with jitter and cap at 60s |
| Dispatch | open session → socket; no session + Meta row → Graph; neither → `false`; Baileys-only store (no `whatsapp_channels` row) still sends |
| Inbound | `messages.upsert` calls `handleInboundText` with bare digits; `fromMe` skipped; non-conversation skipped; throttle suppresses repeats |
| Media (§6.1a) | image/video/audio/document/sticker/location/contact → replies `MEDIA_UNSUPPORTED` exactly; **no `answerWithTools` call**; **no `messages` row written**; an `eventRepo` row is written instead; `reactionMessage` → `ignore`, no reply; unknown types → `ignore`; text wins over media when both present; throttle suppresses a media-send loop |
| ToS gate (§1.3) | `qr-connect` → `403 tos_not_acknowledged` with no acknowledgement; succeeds once acknowledged at the current version; a stale version re-prompts; a client that bypasses the UI still gets `403` |
| Session limit (§1.2) | second store refused with `409 session_limit_reached`; a store re-pairing its **own** session is **not** refused (the `replaced` re-scan path must not deadlock against its own limit) |
| Routes | `qr-connect` rate-limited; `qr-disconnect` calls `logout()` not `end()`; `qr-stream` refuses another store's events; `qr-status` requires auth; feature flag off → 404 |
| Lease | second replica does not open a socket for a store already leased; a decrypt failure releases the lease and stops the renewal timer so the global lease cannot be stranded, and the number stays immediately re-pairable |
| Schema/migration | `0015` applies cleanly; journal index is 16 |
| Allowlist | `upstream.spec.ts` `CLIENT_CALL_SITES` covers all four new paths |

**Assertion to write deliberately:** a regression test that a free-tier-style disconnect
(`status !== 'open'`) falls back to the Meta transport rather than reporting a send that never
happened. This is the failure mode most likely to recur on the trial tier.

---

## 12. Files

| File | Action | Notes |
|---|---|---|
| `package.json` | MODIFY | `baileys@6.7.24` (pinned legacy), `qrcode@1.5.4`, `@types/qrcode@^1.5.6` |
| `src/config.ts` | MODIFY | `WHATSAPP_BAILEYS_ENABLED`, `WHATSAPP_BAILEYS_MAX_SESSIONS` |
| `src/db/schema.ts` | MODIFY | `whatsappBaileysSessions` table |
| `drizzle/0015_whatsapp_baileys.sql` | NEW | `CREATE TABLE` + status index |
| `drizzle/meta/_journal.json` | MODIFY | entry `idx: 15` |
| `src/lib/phone.ts` | NEW | JID normalisation |
| `src/services/whatsappSession.ts` | NEW | socket lifecycle, DB auth state, lease, inbound handler (QR rendered server-side) |
| `src/db/repos.ts` | MODIFY | `baileysSessionRepo` |
| `src/routes/whatsapp.ts` | MODIFY | 4 routes |
| `src/integrations/whatsapp.ts` | MODIFY | dispatch on live session state; signature takes `storeId` (Meta channel is still preferred in the current dispatch order; reconcile if Baileys becomes primary) |
| `src/server.ts` | MODIFY | flag-gated dynamic import + `restoreAllSessions()` |
| `web/lib/api.ts` | MODIFY | 4 client methods |
| `web/lib/server/upstream.spec.ts` | MODIFY | `CLIENT_CALL_SITES` parity |
| `web/components/dashboard/WhatsAppQrCard.tsx` | NEW | pairing UI, ToS gate, rescan, limit-reached |
| `web/app/dashboard/settings/page.tsx` | MODIFY | render the card |
| `web/app/api/whatsapp/*/route.ts` | NEW | 4 BFF routes |
| `src/lib/phone.spec.ts` | NEW | JID tests |
| `src/services/whatsappSession.spec.ts` | NEW | auth state, lifecycle, lease |
| `src/services/whatsappInbound.ts` | NEW | shared inbound handler for both Meta webhook and Baileys socket; breaks the route↔session import cycle |
| `src/integrations/whatsapp.spec.ts` | NEW | dispatch matrix |
| `DEPLOYMENT.md` | MODIFY | migration step, tier config |

`web/public/widget.js`, `drizzle/0013_*`, `drizzle/0014_*` are unrelated prior work — untouched.

---

## 13. Verification

### Automated

```bash
npm run typecheck && npm test && npm run lint
cd web && npx tsc --noEmit && npx vitest run
node scripts/smoke-bff.mjs          # 80 checks
npm audit                           # expect 0 new findings
```

### Migration (operator step, before deploy)

```bash
PGADMIN_URL=postgres://agent_owner:… npm run db:bootstrap
```

Free Render cannot run one-off jobs and rejects any Blueprint containing a
`preDeployCommand` — see `render.yaml:62-67`. This is not optional and not automated.

### Manual — on a **paid** instance

1. `WHATSAPP_BAILEYS_ENABLED=1`, `WHATSAPP_BAILEYS_MAX_SESSIONS=1`.
2. Open `/dashboard/settings` — the pairing card appears below the Meta card, with the ToS notice.
3. Decline the ToS → no QR is shown.
4. Accept → QR within ~3s. Reload mid-pairing → `qr-status` still reports the pending session.
5. Scan via WhatsApp → Linked Devices → Link a Device.
6. Badge shows the discovered E.164 number.
7. **Message the number from a second phone** → the agent replies. *This is the step the
   original plan assumed worked and had no code for.*
8. Restart the API → session restores, no re-scan.
9. Link the same account from a second device → this instance reports `needsRescan`; the UI
   offers a fresh QR rather than claiming to be connected.
10. Disconnect → the device disappears from the merchant's Linked Devices list.
11. Force `MAX_SESSIONS=1` and pair a second store → the second is refused with a clear message.
12. Set the flag to `0` and restart → no socket opens, the card is hidden.

---

## 14. Decisions — resolved

All three previously-open questions are now answered and folded into the sections above.

| Question | Decision | Where |
|---|---|---|
| Media handling | Bot replies *"Sorry, I cannot read images at the moment."* and drops the attachment. No LLM call, no conversation write, `eventRepo` row instead. Reactions ignored. | §6.1a |
| Usage limits | **One WhatsApp number** per deployment, enforced in `startSession` and on `qr-connect`. A store re-pairing its own session is exempt. | §1.2, §5.4a, §7.1 |
| Warning placement | **Before the user accesses the service.** A gating interstitial ahead of the pairing flow, enforced server-side with a versioned acknowledgement. | §1.3, §7.1, §9.2 |

### Not decided, and intentionally so

- **Localisation of the unsupported-media string.** It is a module constant
  (`MEDIA_UNSUPPORTED`, §6.1a), so translating it later is a one-line change per locale. The
  plan pins the English string as specified; the agent itself replies in Arabic in this
  deployment, so a bilingual merchant will see one English and one Arabic reply. Worth a
  decision before launch, not before implementation.
- **Media support itself** (actually reading images). Explicitly out of scope for v1. The
  decision here is how to decline, not how to eventually accept.

---

## 15. Post-implementation corrections

Found by `scripts/verify-baileys-esm.mjs`, which compiles the service with the project's own
tsconfig and runs it under plain Node with only the DB/Redis layer stubbed. Vitest transpiles to
CJS and injects `require`, and every unit test injects a socket factory, so neither issue below
was reachable from the suite. Both surfaced as `500` from `POST /api/whatsapp/qr-connect` once the
flag was enabled on Render.

### 15.1 `require('baileys')` is a ReferenceError in this package

`package.json` is `"type": "module"`, so the emitted JS is ESM and a bare `require` is not
defined. `requireBaileys()` now uses a memoised dynamic `import('baileys')` and returns a promise;
`loadAuthState` and `createSocket` await it, and `createSocket` is async. `SocketFactory` widened to
allow a promise so the test seam still works.

### 15.2 The silent Baileys logger was not a logger

`silentLogger()` returned `{ level: 'silent', child: { level: 'silent' } }`. Baileys constructs its
internal sub-loggers with `logger.child({ module })`, so `child` must be a **callable function**.
The plain object threw `TypeError: logger.child is not a function` inside `makeWASocket`, before any
socket existed — a second, independent 500 on the same route. It now returns no-op level methods
plus `child: () => ({ ...base })`.

### 15.3 Why the suite could not see either

Both bugs live in code that only executes outside Vitest: a bare `require` in an ESM package, and
Baileys' own internals. The unit suite reaches the service through `__setSocketFactory`, so
`makeWASocket` is never called and `requireBaileys` never has to resolve.

`src/services/whatsappModuleLoading.spec.ts` pins all of it: it executes the harness as a test, and
asserts the source contains `import('baileys')` rather than `require('baileys')` and that every
`requireBaileys()` call site awaits. Verified by mutation — reverting either fix turns the new test
red.
