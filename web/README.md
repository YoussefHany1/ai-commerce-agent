# AI Commerce Agent — Dashboard (Next.js 16)

Premium SaaS dashboard for the AI Commerce Agent backend (Fastify API in the repo root).

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v3 (custom theme, dark/light mode, RTL support)
- `@tanstack/react-query` (server state + cache)
- `recharts` (charts) + `framer-motion` (animations)
- `lucide-react`, `clsx` + `tailwind-merge`, `date-fns`, `sonner`
- `redis` (session epoch), `vitest` (server-side tests)

## Getting started

```bash
cp .env.local.example .env.local   # the proxy cannot authenticate without ADMIN_API_KEY
npm install
npm run dev                        # http://localhost:3001
```

Then sign in at `/login` with the operator password. In local dev over plain http,
set `SESSION_COOKIE_SECURE=false`, or the browser will refuse to store the cookie.

## How authentication works

The browser never holds a credential. It posts the operator password once to this
app's own `/api/auth/login`, which forwards it to the API's
`/api/auth/operator/verify`; the API checks the scrypt hash and a Redis-backed
attempt counter, then returns the current session epoch. This app mints an
`HttpOnly` `aca_session` cookie (8h, `Secure`, `SameSite=Lax`) bound to that epoch.

Every data call then goes to this app's own `/api/*` route handlers, which verify
the cookie, check the epoch against Redis, and attach `ADMIN_API_KEY` when calling
the API. Consequences worth knowing:

- `NEXT_PUBLIC_ADMIN_API_KEY` does not exist and must not be reintroduced. Any
  `NEXT_PUBLIC_`-prefixed value is inlined into the public bundle.
- `REDIS_URL` must point at the same Redis as the API. It is what makes
  `npm run revoke-operator-sessions` on the API take effect here.
- The API no longer needs to be CORS-reachable from a browser.
- Revoking a session on the API also signs the operator out of this service,
  because both compare the same epoch.

`web/proxy.ts` redirects signed-out visitors away from `/dashboard` on the Edge
runtime, where neither `node:crypto` nor Redis is available, so it checks cookie
shape and expiry only. The Node-runtime proxy is the authoritative gate and checks
the signature and epoch on every request.

## API proxy

`app/api/[...path]/route.ts` forwards a fixed allowlist of method-and-path pairs
(`lib/server/upstream.ts`) and 404s anything else. It also caps request bodies at
256 KiB, requires `application/json` on bodied requests, drops inbound `x-api-key`
and `cookie` headers, and does not relay a caller-supplied `x-forwarded-for`.

`lib/server/upstream.spec.ts` mirrors the call sites in `lib/api.ts`, so adding an
API method without an allowlist rule fails a test rather than returning 404 at
runtime.

## Pages

| Route                      | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `/login`                   | Operator sign in; accepts a `?next=` return path          |
| `/dashboard`               | KPI cards, revenue/conversations/funnel charts, quick chat |
| `/dashboard/analytics`     | Attribution table, top products, sources funnel, lag chart |
| `/dashboard/stores`        | Store cards, add-store modal + Shopify OAuth, disconnect   |
| `/dashboard/automation`    | Automation rules, toggle, create drawer, delete dialog     |
| `/dashboard/billing`       | Plan cards, Stripe checkout/portal, trial status           |
| `/dashboard/settings`      | WhatsApp channel config, live health, danger zone          |

## Env vars

| Var                     | Public | Default                 | Notes                                                          |
| ----------------------- | ------ | ----------------------- | -------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`   | yes    | `http://localhost:3000` | Public API origin. Inlined at build time. OAuth link + webhook display only |
| `API_URL`               | no     | —                       | Server-side upstream target for the proxy                       |
| `ADMIN_API_KEY`         | no     | —                       | Operator credential the proxy attaches; must match the API       |
| `SESSION_SECRET`        | no     | —                       | HMAC key for the session cookie, min 32 chars                    |
| `REDIS_URL`             | no     | —                       | Same Redis as the API, for the session epoch                     |
| `SESSION_COOKIE_SECURE` | no     | `Secure` in production  | Set `false` for local http                                       |

## Commands

```bash
npm run dev         # dev server on :3001
npm run test        # vitest
npm run test:cov    # with coverage over lib/server
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build       # production build (standalone output)
```

## Notes

- The Shopify OAuth link navigates to the API origin directly and appends
  `redirectAfter`, so the install returns to the dashboard instead of a raw JSON
  response. That only works if the API's `OAUTH_REDIRECT_ALLOWLIST` includes this
  dashboard's origin.
- Metrics/analytics endpoints are billed as `402 payment_required` when a store is
  not on `trial`/`active`; the UI reacts with a blurred "Upgrade to Pro" gate.