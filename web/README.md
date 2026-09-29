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
cp .env.local.example .env.local   # needs SESSION_SECRET, REDIS_URL and the Supabase anon key
npm install
npm run dev                        # http://localhost:3001
```

Then sign in at `/login` with an operator's **email and password** — there is no shared
install-wide operator password any more. In local dev over plain http, set
`SESSION_COOKIE_SECURE=false`, or the browser will refuse to store the cookie.

## How authentication works

The browser never holds a credential. It posts email and password once to this app's own
`/api/auth/login`, which forwards to the API's `/api/auth/operator/login` or
`/api/auth/client/login`. Supabase verifies the credential — there is no password hash
in this codebase for a human any more — and the API answers with a `sid`. This app mints
an `HttpOnly` `aca_session` cookie (`Secure`, `SameSite=Lax`) carrying the credential
kind (`operator` | `client`), the session id, and the epochs that session is bound to.

Every data call goes to this app's own `/api/*` route handlers, which verify the cookie
and check the epochs against Redis, then forward exactly one of:

- **operator**: `x-operator-session: <sid>`
- **client**: `x-client-session: <sid>`

Never `x-api-key`. This service does not have `ADMIN_API_KEY` at all — it is a machine
credential for the CLI, and a session is resolvable to a person without it, so there is
nothing here for it to authenticate.

Both branches of the login form, the Google button, and the password-recovery link are
one flow now. The OAuth callback cannot know which kind of person is arriving — it is one
redirect either way — so it hands the token to `/api/auth/exchange` and mints whichever
session the API says that token earned. The API resolves a Supabase token to exactly one
local row; a uid bound to both `operators` and `clients` is refused as a conflict.

Client accounts (merchant login/register/forgot/reset, Google OAuth) and operators use
the same Supabase identities and the same BFF routes (`/api/auth/login`, `/register`,
`/forgot`, `/reset`, `/auth/callback`): the email/password form, the PKCE OAuth
exchange, and the password-reset OTP all happen against Supabase in the server runtime,
and the browser only ever receives this app's own `aca_session` cookie. Leave
`SUPABASE_URL`/`SUPABASE_ANON_KEY` unset and both branches stay closed (fail-closed
`503`s on the web side).

The API is still the source of truth: it re-resolves the sid, re-reads the account status
and store ownership on every guarded call, and its epoch keys are what make revocation
instant. Consequences worth knowing:

- `NEXT_PUBLIC_ADMIN_API_KEY` does not exist and must not be reintroduced. Any
  `NEXT_PUBLIC_`-prefixed value is inlined into the public bundle.
- `REDIS_URL` must point at the same Redis as the API. It is what makes
  `npm run operator:revoke-sessions` on the API take effect here, and what lets client
  suspension/password resets log every live client out (`cli:sess:epoch:{clientId}`).
- Operator revocation has two scopes, and this service can only honour the install-wide
  one: a per-operator epoch bump happens on the API's Redis, and the cookie carries that
  per-person epoch, so one person can be signed out without the rest being disturbed.
- The cookie is minted for the lifetime the API returns (`expiresIn` =
  `CLIENT_SESSION_TTL_SECONDS` or `OPERATOR_SESSION_TTL_SECONDS`), so those knobs govern
  both sides.
- The API no longer needs to be CORS-reachable from a browser.

`web/proxy.ts` redirects signed-out visitors away from `/dashboard` on the Edge
runtime, where neither `node:crypto` nor Redis is available, so it checks cookie
shape and expiry only. The Node-runtime proxy is the authoritative gate and checks
the signature and epoch on every request.

## API proxy

`app/api/[...path]/route.ts` forwards a fixed allowlist of method-and-path pairs
(`lib/server/upstream.ts`) and 404s anything else. It also caps request bodies at
256 KiB, requires `application/json` on bodied requests, drops inbound `x-api-key`,
`x-client-session` and `cookie` headers, and does not relay a caller-supplied
`x-forwarded-for`. The allowlist includes the client-admin surface operators use on
the dashboard (`GET/POST /api/clients`, `PATCH /api/clients/:id/status`,
`POST /api/clients/:id/reset-password`); store attach/detach (`POST/DELETE
/api/clients/:id/stores`) stays CLI/API-only.

`lib/server/upstream.spec.ts` mirrors the call sites in `lib/api.ts`, so adding an
API method without an allowlist rule fails a test rather than returning 404 at
runtime.

## Pages

| Route                      | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `/login`                   | Operator or store (client) sign in; accepts a `?next=` return path |
| `/dashboard`               | KPI cards, revenue/conversations/funnel charts, quick chat |
| `/dashboard/analytics`     | Attribution table, top products, sources funnel, lag chart |
| `/dashboard/clients`       | Operator-only: invite, suspend/reactivate, reset client passwords |
| `/dashboard/stores`        | Store cards, add-store modal + Shopify OAuth, disconnect. Shopify OAuth install is hidden from client sessions |
| `/dashboard/automation`    | Automation rules, toggle, create drawer, delete dialog     |
| `/dashboard/billing`       | Plan cards, Stripe checkout/portal, trial status           |
| `/dashboard/settings`      | WhatsApp channel config, live health, danger zone          |

## Env vars

| Var                     | Public | Default                 | Notes                                                          |
| ----------------------- | ------ | ----------------------- | -------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`   | yes    | `http://localhost:3000` | Public API origin. Inlined at build time. OAuth link + webhook display only |
| `API_URL`               | no     | —                       | Server-side upstream target for the proxy                       |
| `SESSION_SECRET`        | no     | —                       | HMAC key for the session cookie, min 32 chars                    |
| `SUPABASE_URL`          | no     | —                       | Supabase project URL; must match the API's                     |
| `SUPABASE_ANON_KEY`     | no     | —                       | Anon (public) key, not the service-role key; never inlined       |
| `REDIS_URL`             | no     | —                       | Same Redis as the API, for the session epochs                    |
| `SESSION_COOKIE_SECURE` | no     | `Secure` in production  | Set `false` for local http                                       |

`SUPABASE_SERVICE_ROLE_KEY` must never appear here. It bypasses RLS on every table and can
rewrite any auth user; `scripts/check-render.mjs` fails the build if the web service is
given it. `ADMIN_API_KEY` is likewise not needed and should be removed if it is still
present — the checker rejects that too.

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