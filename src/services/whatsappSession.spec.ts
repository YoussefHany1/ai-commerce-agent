import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mocked before importing the service under test: it reaches Baileys at module scope
// through requireBaileys(), and the repo/Redis layer has no test database.
const repo = {
  get: vi.fn(),
  listAll: vi.fn(),
  listOpen: vi.fn(),
  saveState: vi.fn(),
  setStatus: vi.fn(),
  clear: vi.fn(),
  decryptState: vi.fn(),
};
const events = { record: vi.fn() };
const inbound = { handleInboundText: vi.fn() };
const lock = { acquireLock: vi.fn() };
// Every lease the service acquires, in order, so a test can assert on release/renew.
let leaseMocks: Array<{ renew: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];

vi.mock('../db/repos.js', () => ({
  baileysSessionRepo: repo,
  eventRepo: events,
  customerRepo: {},
  conversationRepo: {},
  storeRepo: {},
  whatsappRepo: {},
}));
vi.mock('./whatsappInbound.js', () => inbound);
vi.mock('../lib/lock.js', () => ({ acquireLock: lock.acquireLock }));
vi.mock('baileys', () => ({
  makeCacheableSignalKeyStore: (store: unknown) => store,
  makeWASocket: vi.fn(),
  Browsers: { ubuntu: () => ['ubuntu', 'chrome', '1'] },
  // A new pairing seeds creds through this. The real one generates real keypairs;
  // the tests only need a non-empty object with the right field names, and the
  // harness in verify-baileys-esm.mjs covers the real thing end to end.
  initAuthCreds: () => ({
    noiseKey: undefined,
    signedIdentityKey: undefined,
    signedPreKey: undefined,
    registrationId: undefined,
    advSecretKey: undefined,
    firstUnuploadedPreKeyId: undefined,
    accountSyncCounter: undefined,
    accountChecksum: undefined,
    // Irrelevant to readiness: Baileys only sets `registered` at the end of companion
    // pairing, so a real paired device can legitimately report false.
    registered: false,
    deviceId: undefined,
    phoneId: 'test-device',
    identityKey: undefined,
    backupToken: undefined,
    registration: {},
    pairingCode: undefined,
    lastPropHash: undefined,
    routingInfo: undefined,
    deviceList: {},
    pairDeviceKey: undefined,
    signalSkew: undefined,
    platformType: 'unknown',
  }),
}));
// Mocked so the QR path is deterministic: the real module is dynamically imported on
// every QR, and its first load is slow enough to blow a waitFor window under parallel
// test load. Asserting against the mock also pins *what* the dashboard receives.
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async (payload: string) => `data:image/png;base64,RENDERED(${payload})`) },
}));

const session = await import('./whatsappSession.js');

const STORE = 'store-1';
const OTHER_STORE = 'store-2';

/** Minimal socket double; events are captured so tests can drive the lifecycle. */
function fakeSocket() {
  const handlers: Record<string, Array<(arg: any) => void>> = {};
  return {
    handlers,
    sent: [] as Array<{ jid: string; content: { text: string } }>,
    // Phone-pairing: the numbers handed to Baileys (so a test can prove normalisation)
    // and the code it returns. Overridable per test to simulate a rejected request.
    pairedCodes: [] as string[],
    pairingCode: 'ABCD-1234',
    requestPairingCode(phoneNumber: string) {
      this.pairedCodes.push(phoneNumber);
      return Promise.resolve(this.pairingCode);
    },
    ended: false,
    loggedOut: false,
    ev: {
      on(event: string, cb: (arg: any) => void) {
        (handlers[event] ??= []).push(cb);
      },
    },
    sendMessage(jid: string, content: { text: string }) {
      this.sent.push({ jid, content });
      return Promise.resolve({ key: {} });
    },
    logout() {
      this.loggedOut = true;
      return Promise.resolve();
    },
    end() {
      this.ended = true;
    },
    emit(event: string, arg: any) {
      for (const cb of handlers[event] ?? []) cb(arg);
    },
  };
}

let socket: ReturnType<typeof fakeSocket>;

beforeEach(() => {
  vi.clearAllMocks();
  session.__resetLiveForTest();
  socket = fakeSocket();
  // Per-store so a test can give one store a persisted row while another starts clean.
  repo.get.mockImplementation(async (storeId: string) =>
    storeId === STORE ? ({ stateEnc: 'enc:store-1', status: 'open' } as never) : null,
  );
  repo.listOpen.mockResolvedValue([]);
  repo.saveState.mockResolvedValue(undefined);
  repo.setStatus.mockResolvedValue(undefined);
  repo.clear.mockResolvedValue(undefined);
  // A restored paired device. `registered: false` is realistic: it is set only at the end
  // of companion pairing and never cleared, so it does not gate sending.
  repo.decryptState.mockReturnValue({
    creds: { registered: false, me: { id: '966501234567@s.whatsapp.net' } },
    keys: {},
  });
  events.record.mockResolvedValue(true);
  inbound.handleInboundText.mockResolvedValue(undefined);
  leaseMocks = [];
  lock.acquireLock.mockImplementation(async () => {
    const held = { renew: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) };
    leaseMocks.push(held);
    return held;
  });
  session.__setSocketFactory(() => socket);
});

afterEach(() => {
  session.__resetLiveForTest();
  session.__setSocketFactory(null);
  vi.useRealTimers();
});

describe('classifyInbound', () => {
  test('text', () => {
    expect(session.classifyInbound({ conversation: 'hello' })).toBe('text');
  });

  test('whitespace-only is not text', () => {
    expect(session.classifyInbound({ conversation: '   ' })).not.toBe('text');
  });

  test.each(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'locationMessage', 'contactMessage'])(
    '%s is media',
    (key) => {
      expect(session.classifyInbound({ [key]: {} })).toBe('media');
    },
  );

  test('a caption plus an image is text: the caption is what they meant to say', () => {
    expect(session.classifyInbound({ conversation: 'look at this', imageMessage: {} })).toBe('text');
  });

  test('reaction is ignored, not declined: answering a thumbs-up is worse than silence', () => {
    expect(session.classifyInbound({ reactionMessage: {} })).toBe('ignore');
  });

  test('unknown and empty payloads are ignored', () => {
    expect(session.classifyInbound({ protocolMessage: {} })).toBe('ignore');
    expect(session.classifyInbound({})).toBe('ignore');
    expect(session.classifyInbound(null)).toBe('ignore');
    expect(session.classifyInbound(undefined)).toBe('ignore');
  });
});

describe('session limit', () => {
  test('refuses a second store when the limit is met', async () => {
    repo.listOpen.mockResolvedValue([{ storeId: OTHER_STORE, status: 'open', phone: '966500000000' }]);
    await expect(session.startSession(STORE)).rejects.toBeInstanceOf(session.SessionLimitError);
  });

  test('a store re-pairing its own session is exempt, so a replace-reconnect cannot deadlock', async () => {
    repo.listOpen.mockResolvedValue([{ storeId: STORE, status: 'open', phone: '966501234567' }]);
    await expect(session.startSession(STORE)).resolves.toEqual({ resumed: false });
  });

  test('the limit is enforced before any socket is created', async () => {
    repo.listOpen.mockResolvedValue([{ storeId: OTHER_STORE, status: 'open', phone: '966500000000' }]);
    await session.startSession(STORE).catch(() => undefined);
    expect(session.socketFor(STORE)).toBeNull();
  });

  test('a logged-out session does not occupy the limit', async () => {
    // listOpen is what the repo filters; assert the default path is not blocked by a
    // terminal status by having the repo return only the other store as open.
    repo.listOpen.mockResolvedValue([{ storeId: OTHER_STORE, status: 'open', phone: '966500000000' }]);
    repo.get.mockResolvedValue({ stateEnc: 'enc:x', status: 'logged_out' } as never);
    repo.decryptState.mockReturnValue({ creds: {}, keys: {} });
    await expect(session.startSession(STORE)).rejects.toBeInstanceOf(session.SessionLimitError);
  });

  test('reports the open count so the UI can explain the limit', async () => {
    repo.listOpen.mockResolvedValue([{ storeId: OTHER_STORE, status: 'open', phone: '966500000000' }]);
    await session.startSession(STORE).catch((err: any) => {
      expect(err.openSessions).toBe(1);
    });
  });
});

describe('lease', () => {
  test('refuses to start when another replica holds the number', async () => {
    lock.acquireLock.mockResolvedValue(null);
    await expect(session.startSession(STORE)).rejects.toBeInstanceOf(session.SessionBusyError);
  });

  test('releases the lease on teardown', async () => {
    const release = vi.fn();
    lock.acquireLock.mockResolvedValue({ renew: vi.fn().mockResolvedValue(true), release });
    await session.startSession(STORE);
    await session.stopSession(STORE, { logout: false });
    expect(release).toHaveBeenCalled();
  });
});

describe('auth state', () => {
  test('persists creds and keys together, never creds alone', async () => {
    repo.decryptState.mockReturnValue({
      creds: { me: { id: '966501234567@s.whatsapp.net' } },
      keys: { 'pre-key': { '1': { a: 1 } } },
    });
    await session.startSession(STORE);
    socket.emit('creds.update', {});
    await vi.waitFor(() => expect(repo.saveState).toHaveBeenCalled());
    const saved = repo.saveState.mock.calls.at(-1)![1] as any;
    expect(saved).toHaveProperty('creds');
    expect(saved).toHaveProperty('keys');
  });

  test('reads a key that Baileys wrote earlier in the session', async () => {
    let authRef: { keys: any } | null = null;
    session.__setSocketFactory(({ auth }: any) => {
      authRef = auth;
      return socket;
    });
    repo.decryptState.mockReturnValue({ creds: {}, keys: {} });

    await session.startSession(STORE);
    const keys = authRef!.keys;
    await keys.set({ 'pre-key': { '7': { k: 'v' } } });
    expect(await keys.get('pre-key', ['7'])).toEqual({ '7': { k: 'v' } });
  });

  test('a key Baileys deleted is not served back from the persisted blob', async () => {
    // `keys` is Baileys' own makeCacheableSignalKeyStore wrapping our store, so this
    // asserts the two layers agree: our cache drops the null, so the pre-pairing blob
    // can never resurrect a key that WhatsApp has since invalidated.
    let authRef: { keys: any } | null = null;
    session.__setSocketFactory(({ auth }: any) => {
      authRef = auth;
      return socket;
    });
    repo.decryptState.mockReturnValue({ creds: {}, keys: { session: { abc: { x: 1 } } } });

    await session.startSession(STORE);
    const keys = authRef!.keys;
    expect(await keys.get('session', ['abc'])).toEqual({ abc: { x: 1 } });

    await keys.set({ session: { abc: null } });
    // Baileys reports a deleted id as null; what matters is it never resurfaces { x: 1 }.
    expect((await keys.get('session', ['abc'])).abc ?? null).toBeNull();
  });

  test('a full key flush writes the keys through to the persisted state', async () => {
    let authRef: { keys: any; flush: () => Promise<void> } | null = null;
    session.__setSocketFactory(({ auth }: any) => {
      authRef = auth;
      return socket;
    });
    repo.decryptState.mockReturnValue({ creds: {}, keys: {} });

    await session.startSession(STORE);
    await authRef!.keys.set({ 'pre-key': { '9': { a: 1 } } });
    await authRef!.flush();

    const saved = repo.saveState.mock.calls.at(-1)![1] as any;
    expect(saved.keys['pre-key']['9']).toEqual({ a: 1 });
  });

  test('refuses to connect when the stored state cannot be decrypted', async () => {
    repo.get.mockResolvedValue({ stateEnc: 'enc:x' } as never);
    repo.decryptState.mockImplementation(() => {
      throw new Error('bad key');
    });
    await expect(session.startSession(STORE)).rejects.toThrow(/could not be decrypted/);
    expect(session.socketFor(STORE)).toBeNull();
  });

  test('a decrypt failure leaves no live session rather than pairing over unread state', async () => {
    repo.get.mockResolvedValue({ stateEnc: 'enc:x' } as never);
    repo.decryptState.mockImplementation(() => {
      throw new Error('bad key');
    });
    await session.startSession(STORE).catch(() => undefined);
    expect(session.isLive(STORE)).toBe(false);
  });

  test('a decrypt failure releases the lease instead of wedging the number forever', async () => {
    // The lease is global and its renewal timer runs until cleared, so a stranded
    // lease would block pairing for every store, not just this one.
    repo.get.mockResolvedValue({ stateEnc: 'enc:x' } as never);
    repo.decryptState.mockImplementation(() => {
      throw new Error('bad key');
    });
    await session.startSession(STORE).catch(() => undefined);

    const held = leaseMocks[0];
    expect(held.release).toHaveBeenCalledTimes(1);
    // The renewal timer must be gone, so it cannot silently re-take the lease.
    expect(held.renew).not.toHaveBeenCalled();
    // And the number is immediately pairable again.
    repo.decryptState.mockReturnValue({ creds: {}, keys: {} });
    await session.startSession(STORE);
    expect(session.isLive(STORE)).toBe(true);
  });
});

describe('connection lifecycle', () => {
  test('reports qr when a QR arrives', async () => {
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'BASE64QR' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'qr')).toBe(true));
    expect(session.statusFor(STORE)).toBe('qr');
  });

  test('the QR is rendered server-side so the dashboard receives an image, not a raw payload', async () => {
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'BASE64QR' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'qr')).toBe(true));
    // The card renders this as an <img>, which is why CSP already allows data: images.
    expect(events.find((e) => e.type === 'qr').qr).toBe('data:image/png;base64,RENDERED(BASE64QR)');
  });

  test('remembers the last QR so a late subscriber can replay it', async () => {
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'BASE64QR' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'qr')).toBe(true));
    expect(session.qrFor(STORE)).toBe('data:image/png;base64,RENDERED(BASE64QR)');

    // Pairing completes: a stale QR must not be replayed to the next subscriber.
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    expect(session.qrFor(STORE)).toBeNull();
  });

  test('records the paired number on open, as bare digits', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    expect(session.livePhone(STORE)).toBe('966501234567');
  });

  test('loggedOut is terminal and never reconnects', async () => {
    vi.useFakeTimers();
    await session.startSession(STORE);
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.statusFor(STORE)).toBe('logged_out');
  });

  test('connectionReplaced is distinguished from loggedOut', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('replaced'));
  });

  test('connectionReplaced keeps the stored state so a re-scan is not needed', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('replaced'));
    expect(repo.clear).not.toHaveBeenCalled();
  });

  test('a re-emitted QR replaces the expired one instead of being dropped', async () => {
    // Baileys re-emits when the previous QR expires. The merchant scans whatever is on
    // screen, so a silently-ignored refresh means scanning an image that cannot work.
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'FIRST' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'qr')).toBe(true));
    socket.emit('connection.update', { qr: 'SECOND' });
    await vi.waitFor(() => expect(events.some((e) => e.qr?.includes('SECOND'))).toBe(true));
    expect(session.statusFor(STORE)).toBe('qr');
  });

  test('515 right after a scan is a restart, not a failure', async () => {
    // This is what WhatsApp sends once a pairing succeeds: restart with the new
    // credentials. Treating it as a plain transient close bounces the merchant back to
    // a spinner mid-handshake, which is what reads as a failed scan.
    vi.useFakeTimers();
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'BASE64QR' });
    await vi.advanceTimersByTimeAsync(50);
    // Everything the merchant sees from here on is what they judge us by.
    const afterScan = events.length;
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    const seen = events.slice(afterScan);
    // Must not flip them back to a spinner.
    expect(seen.filter((e) => e.status === 'connecting').length).toBe(0);
    expect(session.statusFor(STORE)).not.toBe('connecting');
    expect(session.statusFor(STORE)).toBe('qr');
    // The fresh credentials are persisted before the socket is replaced, so the
    // reconnect (and any redeploy) uses the identity WhatsApp just issued.
    expect(repo.saveState).toHaveBeenCalled();
  });

  test('a rejected pairing reports the pairing, not a bogus logout', async () => {
    // The phone said "couldn't log in"; telling the merchant their number is logged
    // out sends them hunting for a problem that does not exist.
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'BASE64QR' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'qr')).toBe(true));
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await vi.waitFor(() => {
      const err = events.find((e) => e.type === 'status' && e.status === 'error');
      expect(err?.error).toMatch(/pairing/i);
    });
    expect(session.statusFor(STORE)).toBe('error');
    // A half-finished handshake must not be reused as the basis for the next attempt.
    expect(repo.clear).toHaveBeenCalled();
  });

  test('a 401 on an already-linked number is still a logout', async () => {
    // The complement of the case above, and the reason the distinction is not based on
    // `phone`: it is null right up until a socket opens, including for a restored
    // session that has been paired for weeks.
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('logged_out'));
  });

  test('a transient close reconnects rather than ending the session', async () => {
    vi.useFakeTimers();
    await session.startSession(STORE);
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await vi.advanceTimersByTimeAsync(70_000);
    // Reconnect attempt runs, which re-enters startSession and rebuilds a socket.
    expect(lock.acquireLock).toHaveBeenCalled();
  });

  test('a socket that never opens is recycled instead of wedging the session forever', async () => {
    // The restored-session wedge: `connecting` is emitted, then nothing — no open, no
    // close, no error. Every send is refused and the row sits on `connecting` forever.
    vi.useFakeTimers();
    const created: Array<ReturnType<typeof fakeSocket>> = [];
    session.__setSocketFactory(() => {
      const s = fakeSocket();
      created.push(s);
      return s;
    });
    await session.startSession(STORE);
    expect(created).toHaveLength(1);
    created[0].emit('connection.update', { connection: 'connecting' });
    await vi.advanceTimersByTimeAsync(session.CONNECT_WATCHDOG_MS + 5_000);
    // The silent socket was torn down and a fresh one built from the same stored pairing.
    expect(created[0].ended).toBe(true);
    expect(created.length).toBeGreaterThan(1);
    expect(session.isLive(STORE)).toBe(true);
  });

  test('the watchdog stands down once the socket opens', async () => {
    vi.useFakeTimers();
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.statusFor(STORE)).toBe('open');
    await vi.advanceTimersByTimeAsync(session.CONNECT_WATCHDOG_MS + 5_000);
    expect(socket.ended).toBe(false);
    expect(session.statusFor(STORE)).toBe('open');
  });

  test('a pairing QR suppresses the watchdog, because a scan may take minutes', async () => {
    vi.useFakeTimers();
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'BASE64QR' });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.statusFor(STORE)).toBe('qr');
    await vi.advanceTimersByTimeAsync(session.CONNECT_WATCHDOG_MS + 5_000);
    expect(socket.ended).toBe(false);
  });

  test('end() is used for a transient drop, never logout()', async () => {
    vi.useFakeTimers();
    await session.startSession(STORE);
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.ended).toBe(true);
    expect(socket.loggedOut).toBe(false);
  });

  test('a reconnect reuses the in-memory auth state, not a possibly-stale stored blob', async () => {
    // The stored row trails the live socket by up to a second of debounced key writes.
    // Re-reading it here re-handshakes with a half-written device identity, which is
    // what makes a scanned pairing come back as "couldn't log in" a moment later.
    vi.useFakeTimers();
    await session.startSession(STORE);
    const readsBefore = repo.get.mock.calls.length;
    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(lock.acquireLock).toHaveBeenCalled();
    // One read for the original start; the reconnect must not add another.
    expect(repo.get.mock.calls.length).toBe(readsBefore);
  });

  test('an explicit disconnect forgets the in-memory auth state', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    await session.stopSession(STORE, { logout: true });
    // The next start must read the database rather than resume the unlinked device.
    const readsBefore = repo.get.mock.calls.length;
    await session.startSession(STORE);
    expect(repo.get.mock.calls.length).toBe(readsBefore + 1);
  });
});

describe('phone pairing', () => {
  /** A live session that has reached the QR stage, which is when a code can be minted. */
  async function atQrStage() {
    await session.startSession(STORE);
    socket.emit('connection.update', { qr: 'BASE64QR' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('qr'));
  }

  test('normalises the number to digits before handing it to Baileys', async () => {
    // Baileys passes the value straight to jidEncode without stripping separators, so a
    // "+966 50 123 4567" from the merchant would otherwise build a malformed JID.
    await atQrStage();
    await expect(session.requestPairingCode(STORE, '+966 50 123 4567')).resolves.toMatchObject({
      phone: '966501234567',
    });
    expect(socket.pairedCodes).toEqual(['966501234567']);
  });

  test('returns and emits the code, and reports the session as awaiting a scan', async () => {
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await atQrStage();
    socket.pairingCode = 'WXYZ-9876';

    await expect(session.requestPairingCode(STORE, '966501234567')).resolves.toEqual({
      pairingCode: 'WXYZ-9876',
      phone: '966501234567',
    });
    expect(events.some((e) => e.type === 'pairing_code' && e.pairingCode === 'WXYZ-9876')).toBe(true);
    expect(session.statusFor(STORE)).toBe('qr');
    expect(session.pairingCodeFor(STORE)).toBe('WXYZ-9876');
  });

  test('rejects a phone that has no usable digits without touching the socket', async () => {
    await session.startSession(STORE);
    await expect(session.requestPairingCode(STORE, '+()- ')).rejects.toBeInstanceOf(session.PairingPhoneError);
    expect(socket.pairedCodes).toHaveLength(0);
  });

  test('rejects a number that is too short to be international', async () => {
    await session.startSession(STORE);
    await expect(session.requestPairingCode(STORE, '12345')).rejects.toBeInstanceOf(session.PairingPhoneError);
  });

  test('refuses to mint a code on an already-linked number', async () => {
    // There is nothing to link once the socket is open, and Baileys would send an IQ that
    // the server rejects; fail early with a message the card can act on.
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    await expect(session.requestPairingCode(STORE, '966501234567')).rejects.toBeInstanceOf(
      session.PairingNotReadyError,
    );
  });

  test('explains a session that is not ready rather than hanging forever', async () => {
    vi.useFakeTimers();
    const pending = session.requestPairingCode(STORE, '966501234567');
    const rejected = expect(pending).rejects.toBeInstanceOf(session.PairingNotReadyError);
    await vi.advanceTimersByTimeAsync(session.PAIRING_READY_TIMEOUT_MS + 1_000);
    await rejected;
  });

  test('a rejected pairing after a code is requested reports pairing, not a logout', async () => {
    // The regression this guards: requestPairingCode pre-populates creds.me, which the
    // close handler would read as "this number was already linked, so 401 means logged
    // out". awaitingScan keeps the two apart.
    const events: any[] = [];
    session.subscribe(STORE, (e) => events.push(e));
    await atQrStage();
    await session.requestPairingCode(STORE, '966501234567');

    socket.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await vi.waitFor(() => {
      const err = events.find((e) => e.type === 'status' && e.status === 'error');
      expect(err?.error).toMatch(/pairing/i);
    });
    expect(session.statusFor(STORE)).toBe('error');
    expect(repo.clear).toHaveBeenCalled();
  });

  test('the replayed code is dropped once the number opens', async () => {
    await atQrStage();
    await session.requestPairingCode(STORE, '966501234567');
    expect(session.pairingCodeFor(STORE)).toBe('ABCD-1234');

    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    expect(session.pairingCodeFor(STORE)).toBeNull();
  });
});

describe('disconnect', () => {
  test('an explicit disconnect calls logout, which unlinks the number', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    await session.stopSession(STORE, { logout: true });
    expect(socket.loggedOut).toBe(true);
  });

  test('an explicit disconnect clears the stored state', async () => {
    await session.startSession(STORE);
    await session.stopSession(STORE, { logout: true });
    expect(repo.clear).toHaveBeenCalledWith(STORE);
  });

  test('disconnecting a store with no live session still clears state', async () => {
    await session.stopSession(STORE, { logout: true });
    expect(repo.clear).toHaveBeenCalledWith(STORE);
  });

  test('a hung logout is abandoned so the disconnect still completes', async () => {
    // The regression this guards: a wedged socket never answers the logout IQ, and Baileys
    // waits defaultQueryTimeoutMs (60s) for it. The dashboard's Reconnect is a
    // disconnect-then-connect, so that stall delayed the fresh QR by ~70s.
    await session.startSession(STORE);
    vi.useFakeTimers();
    // Never settles: the IQ reply never arrives on a dead socket.
    socket.logout = () => new Promise<void>(() => {});

    const stopped = session.stopSession(STORE, { logout: true });
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await stopped;

    expect(settled).toBe(true);
    expect(socket.ended).toBe(true);
    expect(repo.clear).toHaveBeenCalledWith(STORE);
    expect(session.statusFor(STORE)).toBe('logged_out');
  });
});

describe('inbound', () => {
  test('routes a text message to the shared inbound handler with bare digits', async () => {
    await session.startSession(STORE);
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '966501234567:12@s.whatsapp.net', fromMe: false }, message: { conversation: 'hi' } }],
    });
    await vi.waitFor(() => expect(inbound.handleInboundText).toHaveBeenCalledWith(STORE, '966501234567', 'hi'));
  });

  test('skips fromMe so the paired number does not talk to itself', async () => {
    await session.startSession(STORE);
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: true }, message: { conversation: 'hi' } }],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(inbound.handleInboundText).not.toHaveBeenCalled();
  });

  test('skips group JIDs', async () => {
    await session.startSession(STORE);
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '123-456@g.us', fromMe: false }, message: { conversation: 'hi' } }],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(inbound.handleInboundText).not.toHaveBeenCalled();
  });

  test('ignores a non-notify upsert type', async () => {
    await session.startSession(STORE);
    socket.emit('messages.upsert', {
      type: 'history',
      messages: [{ key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false }, message: { conversation: 'hi' } }],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(inbound.handleInboundText).not.toHaveBeenCalled();
  });

  test('an unsupported attachment is declined with the exact agreed wording', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));

    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false, id: 'm1' }, message: { imageMessage: {} } }],
    });

    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]!.content.text).toBe('Sorry, I cannot read images at the moment.');
  });

  test('the agreed wording is a constant so it can be changed in one place', () => {
    expect(session.MEDIA_UNSUPPORTED).toBe('Sorry, I cannot read images at the moment.');
  });

  test('declining media does not call the LLM', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false, id: 'm2' }, message: { imageMessage: {} } }],
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(inbound.handleInboundText).not.toHaveBeenCalled();
  });

  test('declining media is recorded as an event, not a conversation message', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false, id: 'm3' }, message: { imageMessage: {} } }],
    });
    await vi.waitFor(() => expect(events.record).toHaveBeenCalled());
    expect(events.record.mock.calls.at(-1)![0]).toMatchObject({ type: 'whatsapp.media_unsupported', dedupKey: 'm3' });
  });

  test('a reaction gets no reply at all', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false, id: 'm4' }, message: { reactionMessage: {} } }],
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(socket.sent).toHaveLength(0);
  });

  test('rapid messages from one contact are throttled, so images cannot become a send loop', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    const batch = {
      type: 'notify',
      messages: [
        { key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false, id: 'a' }, message: { imageMessage: {} } },
        { key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false, id: 'b' }, message: { imageMessage: {} } },
        { key: { remoteJid: '966501234567@s.whatsapp.net', fromMe: false, id: 'c' }, message: { imageMessage: {} } },
      ],
    };
    socket.emit('messages.upsert', batch);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 40));
    expect(socket.sent).toHaveLength(1);
  });
});

describe('sending', () => {
  test('sends over the socket when open', async () => {
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    await expect(session.sendTextOverSocket(STORE, '966509999999', 'hello')).resolves.toBe(true);
    expect(socket.sent.at(-1)!.jid).toBe('966509999999@s.whatsapp.net');
  });

  test('refuses to send when the socket is not open', async () => {
    await session.startSession(STORE);
    await expect(session.sendTextOverSocket(STORE, '966509999999', 'hello')).resolves.toBe(false);
    expect(socket.sent).toHaveLength(0);
  });

  test('replies to a LID contact on its LID, not on a phone-number JID', async () => {
    // Regression: the contact wrote in from `...@lid`. Reducing to digits and
    // rebuilding `@s.whatsapp.net` addressed an identity it does not have. The write
    // succeeded, so `sent` was logged and nothing ever arrived.
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));

    // An attachment still triggers an immediate reply (the "can't read this" notice), so
    // this exercises the send path without depending on the AI/automation mocks.
    socket.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '51848895557795@lid', fromMe: false, id: 'LIDMSG1' }, message: { imageMessage: {} } }],
    });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent.at(-1)!.jid).toBe('51848895557795@lid');
  });

  test('sends on an open socket even when creds.registered is false', async () => {
    // Regression: `registered` was used as a send gate. Baileys sets it in exactly one
    // place (the end of companion pairing) and never clears it, so a long-lived paired
    // session reports false forever. The gate refused every send on a working socket and
    // the automation layer recorded `failed` — indistinguishable from a rule that never
    // matched, which is exactly how it presented.
    repo.decryptState.mockReturnValue({
      creds: { registered: false, me: { id: '966501234567@s.whatsapp.net' } },
      keys: {},
    });
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    await expect(session.sendTextOverSocket(STORE, '966509999999', 'hello')).resolves.toBe(true);
    expect(socket.sent.at(-1)!.jid).toBe('966509999999@s.whatsapp.net');
  });

  test('refuses to send to a store with no live session', async () => {
    await expect(session.sendTextOverSocket('nope', '966509999999', 'hi')).resolves.toBe(false);
  });
});

describe('boot restore', () => {
  test('restores each persisted session', async () => {
    repo.listAll.mockResolvedValue([
      { storeId: STORE, stateEnc: 'enc:x', status: 'open', phone: '966501234567' } as never,
    ]);
    await session.restoreAllSessions();
    expect(session.isLive(STORE)).toBe(true);
  });

  test('retries a restore whose lease the outgoing replica still holds', async () => {
    vi.useFakeTimers();
    repo.listAll.mockResolvedValue([
      { storeId: STORE, stateEnc: 'enc:x', status: 'open', phone: '966501234567' } as never,
    ]);
    // The boot pass loses the lease race to the dying replica; the retry gets it.
    lock.acquireLock.mockResolvedValueOnce(null);

    await session.restoreAllSessions();
    expect(session.isLive(STORE)).toBe(false);

    await vi.advanceTimersByTimeAsync(session.RESTORE_RETRY_DELAY_MS);
    expect(session.isLive(STORE)).toBe(true);
  });

  test('one bad row does not stop the others from restoring', async () => {
    repo.listAll.mockResolvedValue([
      { storeId: STORE, stateEnc: 'bad', status: 'open', phone: null } as never,
      { storeId: OTHER_STORE, stateEnc: 'enc:x', status: 'open', phone: '966500000000' } as never,
    ]);
    // Both stores have a persisted row here, so the per-store default from beforeEach
    // is replaced with one that keys off the requested store.
    repo.get.mockImplementation(async (storeId: string) =>
      ({ stateEnc: storeId === STORE ? 'bad' : 'enc:x', status: 'open' } as never),
    );
    repo.decryptState.mockImplementation((row: any) => {
      if (row?.stateEnc === 'bad') throw new Error('undecryptable');
      return { creds: {}, keys: {} };
    });
    await expect(session.restoreAllSessions()).resolves.toBeUndefined();
    expect(session.isLive(OTHER_STORE)).toBe(true);
  });

  test('leaves sessions offline when the cap is already met', async () => {
    repo.listAll.mockResolvedValue([
      { storeId: STORE, stateEnc: 'enc:x', status: 'open', phone: null } as never,
      { storeId: OTHER_STORE, stateEnc: 'enc:x', status: 'open', phone: null } as never,
    ]);
    repo.listOpen.mockResolvedValue([{ storeId: STORE, status: 'open', phone: null }]);
    await session.restoreAllSessions();
    expect(repo.setStatus).toHaveBeenCalledWith(OTHER_STORE, 'idle', expect.objectContaining({ lastError: 'session limit reached' }));
  });
});

describe('event fan-out', () => {
  test('subscribers receive status changes', async () => {
    const seen: any[] = [];
    session.subscribe(STORE, (e) => seen.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(seen.some((e) => e.status === 'open')).toBe(true));
  });

  test('one broken subscriber does not stop the others', async () => {
    const seen: any[] = [];
    session.subscribe(STORE, () => {
      throw new Error('broken pipe');
    });
    session.subscribe(STORE, (e) => seen.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(seen.some((e) => e.status === 'open')).toBe(true));
  });

  test('unsubscribe stops delivery', async () => {
    const seen: any[] = [];
    const off = session.subscribe(STORE, (e) => seen.push(e));
    off();
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toHaveLength(0);
  });

  test('one store cannot observe another store events', async () => {
    const other: any[] = [];
    session.subscribe(OTHER_STORE, (e) => other.push(e));
    await session.startSession(STORE);
    socket.emit('connection.update', { connection: 'open' });
    await vi.waitFor(() => expect(session.statusFor(STORE)).toBe('open'));
    expect(other).toHaveLength(0);
  });
});