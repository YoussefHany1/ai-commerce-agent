import { createClient } from 'redis';
import { config } from '../config.js';

let client: ReturnType<typeof createClient> | null = null;
// In-flight connect promise. redis@6 rejects a second concurrent connect()
// ("Socket already opened"), so cold-start callers (locks, rate limiting) that
// raced here would fail instead of sharing one connection.
let connecting: Promise<unknown> | null = null;

export async function getRedis() {
  if (!client) {
    client = createClient({ url: config.REDIS_URL, socket: { connectTimeout: 3000 } });
    client.on('error', () => {});
  }
  if (!client.isOpen) {
    connecting ??= client.connect().finally(() => {
      connecting = null;
    });
    await connecting;
  }
  return client;
}