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

The server refuses to start in `NODE_ENV=production` if any of these are missing or
malformed, rather than degrading into an unauthenticated or unrevocable state.

- `ENCRYPTION_KEY` — required; `openssl rand -hex 32`.
- `ADMIN_API_KEY` — required to enable API-key auth on all admin routes; `openssl rand -hex 32`.
- `OPERATOR_PASSWORD_HASH` — required, in `scrypt$N$r$p$salt$hash` form. Generate with
  `npm run hash-operator-password`, which prompts without echoing and prints the value
  to put here. The plaintext password is never stored or logged.
- `TRUST_PROXY` — required, and must be explicit. Set `true` (or `1`) when a reverse
  proxy or PaaS edge sets `X-Forwarded-For`; set `none` when nothing does. Guessing
  wrong is not cosmetic: with it wrongly off, every request appears to come from the
  proxy and all clients share one rate-limit bucket; with it wrongly on, a caller can
  spoof its address and get a fresh bucket per request.
- `DATABASE_URL`, `REDIS_URL` — must point at real instances.
- `WORKERS_ENABLED` — defaults to `true`. Set `false` on a replica that should only
  serve traffic; see "Scaling out" below.

Optional rotation values: `ADMIN_API_KEY_PREVIOUS` and `OPERATOR_PASSWORD_HASH_PREVIOUS`
are accepted alongside their current counterparts so a secret can be rotated across two
deploys. Clear the `_PREVIOUS` value on the deploy after the rotation.

## Operator access and session revocation

The dashboard (`web/`) is a separate service that authenticates with a signed session
cookie. Three things follow, and all three are easy to get wrong:

- The web service needs the **same Redis** as the API. The operator session epoch lives
  in the key `op:sess:epoch`, and it is what makes revocation take effect immediately.
- To sign every operator out right now — after a suspected password leak, say:
  ```bash
  npm run revoke-operator-sessions   # bumps op:sess:epoch; existing cookies stop working
  ```
  This is instant and needs no redeploy. It does not invalidate the API key itself.
- Rotating `SESSION_SECRET` on the web service also signs everyone out, by making every
  issued cookie unverifiable.

Failed operator logins are counted in Redis: five failures triggers a lockout starting at
30 seconds, doubling on each further failure up to 15 minutes. If Redis is unreachable the
endpoint returns `503` rather than skipping the check, so a Redis outage cannot be used to
brute-force the password.

### What the API sees as the client address

The dashboard proxy does **not** forward `X-Forwarded-For`. It cannot: a browser can set
that header, so trusting a caller-supplied value would let anyone mint a fresh rate-limit
bucket per request. Every request the API receives through the dashboard therefore appears
to originate from the proxy's own address, and two consequences follow:

- Operator login lockout is effectively **global** across dashboard clients, not per
  address. One attacker burning through the attempts locks out every operator until the
  timer decays. The trade is deliberate — a per-address lockout that a caller can rotate is
  not a lockout. If that trade is wrong for your deployment, put a rate limiter in front of
  the dashboard's own `/api/auth/login` route; the API's limiter cannot help because it
  never sees the real address.
- Rate limits on proxied API routes are shared across all dashboard traffic. Size them for
  your operator count, not your customer count.

Set `TRUST_PROXY` on the API exactly as described above: it governs the address of requests
that reach the API *directly* (OAuth callbacks, webhooks, health checks, anything scripted).

## Scaling out

Every replica starts the background workers, and each tick first takes a Redis lease
(`src/lib/lock.ts`, token-checked release and renewal), so only one replica runs a given
worker at a time. Scaling the web service out is therefore safe without a separate
worker deployment. Set `WORKERS_ENABLED=false` on replicas that should never run
background work at all.

If you lose Redis entirely: operator sessions stop verifying (the dashboard returns
`503`, which is the fail-closed behavior), rate limits reset, and two or more replicas
may briefly run the same worker until the lease store is back.

## Deploying to Render

`render.yaml` defines the API, the dashboard, and a Redis instance. Two things to settle
before the first deploy:

1. **The database must have pgvector.** Render's managed PostgreSQL does not ship the
   `vector` extension, and the first migration runs `CREATE EXTENSION vector` with a
   `vector(1536)` column. Create the database at a provider that does (Neon, Supabase,
   Timescale) and set `DATABASE_URL` / `PGADMIN_URL` on the API service. The blueprint
   ships no `databases:` block at all, because one referencing Render Postgres could
   never satisfy the requirement above.
2. **`API_URL` is set by hand** on the dashboard service. Use the private-network origin,
   `http://agent-api:10000` — `10000` is Render's default `PORT`, which `src/server.ts`
   binds to. A Blueprint cannot compose the `host` and `port` properties into a single
   value, and `property: privateHost` is not a real property: the spec's only address
   properties are `host` (a bare private hostname, no scheme) and `hostport`.
3. **Migrations run as `preDeployCommand`** (`npm run db:bootstrap`) immediately before a
   new version serves traffic. `tsx` is a runtime dependency specifically so this works
   in the production image.

Public origins come from `RENDER_EXTERNAL_URL` rather than a `host` property. That
matters: `APP_BASE_URL` is validated with `z.string().url()`, so a bare `agent-api`
hostname would stop the API from booting in production, and `NEXT_PUBLIC_API_URL` is
inlined into the browser bundle, where a scheme-less value produces a dead OAuth link.

`npm run check:render` validates the blueprint against the published spec — every
`fromService` property against the documented set, every reference against a service or
database the blueprint declares, plan IDs, and the two mistakes that render green and
fail at runtime: a secret declared as both a build arg and a runtime variable (Render
resolves those to two different generated values), and a URL variable fed a scheme-less
`host`.

## Health checks

`GET /api/health` returns `200` when Postgres and Redis are both reachable and `503` when
either is not, so a load balancer or orchestrator drops the instance automatically.

The dashboard has no unauthenticated health endpoint; point its check at `/login`, which
returns `200` without a session.

## Error reporting

Set `SENTRY_DSN` to a project DSN and the server initializes `@sentry/node` on boot.
When set, unhandled rejections, uncaught exceptions, and 5xx route errors are reported.
When unset the server still logs errors and proceeds without Sentry.

## Runbook — first install

1. Provision a VM + reverse proxy (Nginx/Caddy above), Postgres, and Redis.
2. Generate secrets and write `.env`:
   ```bash
   npm run hash-operator-password   # OPERATOR_PASSWORD_HASH (prompts, does not echo)
   openssl rand -hex 32   # ENCRYPTION_KEY
   openssl rand -hex 32   # ADMIN_API_KEY
   openssl rand -hex 32   # SESSION_SECRET (dashboard)
   openssl rand -hex 32   # POSTGRES_PASSWORD / REDIS_PASSWORD (compose)
   ```
   Then set `TRUST_PROXY` explicitly — see "Required environment variables" above.
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
- **Admin key rotation**: deploy with the new key in `ADMIN_API_KEY` and the old one in
  `ADMIN_API_KEY_PREVIOUS`, point the dashboard at the new key, then clear
  `ADMIN_API_KEY_PREVIOUS` on the next deploy. Two deploys, no lockout.
- **Operator password rotation**: `npm run hash-operator-password`, deploy with the new
  hash in `OPERATOR_PASSWORD_HASH` and the old one in `OPERATOR_PASSWORD_HASH_PREVIOUS`,
  then clear the `_PREVIOUS` value. To invalidate every existing session as well, run
  `npm run revoke-operator-sessions` in the same window.
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