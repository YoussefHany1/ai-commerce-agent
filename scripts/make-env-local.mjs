import { readFileSync, writeFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const need = (k) => {
  if (!env[k]) throw new Error(`missing ${k} in .env`);
  return env[k];
};

const pg = need('POSTGRES_PASSWORD');
const app = need('APP_DB_PASSWORD');
const appU = need('APP_DB_USER');
const rp = need('REDIS_PASSWORD');
const enc = encodeURIComponent;

const out = [
  '# Local development overrides, loaded AFTER .env (node --env-file: the later file wins).',
  '#',
  '# Why this exists: .env pointed DATABASE_URL/PGADMIN_URL at the production Supabase',
  '# instance, so a local run mutated production data - migrations, rule edits, and the',
  '# WhatsApp session row. That produced a 409 on qr-connect (local competed with Render',
  '# for the single session slot) and would overwrite the production pairing on re-scan.',
  '#',
  '# docker-compose interpolates POSTGRES_PASSWORD/REDIS_PASSWORD from here, so these must',
  '# stay identical to the compose stack for the local Postgres to accept the app role.',
  '',
  '# Local Docker Postgres (npm run db:setup) instead of Supabase.',
  '# Passwords are percent-encoded: APP_DB_PASSWORD contains an "@", which otherwise',
  '# truncates the URL at the wrong host and points the app at a server that is not there.',
  `DATABASE_URL=postgresql://${appU}:${enc(app)}@localhost:5432/ai_commerce_agent`,
  `PGADMIN_URL=postgresql://postgres:${enc(pg)}@localhost:5432/ai_commerce_agent`,
  '',
  '# Session locks and leases are per-environment; keep Redis local too.',
  `REDIS_URL=redis://:${enc(rp)}@localhost:6379`,
  '',
  '# Pairing is expected locally, so it is enabled explicitly.',
  'WHATSAPP_BAILEYS_ENABLED=1',
  '',
].join('\n');

writeFileSync('.env.local', out);
console.log('wrote .env.local');