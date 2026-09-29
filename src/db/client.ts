import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import * as schema from './schema.js';
import { config } from '../config.js';

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  prepare: false,
  onnotice: () => {},
});

export type Db = import('drizzle-orm/postgres-js').PostgresJsDatabase<typeof schema>;

export const db = drizzle(sql, { schema });

/**
 * Tenant isolation on this deployment is driven by row level security policies
 * that read the `request.jwt.claims` GUC — the same mechanism Supabase uses. A
 * caller declares who it is acting as, and the policies decide what that role
 * may see:
 *
 *   * `withTenant(storeId)`   → `{app:{store_id: …}}`
 *   * `withOperator()`        → `{app:{operator:'true'}}`
 *   * `withClient(clientId)`  → `{app:{client_id: …}}`
 *
 * Older versions used three separate `app.*` GUCs; the claim object keeps the
 * whole identity in one place so the same policies run on plain Postgres (local
 * `agent_app` role, CI) and on Supabase (`authenticated` role) without change.
 *
 * The claim MUST be set inside the same transaction as the work: `set_config`
 * with `is_local = true` (`SET LOCAL`) is scoped to its transaction, so the
 * wrapper below guarantees the RLS-expiring key and the query share one
 * transaction, on one connection. Setting it outside a transaction would leak
 * the claim onto the pooled connection and either over-expose the next request
 * or silently return zero rows — both caught by the integration suite.
 */
function withClaims<T>(app: Record<string, string>, fn: (txDb: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`select set_config('request.jwt.claims', ${JSON.stringify({ app })}, true)`);
    return fn(tx as unknown as Db);
  });
}

export async function withTenant<T>(storeId: string, fn: (txDb: Db) => Promise<T>): Promise<T> {
  return withClaims({ store_id: storeId }, fn);
}

export async function withOperator<T>(fn: (txDb: Db) => Promise<T>): Promise<T> {
  return withClaims({ operator: 'true' }, fn);
}

/**
 * Third tenancy scope, above the store: a dashboard client account.
 *
 * Only `clients` and `stores` carry a `client_id` column and therefore a
 * client-scoped RLS policy. The fifteen per-store tables are deliberately left on
 * `withTenant` — a client request is scoped twice over, first by the route guard
 * proving the store is this client's, then by `store_id` on the data itself.
 * Giving all sixteen tables a `client_id` policy would mean an EXISTS subquery
 * against `stores` inside every policy, evaluated per row, for no additional
 * guarantee the guard does not already provide.
 *
 * An absent `{app:{client_id}}` claim yields '' → null, so a bare connection
 * matches no rows.
 */
export async function withClient<T>(clientId: string, fn: (txDb: Db) => Promise<T>): Promise<T> {
  return withClaims({ client_id: clientId }, fn);
}