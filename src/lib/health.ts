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

/**
 * Every table that 0004 enables RLS on, and that 0007 forces. Kept as an explicit
 * list rather than a catalog query so that a table which somehow lost both flags
 * still fails the check instead of quietly shrinking the set being verified.
 */
const RLS_TABLES = [
  'clients',
  'stores',
  'platform_connections',
  'products',
  'variants',
  'customers',
  'orders',
  'conversations',
  'messages',
  'events',
  'automation_rules',
  'automation_logs',
  'jobs',
  'attributions',
  'whatsapp_channels',
  'billing_subscriptions',
  'daily_metrics',
] as const;

/**
 * True only if RLS is genuinely enforced for this connection.
 *
 * Checking `relrowsecurity` alone was not enough on two counts. A table owner
 * bypasses RLS unless it is also FORCED, so a DATABASE_URL pointing at the owner
 * connection passed the old check while ignoring all 33 policies. And the old
 * check inspected one table, so the other 15 could be unprotected unnoticed.
 *
 * A superuser or a role with BYPASSRLS also passes both catalog flags and still
 * reads every row, which no amount of catalog inspection can detect. That is why
 * 0007 forces RLS and this additionally asserts the connected role does not own
 * the tables - the two together close the realistic misconfigurations.
 */
export async function rlsPing(): Promise<boolean> {
  try {
    const { sql } = await import('../db/client.js');
    const rows = await sql<{ name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owned: boolean }[]>`
      select c.relname as name,
             c.relrowsecurity,
             c.relforcerowsecurity,
             (pg_get_userbyid(c.relowner) = current_user) as owned
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relname::text in ${sql(RLS_TABLES)}
    `;

    if (!Array.isArray(rows) || rows.length !== RLS_TABLES.length) return false;
    return rows.every((r) => r.relrowsecurity && r.relforcerowsecurity && !r.owned);
  } catch {
    return false;
  }
}