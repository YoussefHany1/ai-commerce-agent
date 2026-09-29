import postgres from 'postgres';
import { config } from '../src/config.js';

const ADMIN_URL = process.env.PGADMIN_URL?.trim() || config.DATABASE_URL;
const sql = postgres(ADMIN_URL, { max: 1 });

const isProd = process.env.NODE_ENV === 'production';
const APP_USER = process.env.APP_DB_USER ?? 'agent_app';
let APP_PASSWORD = process.env.APP_DB_PASSWORD ?? '';

// This script is the local/CI role bootstrap: it creates the least-privilege
// runtime role the app connects as. It must NOT run against Supabase — there the
// app connects as the already-existing `authenticated` role and the grants come
// from drizzle/0010_supabase_rls.sql (which also rewrote the policies onto the
// `request.jwt.claims` model both Postgres flavours share).
if (isProd) {
  if (!APP_PASSWORD || APP_PASSWORD === 'agent_pass') {
    console.error('APP_DB_PASSWORD must be set to a strong value in production');
    process.exit(1);
  }
  if (APP_USER === 'agent_app') {
    console.warn('Using default APP_DB_USER=agent_app; pass a dedicated runtime role in production');
  }
}
if (!APP_PASSWORD) APP_PASSWORD = 'agent_pass';

await sql.unsafe(`create extension if not exists pgcrypto`);

await sql.unsafe(
  `do $$ begin if not exists (select from pg_roles where rolname = '${APP_USER}') then execute 'create role ${APP_USER} login password ''${APP_PASSWORD}'''; end if; end $$`,
);
await sql.unsafe(`grant usage on schema public to ${APP_USER}`);
await sql.unsafe(`grant all privileges on all tables in schema public to ${APP_USER}`);
await sql.unsafe(`grant all privileges on all sequences in schema public to ${APP_USER}`);

await sql.end();
console.log(`RLS role '${APP_USER}' and grants applied; policies come from drizzle/0004_security_rls.sql / 0006 / 0009 / 0010`);