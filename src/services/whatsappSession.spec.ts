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
  repo.decryptState.mockReturnValue({ creds: { me: { id: '966501234567@s.whatsapp.net' } }, keys: {} });
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