import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

/**
 * Resets the local Docker Postgres roles to match `.env`, then verifies the app role.
 *
 * Reached through `docker compose exec` because the superuser password in the volume
 * predates the current `.env`, so a TCP connection as `postgres` cannot authenticate.
 * Everything here targets localhost only.
 */
const env = {};
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const appPw = env.APP_DB_PASSWORD;
const pgPw = env.POSTGRES_PASSWORD;
if (!appPw || !pgPw) throw new Error('APP_DB_PASSWORD/POSTGRES_PASSWORD missing from .env');

// Identifiers cannot be bound as parameters; the values come from `.env`, not input.
execFileSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'ai_commerce_agent',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `alter role postgres with password '${pgPw.replace(/'/g, "''")}'`,
    '-c',
    `alter role agent_app with password '${appPw.replace(/'/g, "''")}'`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
console.log('postgres + agent_app passwords aligned with .env');

const asApp = postgres({
  host: 'localhost',
  port: 5432,
  database: 'ai_commerce_agent',
  username: env.APP_DB_USER || 'agent_app',
  password: appPw,
  max: 1,
  onnotice: () => {},
  connect_timeout: 10,
});
await asApp`select 1`;
const tables = await asApp`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
console.log('app role connects; public tables:', tables[0].n);
await asApp.end({ timeout: 5 });