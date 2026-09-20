import { getRedis } from './redis.js';

export async function redisPing(): Promise<boolean> {
  try {
    const client = await getRedis();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function dbPing(): Promise<boolean> {
  try {
    const { sql } = await import('../db/client.js');
    await sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function rlsPing(): Promise<boolean> {
  try {
    const { sql } = await import('../db/client.js');
    const rows = await sql`select relrowsecurity from pg_class where relname = 'stores'`;
    return Array.isArray(rows) && rows[0]?.relrowsecurity === true;
  } catch {
    return false;
  }
}