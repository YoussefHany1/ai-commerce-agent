import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const ADMIN_URL =
  process.env.PGADMIN_URL?.trim() ||
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/ai_commerce_agent';

const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
const db = drizzle(sql);
try {
  await migrate(db, { migrationsFolder: 'drizzle' });
  console.log('Migrations applied.');
} finally {
  await sql.end({ timeout: 5 });
}