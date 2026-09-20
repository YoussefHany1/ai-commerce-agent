# Deployment

## HTTPS requirement

The app server must sit behind an HTTPS-terminating reverse proxy (Nginx, Caddy, or a
load balancer) in production. It never terminates TLS itself. If a proxy is in front of
the server, set `TRUST_PROXY=true` so `req.ip` honors the `X-Forwarded-For` header.

Without a proxy, the `X-Api-Key` header (used to protect all admin API routes) travels in
clear text over the network and must never be enabled that way.

## Nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name your-app.example.com;

    ssl_certificate     /etc/letsencrypt/live/your-app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-app.example.com/privkey.pem;

    client_max_body_size 5m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}

server {
    listen 80;
    server_name your-app.example.com;
    return 301 https://$host$request_uri;
}
```

## Caddy example

```caddy
your-app.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Required environment variables in production

- `ENCRYPTION_KEY` — required; the server refuses to start without it (`openssl rand -hex 32`).
- `ADMIN_API_KEY` — required to enable API-key auth on all admin routes (`openssl rand -hex 32`).
- `TRUST_PROXY=true` — required when running behind the proxy above.
- `DATABASE_URL`, `REDIS_URL` — must point at real instances.

## Health checks

`GET /api/health` returns `200` when Postgres and Redis are both reachable and `503` when
either is not, so a load balancer or orchestrator drops the instance automatically.

## Error reporting

Set `SENTRY_DSN` to a project DSN and the server initializes `@sentry/node` on boot.
When set, unhandled rejections, uncaught exceptions, and 5xx route errors are reported.
When unset the server still logs errors and proceeds without Sentry.

## Runbook — first install

1. Provision a VM + reverse proxy (Nginx/Caddy above), Postgres, and Redis.
2. Generate secrets and write `.env`:
   ```bash
   openssl rand -hex 32   # ENCRYPTION_KEY
   openssl rand -hex 32   # ADMIN_API_KEY
   openssl rand -hex 32   # POSTGRES_PASSWORD / REDIS_PASSWORD (compose)
   ```
3. Start infra, migrate, and apply RLS once (migrations job uses `PGADMIN_URL`):
   ```bash
   docker compose up -d postgres redis
   npm run db:setup && npm run db:bootstrap
   ```
4. Build and start the app (see README — Docker or `npm run build && npm run start:prod`).
5. Wire platform credentials (`SHOPIFY_CLIENT_ID/SECRET`, Salla/Zid, `WHATSAPP_*`,
   `STRIPE_*`) and verify `GET /api/health` → `200`.
6. Create stores via `POST /api/stores` (operator key) and issue per-store keys:
   ```bash
   # once per store, operator-only:
   curl -X POST -H "X-Api-Key: $ADMIN_API_KEY" \
     http://localhost:3000/api/stores/<storeId>/keys   # returns sk_live_… once, shown one time
   ```
   Hand the `sk_live_…` key to the merchant/agent dashboard. It is stored only as a
   SHA-256 hash (`stores.api_key_hash`) plus a 4-char hint; the hint is shown by
   `GET /api/stores/<storeId>/keys`. Revoke/rotate with `DELETE …/keys` then re-issue.

## Runbook — rotation, upgrades, incidents

- **DB migration**: run `PGADMIN_URL=… npm run db:migrate` (apply-rls once in `db:bootstrap`).
  Backup before and after. Downtime is not required.
- **Store key rotation**: `POST /api/stores/<storeId>/keys` replaces the key atomically.
  Old key is invalid the moment the new one is stored; coordinate with the merchant's dashboard.
- **Restore from backup**:
  ```bash
  gunzip -c backups/backup-*.sql.gz | psql "$DATABASE_URL"
  ```
  Then re-run `npm run db:apply-rls` if restoring into a fresh DB.
- **Ghost store / uninstall**: Shopify `app/uninstalled` webhooks remove the store and all
  tenant rows automatically. PDPL webhook topics (`customers/data_request`, `customers/redact`,
  `shop/redact`) are recorded as events and fulfilled via `POST /api/pdpl/access|erase`.
- **Incident**: check `/api/health` first (DB/Redis), then app logs (structured pino JSON),
  then Sentry (`SENTRY_DSN`) for 5xx stack traces.

## Backups

Scheduled logical backup (Postgres) via the bundled script:

```bash
PGADMIN_URL=postgres://… ./scripts/pg-backup.sh   # or: npm run db:backup
```

Writes `backups/backup-<timestamp>.sql.gz` and prunes files older than `KEEP_DAYS`
(default 30). Cron example (daily 02:30, off-site target is your responsibility):

```cron
30 2 * * * cd /srv/ai-commerce-agent && npm run db:backup >> /var/log/agent-backup.log 2>&1
```

Archive dumps off-server (object storage/another host). Restore via `psql` from the
`.sql.gz`. The old command (`docker compose exec -T postgres pg_dump …`) still works in
single-host deployments. Redis is ephemeral (sessions, rate limits) — no backup needed.