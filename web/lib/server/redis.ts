import 'server-only';
import { createClient } from 'redis';

const EPOCH_KEY = 'op:sess:epoch';
/**
 * Client session epoch seed, mirroring `src/lib/clientSession.ts` on the API side:
 * one shared Redis key per account holding the current session epoch. A bump here
 * (password change, suspension, reset) revokes every cookie minted against the old
 * value. A missing key is seeded like the operator epoch, so a Redis flush fails
 * closed rather than resurrecting revoked client sessions.
 */
const CLIENT_EPOCH_PREFIX = 'cli:sess:epoch:';
/**
 * Per-operator session epoch, mirroring `src/lib/operatorSession.ts`. Distinct from
 * {@link EPOCH_KEY}: that one is the install-wide kill switch, this one is per person,
 * so suspending one operator or evicting their devices leaves everyone else signed in.
 * Both must match, which is why an operator cookie carries two epochs.
 */
const OPERATOR_EPOCH_PREFIX = 'op:sess:epoch:';

const GENERATED_BYTES = 16;

// `ReturnType<typeof createClient>` rather than the `RedisClientType` alias: the
// alias defaults to an empty module map, which the client it actually returns does
// not structurally satisfy.
type Client = ReturnType<typeof createClient>;

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getRedis(): Promise<Client> {
  if (client?.isOpen) return client;
  if (connecting) return connecting;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured — operator sessions cannot be verified');

  connecting = (async () => {
    const next = createClient({ url, socket: { connectTimeout: 3_000 } });
    // Without a listener node-redis throws on connection errors; this keeps a
    // Redis outage a rejected promise the callers handle, not a crash.
    next.on('error', () => {});
    await next.connect();
    client = next;
    return next;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * Operator session epoch, mirroring `src/lib/operatorSession.ts` on the API side.
 *
 * The two packages cannot share code across the service boundary, so the key name
 * and seeding rule are duplicated by contract — if you change one, change the
 * other. The API writes it (`scripts/revoke-operator-sessions.ts`); only the web
 * service reads it, to reject cookies minted before the last revocation.
 *
 * A missing key is seeded with a random value rather than a constant, so a Redis
 * flush fails closed: cookies issued under the old epoch stop verifying instead of
 * resurrecting revoked sessions.
 */
export async function currentEpoch(): Promise<string> {
  const redis = await getRedis();
  const existing = await redis.get(EPOCH_KEY);
  if (existing) return existing;

  const fresh = randomHex(GENERATED_BYTES);
  // NX so concurrent callers converge on one winner; the loser re-reads.
  await redis.set(EPOCH_KEY, fresh, { NX: true });
  return (await redis.get(EPOCH_KEY)) ?? fresh;
}

/** Client analogue of {@link currentEpoch}, keyed per dashboard account. */
export async function currentClientEpoch(clientId: string): Promise<string> {
  const key = `${CLIENT_EPOCH_PREFIX}${clientId}`;
  const redis = await getRedis();
  const existing = await redis.get(key);
  if (existing) return existing;

  const fresh = randomHex(GENERATED_BYTES);
  await redis.set(key, fresh, { NX: true });
  return (await redis.get(key)) ?? fresh;
}

/** Per-person operator epoch, keyed by operator id. */
export async function currentOperatorEpoch(operatorId: string): Promise<string> {
  const key = `${OPERATOR_EPOCH_PREFIX}${operatorId}`;
  const redis = await getRedis();
  const existing = await redis.get(key);
  if (existing) return existing;

  const fresh = randomHex(GENERATED_BYTES);
  await redis.set(key, fresh, { NX: true });
  return (await redis.get(key)) ?? fresh;
}

function randomHex(bytes: number): string {
  // Web Crypto is available on the Node runtime these handlers execute on, and
  // avoids pulling node:crypto into a module that middleware also imports.
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
