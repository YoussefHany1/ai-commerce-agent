import { describe, expect, it, vi, beforeEach } from 'vitest';

interface Entry {
  value: string;
  expAt: number;
}

/**
 * Fake Redis implementing the two Lua scripts `lock.ts` uses, in JS so the token
 * comparison and expiry semantics are exercised. The scripts themselves are
 * verified against real Redis in src/tests/integration.spec.ts.
 */
function createFakeRedis(opts: { realTime?: boolean } = {}) {
  let manual = 0;
  const now = () => (opts.realTime ? Date.now() : manual);
  const store = new Map<string, Entry>();

  const alive = (k: string) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expAt <= now()) {
      store.delete(k);
      return null;
    }
    return e;
  };

  const client = {
    set: async (k: string, v: string, opts?: { NX?: boolean; PX?: number }) => {
      if (opts?.NX && alive(k)) return null;
      const ttl = opts?.PX ?? 30_000;
      store.set(k, { value: v, expAt: now() + ttl });
      return 'OK';
    },
    get: async (k: string) => alive(k)?.value ?? null,
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    eval: async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      const [key] = opts.keys;
      const [token] = opts.arguments;
      const cur = alive(key);
      if (!cur || cur.value !== token) return 0;
      if (script.includes('pexpire')) {
        cur.expAt = now() + Number(opts.arguments[1]);
        return 1;
      }
      store.delete(key);
      return 1;
    },
  };

  return { store, client, advance: (ms: number) => void (manual += ms) };
}

let fake = createFakeRedis();

vi.mock('./redis.js', () => ({ getRedis: async () => fake.client }));
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

async function load(opts: { realTime?: boolean } = {}) {
  vi.resetModules();
  fake = createFakeRedis(opts);
  return import('./lock.js');
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('acquireLock', () => {
  it('grants a free lock and refuses a second holder', async () => {
    const { acquireLock } = await load();
    const first = await acquireLock('worker:jobs', 60_000);
    expect(first).not.toBeNull();

    const second = await acquireLock('worker:jobs', 60_000);
    expect(second).toBeNull();
  });

  it('namespaces by lock name so workers do not block each other', async () => {
    const { acquireLock } = await load();
    expect(await acquireLock('worker:jobs', 60_000)).not.toBeNull();
    expect(await acquireLock('worker:automation', 60_000)).not.toBeNull();
  });

  it('grants the lock again once the lease lapses', async () => {
    const { acquireLock } = await load();
    expect(await acquireLock('worker:jobs', 60_000)).not.toBeNull();
    fake.advance(60_001);
    expect(await acquireLock('worker:jobs', 60_000)).not.toBeNull();
  });

  it('releases only for the holder, so a lapsed lease cannot be stolen', async () => {
    const { acquireLock } = await load();
    const mine = await acquireLock('worker:jobs', 60_000);
    fake.advance(60_001);
    const theirs = await acquireLock('worker:jobs', 60_000);
    expect(theirs).not.toBeNull();

    // The original holder's token no longer matches the key.
    await mine!.release();
    expect(await fake.client.get('lock:worker:jobs')).not.toBeNull();
  });
});

describe('lock.renew', () => {
  it('extends a held lease', async () => {
    const { acquireLock } = await load();
    const lock = await acquireLock('worker:jobs', 30_000);
    fake.advance(20_000);
    expect(await lock!.renew()).toBe(true);
    fake.advance(20_000);
    expect(await lock!.renew()).toBe(true);
  });

  it('reports failure once the lease is lost', async () => {
    const { acquireLock } = await load();
    const lock = await acquireLock('worker:jobs', 30_000);
    fake.advance(30_001);
    expect(await lock!.renew()).toBe(false);
  });
});

describe('withLock', () => {
  it('runs the work and returns its result', async () => {
    const { withLock } = await load();
    await expect(withLock('worker:jobs', 60_000, async () => 'done')).resolves.toBe('done');
  });

  it('skips the work and returns null when another holder has the lease', async () => {
    const { acquireLock, withLock } = await load();
    await acquireLock('worker:jobs', 60_000);
    const fn = vi.fn(async () => 'done');
    await expect(withLock('worker:jobs', 60_000, fn)).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('releases the lease after the work so the next tick can run', async () => {
    const { withLock } = await load();
    await withLock('worker:jobs', 60_000, async () => 'first');
    await expect(withLock('worker:jobs', 60_000, async () => 'second')).resolves.toBe('second');
  });

  it('releases the lease when the work throws, and propagates the error', async () => {
    const { withLock } = await load();
    await expect(
      withLock('worker:jobs', 60_000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await fake.client.get('lock:worker:jobs')).toBeNull();
  });

  it('schedules lease renewal at a third of the ttl', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { withLock } = await load();
    await withLock('worker:jobs', 30_000, async () => 'done');
    expect(spy.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true);
    spy.mockRestore();
  });

  it('keeps the lease alive across work that outlasts the initial ttl', async () => {
    // Real timers and a real-time fake clock: a 300ms lease with work that takes
    // 700ms. Without renewal the lease lapses at 300ms and a competing replica
    // gets in; with renewal (every 100ms) it stays locked out.
    const { withLock, acquireLock } = await load({ realTime: true });

    const rival = await withLock('worker:jobs', 300, async () => {
      await new Promise((r) => setTimeout(r, 700));
      return acquireLock('worker:jobs', 300);
    });

    expect(rival).toBeNull();
  });

  it('releases the lease on completion so the next tick can take it', async () => {
    const { withLock, acquireLock } = await load({ realTime: true });
    await withLock('worker:jobs', 300, async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(await acquireLock('worker:jobs', 300)).not.toBeNull();
  });

  it('stops renewing once maxDurationMs is exceeded, so the lease can lapse', async () => {
    // The failure this guards: work that never settles keeps its lease renewed
    // forever, and the worker is then dead for every replica at once. Renewal
    // must stop at the deadline so the lease expires and a replica can take over.
    // Same shape as the test above, but the work deliberately overruns the ceiling.
    const { withLock, acquireLock } = await load({ realTime: true });

    const rival = await withLock(
      'worker:jobs',
      300,
      async () => {
        await new Promise((r) => setTimeout(r, 900));
        return acquireLock('worker:jobs', 300);
      },
      { maxDurationMs: 200 },
    );

    expect(rival).not.toBeNull();
  });

  it('keeps renewing while the work is inside maxDurationMs', async () => {
    const { withLock, acquireLock } = await load({ realTime: true });

    const rival = await withLock(
      'worker:jobs',
      300,
      async () => {
        await new Promise((r) => setTimeout(r, 700));
        return acquireLock('worker:jobs', 300);
      },
      { maxDurationMs: 5_000 },
    );

    expect(rival).toBeNull();
  });
});
