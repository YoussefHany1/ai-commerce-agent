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

## Backups

The Postgres data lives in the `pgdata` volume. Schedule a periodic dump to off-site
storage (e.g. a cron job running `docker compose exec -T postgres pg_dump -U postgres ai_commerce_agent | gzip > backup-$(date +%F).sql.gz`). Redis is ephemeral cache/session state; a Redis restart drops sessions and rate-limit counters, so no separate backup is needed.