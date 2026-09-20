import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import * as schema from './schema.js';
import { config } from '../config.js';

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  onnotice: () => {},
});

export type Db = import('drizzle-orm/postgres-js').PostgresJsDatabase<typeof schema>;

export const db = drizzle(sql, { schema });

export async function withTenant<T>(storeId: string, fn: (txDb: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`select set_config('app.store_id', ${storeId}, true)`);
    return fn(tx as unknown as Db);
  });
}

export async function withOperator<T>(fn: (txDb: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`select set_config('app.operator', 'true', true)`);
    return fn(tx as unknown as Db);
  });
}