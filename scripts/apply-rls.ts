import postgres from 'postgres';
import { config } from '../src/config.js';

const ADMIN_URL = process.env.PGADMIN_URL?.trim() || config.DATABASE_URL;
const sql = postgres(ADMIN_URL, { max: 1 });

const isProd = process.env.NODE_ENV === 'production';
const APP_USER = process.env.APP_DB_USER ?? 'agent_app';
let APP_PASSWORD = process.env.APP_DB_PASSWORD ?? '';

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

const tables = [
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
];

const operatorExempt = new Set(['stores', 'whatsapp_channels', 'billing_subscriptions', 'jobs', 'automation_rules', 'automation_logs']);

for (const t of tables) {
  await sql.unsafe(`alter table "${t}" enable row level security`);
  const policyName = `tenant_isolation_${t}`;
  await sql.unsafe(`drop policy if exists "${policyName}" on "${t}"`);
  if (t === 'stores') {
    await sql.unsafe(
      `create policy "${policyName}" on "${t}"
       using (current_setting('app.operator', true) = 'true') with check (current_setting('app.operator', true) = 'true')`,
    );
  } else {
    await sql.unsafe(
      `create policy "${policyName}" on "${t}"
       using (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
       with check (store_id = nullif(current_setting('app.store_id', true), '')::uuid)`,
    );
  }
  if (operatorExempt.has(t)) {
    await sql.unsafe(`drop policy if exists "tenant_operator_${t}" on "${t}"`);
    await sql.unsafe(
      `create policy "tenant_operator_${t}" on "${t}"
       using (current_setting('app.operator', true) = 'true')
       with check (current_setting('app.operator', true) = 'true')`,
    );
  }
}

await sql.end();
console.log('RLS policies applied');