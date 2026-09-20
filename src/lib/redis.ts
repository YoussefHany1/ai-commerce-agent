import { createClient } from 'redis';
import { config } from '../config.js';

let client: ReturnType<typeof createClient> | null = null;

export async function getRedis() {
  if (!client) {
    client = createClient({ url: config.REDIS_URL, socket: { connectTimeout: 3000 } });
    client.on('error', () => {});
  }
  if (!client.isOpen) await client.connect();
  return client;
}