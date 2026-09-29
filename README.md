# AI Commerce Agent

Production-ready, multi-tenant AI sales agent connected to ecommerce stores (Shopify, Salla, Zid).

Licensed under the MIT License (see LICENSE).

## Run
```bash
cp .env.example .env          # fill OPENAI_API_KEY, generate a 64-char hex ENCRYPTION_KEY,
                              # set ADMIN_API_KEY (>=32 chars) and the DB/Redis passwords
npm install
npm run db:setup              # docker compose up -d postgres redis
npm run db:migrate            # drizzle-kit migrate — applies all schema migrations
npm run db:apply-rls          # create the non-owner app role + grants + RLS policies (migrate + this = db:bootstrap)
npm run dev
```

### Docker (production)
```bash
docker compose up -d postgres redis      # infra requires POSTGRES_PASSWORD, REDIS_PASSWORD
npm run db:bootstrap                     # run once after infra is up (migrate + RLS)
docker compose up --build app            # builds the image and starts the agent
```
The Dockerfile multi-stage build compiles TypeScript via `tsc` and runs with `node` (no tsx in prod).
The production entrypoint is `node dist/server.js`. The `migrate` image runs `db:migrate` + `db:apply-rls`.

Open `http://localhost:3000`.

## CI
GitHub Actions (`.github/workflows/ci.yml`) on push/PR runs:
- `npm run lint` + `npm run typecheck` + `npm run build`
- `npm run test` (feature gate) and `npm run test:cov` (coverage thresholds)
- `npm audit --audit-level=high` (known vulnerabilities)
- `docker compose build` (app + migrate images)
- a **migrations job**: boots Postgres (`pgvector/pgvector:pg17`) + Redis, applies `db:migrate` + `db:apply-rls` on a clean database, boots the built server against it, and runs the RLS/session integration tests

## Checks
- `npm run typecheck` — TS/PR gate
- `npm run lint` — strict TS (catches unused imports/params)
- `npm run test` — feature gate (vitest)
- `npm run test:cov` — coverage summary + thresholds
- `npm run test -- src/tests/integration.spec.ts` — RLS + session integration tests (needs a migrated DB, run locally with a `docker compose up` DB and `TEST_APP_DB_URL`/`TEST_PGADMIN_URL`/`TEST_REDIS_URL` set)

## What is implemented
- Multi-store structure
- Shopify GraphQL product/order integration
- AI catalog-grounded sales replies
- Generic webhook ingestion for Shopify/Salla/Zid
- Salla + Zid OAuth install flows with real provider adapters
- Arabic test/admin UI
- Operator dashboard (`web/` Next.js service): RTL analytics, store management, chat, billing, and automation views; roles for the operator and per-merchant client accounts (Phase 16)

## Phase 0 + 1 (persistence)
- Postgres via Drizzle ORM, 17-table schema, `store_id` on every tenant table
- Row-level security (RLS) enforced per tenant via a dedicated non-owner `agent_app` role; `drizzle/0004_security_rls.sql` enables RLS + policies on all tenant tables so it can't be skipped
- AES-256-GCM token encryption at rest with versioned keys (`platform_connections.key_version`)
- Conversation + message persistence on every chat turn
- Catalog sync interval worker with Shopify GraphQL cursor pagination (no 100-SKU truncation)
- Global Fastify error handler (no stack leaks), OpenAI resilience (timeout + 429 fallback)
- Dependency-aware `/api/health` (Postgres + Redis ping)

## Phase 2 + 3 (secrets + OAuth)
- Key-versioned encryption; rotate with `npm run db:rotate-key` (re-encrypts all tokens to `ENCRYPTION_KEY_VERSION`, uses `PGADMIN_URL`)
- Shopify OAuth install flow: `/api/oauth/shopify/start` → callback with HMAC + state (Redis), code→token exchange into `platform_connections`
- Token lifecycle: `refreshIfExpired()` per platform; worker refreshes proactively before sync and soft-fails with a warning; Shopify admin tokens considered non-expiring
- `storeToPublic` serializer guarantees tokens never leak in API responses

## Phase 4 (webhooks)
- `POST /webhooks/:platform` verifies signatures from raw bytes before touching state:
  - Shopify: `X-Shopify-Hmac-Sha256` (HMAC-SHA256 over the raw body with the app secret)
  - Salla/Zid: `x-hub-signature-256`/`x-salla-signature`/`x-zid-signature` (fails closed when the secret isn't configured)
- Raw-body capture via a scoped `preParsing` hook (no signed-body/parsed-body mismatch)
- Store resolve by shop domain (or store id when the ref is a UUID), then per-event type
- Idempotency: `events` unique `(store_id, type, dedup_key)` → duplicates return `{ received: true, duplicate: true }` with no side effects
- Handlers: Shopify `products/create|update` and `orders/create|update` upsert catalog/orders; Salla/Zid best-effort mapping (isolated, provider creds can pin exact shapes later)

## Phase 5 (retrieval)
- Swappable `Retriever` interface in `src/services/retrieval.ts`: `retrieve(query, storeId, opts?)` → `{ product, score, source }[]`
  - `fts`: Postgres full-text (`ts_rank` over a generated `search_vector` tsvector with GIN index; title/description/SKU weighted A/B/C)
  - `vector`: pgvector HNSW (`cosine`) over `text-embedding-3-small` embeddings; enabled only when `OPENAI_API_KEY` is set
  - `hybrid`: normalized score merge (sum of FTS + cosine) with dedup — degrades to FTS when vector is unavailable
- `RETRIEVAL_MODE=fts|vector|hybrid` (default `hybrid`)
- Embeddings populated lazily after every sync (`embedMissingCatalog`) — batches of 64, `ON CONFLICT`-safe, no key = no-op
- Chat now retrieves from the synced DB catalog only (no per-message remote API call); remote sync stays on `/api/products` + the worker
- DB schema DDL is applied via numbered migrations in `drizzle/` (`drizzle-kit migrate`, run as the DB superuser against `PGADMIN_URL`); `scripts/apply-rls.ts` then creates the non-owner `agent_app` role + policies. The Postgres image must be `pgvector/pgvector:pg17` (provides `CREATE EXTENSION vector`)

## Phase 6 (WhatsApp — Meta Cloud API direct)
- `GET /webhooks/whatsapp` Meta verification handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`), guarded by `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `POST /webhooks/whatsapp` inbound: `X-Hub-Signature-256` HMAC (App Secret, `WHATSAPP_APP_SECRET`), raw-body capture reused from Phase 4; non-`messages` changes ignored
- Channel binding: `whatsapp_channels` table maps `phone_number_id` → `store_id` (`POST/GET /api/whatsapp/channels`), tokens encrypted at rest (included in key rotation)
- Agent loop per inbound text: upsert customer (by phone) → ensure open `whatsapp` conversation → persist user msg → `retrieve()` → `answer()` → persist reply → `sendText()` via `graph.facebook.com/<version>/<phone_number_id>/messages`
- RLS: `whatsapp_channels` has the tenant policy plus an operator-exempt policy (for app→phone-number resolution) and a NULL-safe `store_id` cast so operator reads never trip on the uuid cast

## Phase 7 (Billing — Stripe)
- `billing_subscriptions` table (unique per store/customer/subscription) tracks plan, status, Stripe ids and period end; RLS tenant + operator-exempt (webhook resolution by Stripe id)
- `GET /api/billing/status/:storeId` — current `plan_status` on the store plus billing row state
- `POST /api/billing/checkout` (Checkout Session, requires `STRIPE_SECRET_KEY` + a price id) and `POST /api/billing/portal` (Billing Portal for self-service); both 503 when Stripe isn't configured
- `POST /webhooks/stripe` — `Stripe-Signature` (`t,v1`) HMAC over the raw body with `STRIPE_WEBHOOK_SECRET`, 300s replay tolerance, timing-safe compare
  - `checkout.session.completed`: upsert billing row via `stripe_customer_id`, set store `plan_status` → `active`
  - `customer.subscription.updated|deleted`: update by `stripe_subscription_id`, map status (trialing→`trial`, active→`active`, canceled/incomplete_expired→`expired`), plan inferred from `metadata.plan` or recurring interval
- Checkout/portal calls use `fetch` against `api.stripe.com` directly (restricted key), no SDK dependency

## Phase 8 (Analytics + attribution)
- `src/services/analytics.ts` — daily rollups into `daily_metrics` (per store/day): orders, revenue, conversations, messages, recommendations, clicks, conversions; zero-filled windows, idempotent upsert on `(store_id, day)`
- `GET /api/metrics/:storeId?days=N` (1–90, default 14) — returns daily rows + totals; **plan-gated**: `trial`/`active` allowed, otherwise `402 payment_required` (billing gate from Phase 7)
- `POST /api/attributions/click {productId}` — records a recommendation click (row-per conversation+product in `attributions`); requires a Bearer customer-session token (minted by `POST /api/session` with the admin key)
- Conversion attribution: on `orders/create|update` webhooks (Shopify + generic), the customer's phone/email is matched to their conversations and clicked-but-unconverted recommendations are marked `converted_at`
- `startMetricsRollup()` worker rolls up the last 3 days for every store every 6h (also on boot)
- `attributions` gained a `createdAt` column (recommendation time) to support the day dimension

## Phase 8b (Analytics depth — attribution by channel + revenue)
- `attributions` now carries `channel` (auto-captured from the conversation on click) and `revenue` (order total attributed on conversion); `daily_metrics` gained `attributed_revenue`
- **Last-click attribution**: on an order, only the customer's most recently clicked-but-unconverted recommendation is converted, and the full order total is attributed to it (`order_id` recorded). Customer is matched by **phone OR email** (a WhatsApp customer with no email still converts when the order carries both)
- `GET /api/analytics/:storeId/attributions?status=recommended|clicked|converted` — list with joined product info (title/price), channel and timestamps
- `GET /api/analytics/:storeId/sources` — funnel per channel: recommended / clicked / converted / attributed revenue / CTR / CVR / **avg conversion lag** (hours from click to purchase)
- `GET /api/analytics/:storeId/top-products?limit=` — per-product attribution: recommendations, clicks, conversions, attributed revenue, CVR
- Product join handles both ID formats (raw `(store_id, product_id)` as used by click API and Shopify GID `platform_product_id`)
- All three endpoints are plan-gated (`402` when not `trial`/`active`, like `/api/metrics`) and rate-limited

## Phase 8c (Conversion-lag analytics + dashboard)
- `GET /api/analytics/:storeId/conversion-lag?days=N` (1–90) — conversion aging over the range:
  - `overall`: count + **avg / median / p90** hours from click to purchase (`summarizeLag`)
  - `daily`: zero-filled per-day conversions + avg lag
  - `distribution`: non-overlapping time bands (`<1h`, `1–6h`, `6–12h`, `12–24h`, `1–7d`, `>7d`) with count + share (`lagDistribution`)
- Pure aggregation helpers exported for tests; plan-gated + rate-limited like the other analytics endpoints
- The operator dashboard is the separate `web/` service (Next.js), not a file served by this API. It reads the same analytics endpoints through its own authenticated proxy, so no page served here ever holds the admin key. See `web/README.md`.

## Operator access (added in the production-readiness pass)
- `POST /api/auth/operator/verify` — exchanges the shared operator password for a session epoch. The dashboard calls this server-to-server; the browser never sees the password hash or the admin key.
- Password stored as a scrypt hash (`OPERATOR_PASSWORD_HASH`), generated with `npm run hash-operator-password`; the previous hash is accepted during a rotation.
- Lockout after 5 failed attempts: 30s, doubling to 15m, keyed per IP in Redis so it survives restarts and applies across replicas. Fails closed with `503` if Redis is unreachable.
- `npm run revoke-operator-sessions` bumps the epoch in Redis, immediately invalidating every issued session cookie.

## Phase 9e (Agent retrieval evaluation harness)
- `npm run eval` — scores the retrieval pipeline against a curated dataset (`eval/queries.json`)
- Pure scoring (`src/evals/scoring.ts`, unit-tested): hits@1/3/5, recall@3/5, **MRR**, **nDCG@5**
- CLI: `npm run eval` (defaults store `6aa91608-…`, dataset `eval/queries.json`, current `RETRIEVAL_MODE`) ·
  `npm run eval -- --store <id> --dataset <path> --mode fts|vector|hybrid --rerank off|synonym|embedding`
- Runs each query through the configured retriever (limit 10), prints a per-case table, an aggregate summary (averaged over cases with relevant targets — decoy/no-target cases excluded), and lists no-hit cases
- Baseline on the test store (hybrid, no embedding key): hits@1 **3/8**, recall@5 0.375, MRR 0.375 — FTS `simple` AND-tokenization misses paraphrases/bilingual queries; this is the signal for re-ranking/synonym work

## Phase 9f (Retrieval re-ranking — synonyms + embeddings)
- `src/services/rerank.ts` — two-stage re-ranker over the candidate pool:
  1. **synonym recall** (`SYNONYM_GROUPS`, e.g. tee/t-shirt/shirt/قميص/تيشيرت, black/أسود, cotton/قطن): ILIKE expansion pulls relevant products the FTS/vector retriever discarded (English ↔ Arabic cross-language queries)
  2. **re-rank**: `lexicalReRank` (title match weight 2, description 1 — deterministic, no API) or `embeddingReRank` (query cosine vs stored product embeddings; gracefully falls back to lexical when `OPENAI_API_KEY` is missing)
- `RETRIEVAL_RE_RANK=off|synonym|embedding` (default `synonym`); `retrieve()` always applies the pipeline unless set to `off`
- Eval delta on the test store (hybrid): hits@1 **3/8 → 5/8**, recall@5 0.375 → **0.875**, MRR 0.375 → **0.750**, nDCG@5 0.375 → **0.783** (catalog-proposals + decoy cases still correctly excluded)
- Unit-tested (`rerank.spec.ts`): expansion, title-vs-desc weighting, re-ranking order, de-duplication

## Phase 10 (Automation engine — follow-up workflows)
- **Triggers**: `clicked_no_conversion` (customer clicked a recommended product on WhatsApp but hasn't converted within the lookback window) and `inactive_conversation` (conversation idle with no reply after the last assistant message)
- **Actions**: `whatsapp_text` — free-form message with `{customerName}`, `{shopName}`, `{productTitle}`, `{productLink}` template interpolation; logs to conversation history even when the Meta API send fails (for audit trail)
- `automationRules` schema enriched with `cooldownMinutes` (default 24h), `lookbackHours` (default 72h), `lastFiredAt`; new `automationLogs` table records every action `(store_id, rule_id, conversation_id)` with unique dedup index — prevents re-sending the same nudge to the same conversation across ticks
- Engine (`src/services/automation.ts`): evaluates enabled rules on a 30s poll (`startAutomationWorker`), respects rule cooldown, renders templates per candidate, records claims+results transactionally; sends via `sendText` for WhatsApp channels, falls back to persisting an assistant message for other channels
- CRUD: `POST/GET/PUT/DELETE /api/automation/rules`; `POST /api/automation/run` (ad-hoc, cooldown bypass) for manual testing
- RLS: `automation_rules` and `automation_logs` are operator-exempt so the worker can evaluate rules across all stores
- Migration `0005_automation_engine.sql`; unit-tested pure helpers (`renderTemplate`, `isInCooldown`) — `automation.spec.ts`

## Phase 12 (PDPL — retention + data access/erasure)
- **Retention job** (`src/services/pdpl.ts` + `src/workers/retention.ts`): every 6h, per store, deletes expired PII — inactive conversations (cascading messages), unreconverted attributions, raw webhook `events`, and orphan customers (no conversations/orders, older than the window). Aggregated `daily_metrics` are retained (non-PII rollups only)
- Configurable windows: `RETENTION_CONVERSATIONS_DAYS` (365), `RETENTION_ATTRIBUTIONS_DAYS` (365), `RETENTION_EVENTS_DAYS` (90), `RETENTION_CUSTOMER_ORPHAN_DAYS` (730), `RETENTION_ENABLED` (default true); also exposed as `retention.purge` job type for ad-hoc runs
- **Right of access**: `POST /api/pdpl/access {storeId, phone|email}` → customer profile, orders, and conversations with messages + attributions
- **Right to erasure**: `POST /api/pdpl/erase {storeId, phone|email}` → deletes the customer, their conversations/messages/attributions/automation logs, and **anonymizes order PII** (keeps the order row for financial/legal records, nulls `customer_name/phone/email/customer_id`)
- `POST /api/pdpl/purge {storeId}` runs the retention sweep on demand
- All PDPL routes are tenant-scoped + rate-limited, intentionally **not** plan-gated (legal compliance isn't gated by billing plan)
- Pure `retentionCutoffs()` unit-tested (`pdpl.spec.ts`)
- Duplicate data-subject records are handled in full: `access` merges and `erase` destroys **all** customer rows matching the phone/email plus their conversations/messages/attributions (verified live with duplicated rows)

## Phase 13 (PII encryption at rest — message bodies)
- Conversation message bodies are encrypted on write with AES-256-GCM before insert (`addMessage`) and transparently decrypted on read (`history()` and `/api/pdpl/access`) via `src/services/pii.ts` (`encryptPii`/`decryptPii`, reusing the key-rotation-safe `enc:v1:<version>:…` token scheme)
- Plaintext legacy rows remain readable (decrypt is a no-op on non-`enc:v1:` values) — no backfill needed; no schema change (ciphertext lives in the existing `content` column)
- Verified end-to-end: ciphertext (`enc:v1:`) at rest in Postgres, zero ciphertext leaks across `/api/pdpl/access`, existing `ENCRYPTION_KEY`/`ENCRYPTION_KEY_VERSION` config drives it
- Unit-tested round-trip + legacy passthrough (`pii.spec.ts`)

## Phase 14 (Salla + Zid OAuth install flows)
- Merchant-initiated installs for all three platforms via `src/routes/oauth.ts` (CSRF-protected: Redis-backed `state` with 10-minute TTL, platform-bound on callback)
- **Salla** (`/api/oauth/salla/start` → `/api/oauth/salla/callback`): auth + token exchange at `accounts.salla.sa/oauth2`, merchant profile via `/oauth2/user/info` for store name/domain; refresh tokens requested via `offline_access` scope (14-day access tokens)
- **Zid** (`/api/oauth/zid/start` → `/api/oauth/zid/callback`): auth + token exchange at `oauth.zid.sa`; stores both the manager `access_token` (sent as `X-Manager-Token`) and the `authorization` JWT — the JWT is persisted in `stores.settings.zidAuthorization` so a future real adapter can send both headers
- **Provider token refresh** (`src/integrations/refresh.ts`): `connectionRepo.refreshIfExpired` now refreshes Salla (14-day) and Zid (1-year) tokens via the documented token endpoints, rotating the Zid authorization JWT in store settings and persisting new `expiresAt`
- Handles reinstalls: existing store by `shopDomain` gets tokens replaced via `connectionRepo.setTokens` instead of being duplicated
- **Fails closed**: without `SALLA_CLIENT_*`/`ZID_CLIENT_*` creds the endpoints return `503 *_oauth_not_configured`; callbacks reject unknown/rotated `state` with `401`
- Unit-tested: Salla/Zid refresh flows incl. metadata + fail-closed (`refresh.spec.ts`)

## Phase 15 (LLM provider fallback — OpenRouter)
- OpenRouter is a drop-in fallback when OpenAI is **missing or failing** (no `OPENAI_API_KEY`, 429, 5xx, timeout, network). Chat + embeddings both covered.
- Chat (`src/services/llm.ts`): `chatWithFallback` tries the OpenAI Responses API first, then OpenRouter via its OpenAI-compatible `/chat/completions` endpoint. The Responses-API item shape (`developer` role, `function_call`/`function_call_output`) is converted to chat-completions `system`/`assistant.tool_calls`/`tool` messages (`toChatMessages`) so the tool loop in `agent.ts` drives either provider unchanged.
- Embeddings (`src/services/embedding.ts`): OpenAI embeddings first, `POST {OPENROUTER_BASE_URL}/embeddings` fallback. `OPENROUTER_EMBEDDING_MODEL` must output 1536-dim vectors to match the pgvector column (default `openai/text-embedding-3-small`).
- Env: `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `OPENROUTER_MODEL` (default `openai/gpt-4o-mini`, must support tool calling), `OPENROUTER_EMBEDDING_MODEL`.
- Still no provider available → the existing Arabic fallback reply is returned. Unit-tested conversions in `llm.spec.ts`.

## Phase 16 (Merchant client accounts — two-role dashboard)

Two credentials now unlock the dashboard: the **operator** (one global account, unchanged) and **clients** — merchant accounts that each own a subset of stores. The whole point of the layer is least privilege: the API checks ownership, not the UI.

- **Invite-only accounts**: there is no public signup. An operator creates an account (normalized email) via `POST /api/clients` (dashboard Clients page) or `npm run client:create -- "<name>" <email>` — since Phase 17 the identity is created in Supabase Auth (`email_confirm: true`, so the printed one-time password works immediately). `clients` gained RLS policies; `stores.client_id` (nullable, `ON DELETE set null`) links a store to its owner. Migration `0009_clients.sql` (hand-written).
- **Client login** (`POST /api/auth/client/login`, mirrored by the BFF login route): returns `{ ok, clientId, name, email, sid, epoch, expiresIn }`. The `sid` is an opaque Redis session; the account is re-read from the DB on *every* guarded call, so a suspension kills live sessions immediately. Uniform `401` for unknown email / wrong password / suspended account (dummy scrypt burn keeps timing uniform), escalating per-IP **and** per-email lockout (5 → 30s doubling to 15m, Redis-resident, survives redeploys). Credentials verify against the legacy scrypt hash for not-yet-imported accounts and against Supabase Auth once an account has a `supabase_uid` (Phase 17).
- **Session epoch per account** (`cli:sess:epoch:{clientId}`): changing the password logs every other device out and re-signs the caller's sid; suspension or a password reset logs everyone out. The BFF verifies the cookie against the same epoch, so revocation is instant on both sides. `logout` revokes the sid; logins are rate-limited per IP.
- **Guard precedence**: `requireDashboard` on every tenant data path now accepts the operator admin key **or** a valid client session — and when a request carries both, the **client session wins** (a possession can't silently upgrade to operator scope). A client reaching a store it doesn't own gets `404 store_not_found`; a client call missing `storeId` gets `400 store_required`. Operator-only routes (`requireApiKey`) are unchanged: clients admin surface, automation run, jobs run, store api-key issue, PDPL actions.
- **Dashboard**: the web login has Operator and Store sign-in tabs; operators see a new Clients page (list/create/suspend/reactivate/reset password with a one-time temporary password); client sessions hide the operator admin nav and the Shopify OAuth install block. The BFF forwards `x-client-session: <sid>` for client sessions and never `x-api-key`; the API is still the source of truth. No CORS change — everything still flows through the same-origin proxy.
- Protected routes, ownership checks, and lockout are covered by `requireDashboard` unit tests (`src/lib/auth.spec.ts`) and route-level specs (`src/tests/clientAccounts.spec.ts`, with an in-memory Redis harness). The operator epoch and account epochs use the same rotation scheme (random value on bump, not `INCR` — seeds are hex strings).
- Durable job queue backed by the existing `jobs` table (`jobsRepo`): `enqueue`, `listDue`, `run` (atomic claim → success/fail/backoff), `retry`, `list` (tenant + operator)
- `MAX_ATTEMPTS = 3`, exponential backoff (`BASE_DELAY_MS × 2^(n-1)`, capped); after exhausting attempts → status `dead`
- Deduplication on enqueue: same `(store_id, type)` won't create a second `pending`/`running` row
- Operator-exempt RLS on `jobs` so the worker can scan due rows across all stores
- `startJobsWorker()` polls every 3 s; handlers registered per type:
  - `catalog.sync` — full Shopify sync (refresh token, list, upsert, mark-synced)
  - `embedding.backfill` — `embedMissingCatalog`
  - `metrics.rollup` — rollup last 3 days
- `POST /api/jobs` (enqueue), `GET /api/jobs/:storeId?status=` (list), `POST /api/jobs/:jobId/retry` (reschedule dead), `POST /api/jobs/run` (sync ad-hoc)
- Catalog interval (`src/workers/catalogSync.ts`) now **enqueues** `catalog.sync` jobs instead of processing inline — the worker executes them with retries

## Phase 17 (Supabase Auth migration — client identities + claim-based RLS)

Client (merchant) credentials now live in **Supabase Auth**, not the app database. The
identity layer moved there so the install can stop holding merchant passwords; everything
else — stores, orders, billing, the Redis session layer — stays app-owned. The app's
Postgres may itself *be* Supabase's managed Postgres during the migration, which is exactly
what the migration is engineered for.

- **Identity**: each `clients` row links to a Supabase user via `clients.supabase_uid`
  (unique, nullable). `password_hash` holds the legacy scrypt digest for accounts **not
  yet imported**; linking an identity (`setSupabaseUid`) withdraws the hash, so a linked
  account can only sign in through Supabase.
- **Dual-mode login** (`src/routes/clientAuth.ts`): an account still holding `password_hash`
  verifies the scrypt digest (with the dummy-hash burn for unknown emails); an account
  without one verifies against Supabase (`signInWithPassword`, gated on a confirmed email
  and on the auth user matching `supabase_uid`). Failures are a uniform `401`. Without
  Supabase keys configured the API fails closed with `503 auth_unavailable`.
- **Self-service flows** (web BFF under `web/app/api/auth/*` + `web/app/auth/*`):
  `/register` creates the identity with `email_confirm:false` (Supabase mails the
  confirmation link), `/forgot` issues a recovery email pointing at
  `<APP_BASE_URL>/login/reset`, `/reset` verifies the one-time token, rotates the password,
  bumps the account epoch (killing every older session) and signs the caller back in, and
  `/auth/callback` completes Google OAuth (PKCE). All of it runs in the server runtime:
  the Supabase token is exchanged for this app's own Redis session id and dropped before
  anything reaches the browser. The client sends only email/password forms and follows
  redirects.
- **Operator invite & import**: `POST /api/clients` /
  `npm run client:create` create the Supabase user with `email_confirm:true`, so the printed
  one-time password works immediately. Existing scrypt accounts are bulk-migrated by
  `npm run client:import-supabase` — reuses the identity when the email already has one,
  links the row (hash withdrawn), then prints per-account recovery links for the operator
  to forward (no mailer in this repo).
- **Claim-based RLS**: `drizzle/0010_supabase_rls.sql` rewrites the tenant policies to
  `request.jwt.claims` (a `public.auth_jwt()` shim is provided for non-Supabase Postgres).
  The API still sets the claims inside the same transaction it does the work in, so
  behavior is identical against plain local Postgres and Supabase's `authenticated` role.
  `drizzle/0011_store_api_key_columns.sql` adds the `stores.api_key_hash`/`api_key_hint`
  columns that `0005` was committed without.
- **Env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` on the API;
  `SUPABASE_URL` + `SUPABASE_ANON_KEY` on the web service (anon only — the service-role key
  never enters the web service). `APP_BASE_URL` must be the dashboard origin, because it is
  the base of the recovery link (`login/reset`) and must match Supabase's `SITE_URL`.
- **Verification**: the RLS policies run against local Postgres in the integration suite
  via the `auth_jwt()` shim (`src/tests/integration.spec.ts`); the Supabase code paths are
  covered with a stubbed SDK in `src/tests/clientAccounts.spec.ts` and the web BFF route
  specs (`web/app/**/*/route.spec.ts`, `web/app/auth/callback/route.spec.ts`). The one-pass
  live check runs once real project credentials are configured.

## Phase 11 (Rate limiting — per tenant, Redis)
- **Implementation:** custom store-scoped Redis fixed-window limiter in `src/lib/rateLimit.ts` — **not** the `@fastify/rate-limit` plugin named in the original roadmap (the custom limiter keys per `store_id` from day one and lives on Redis, which fits multi-tenant needs better than the IP-based plugin)
- Fixed-window on Redis (`INCR` + `EXPIRE`), keyed per `store_id` with scope: `rl:store:{scope}:{storeId}`; chat/click routes without a store id in the body fall back to `rl:store:{scope}:ip:{ip}` (the `reqIp` helper reads `cf-connecting-ip` / `x-forwarded-for` when `TRUST_PROXY=1`)
- The admin-key gate also has a per-IP brute-force counter (`rl:apikey:{ip}`, 30 fails/min → `429`), reset on any successful key check
- Two windows by default: general API `RATE_LIMIT_PER_MIN` (60) and chat `RATE_LIMIT_CHAT_PER_MIN` (20, protects LLM spend)
- Applied via Fastify `preHandler` to tenant-scoped routes: `/api/chat`, `/api/products`, `/api/attributions/click`, `/api/metrics`, `/api/billing/checkout`, `/api/billing/portal`, `/api/whatsapp/channels`, `/api/jobs`, `/api/jobs/:id/retry`, `/api/jobs/run`, `/api/automation/rules`, `/api/automation/rules/:ruleId` (PUT/DELETE), `/api/automation/run`, `/api/pdpl/access`, `/api/pdpl/erase`, `/api/pdpl/purge`
- On breach: `429 rate_limit_exceeded` with `Retry-After` header (error handler merges `error.headers`)
- Not applied to `/webhooks/*` — providers retry in bursts; webhooks are idempotent + signature-gated

## Production hardening (security blocks)
- **Guest sessions** (`src/lib/session.ts` + `src/routes/session.ts`): `POST /api/session` (admin-keyed, rate-limited) mints a short-TTL opaque token stored in Redis (`sess:{sha256(token)}`, `SESSION_TTL_SECONDS`, default 1h). `/api/chat` and `/api/attributions/click` now require `Authorization: Bearer <token>` and derive `store_id`/`conversation/store_id` from the session — no tenant key from the client
- **RLS in the migration**: `drizzle/0004_security_rls.sql` enables RLS + tenant/operator policies on all 17 tables, so the distance between "migrations applied" and "RLS enforced" is zero; role/grants still live in `scripts/apply-rls.ts` (fails closed in production if `APP_DB_PASSWORD` is missing)
- **OAuth hardening** (`src/routes/oauth.ts`): redirect URIs are restricted to `APP_BASE_URL` + `OAUTH_REDIRECT_ALLOWLIST` (no open redirect), and `/start` caps state creation per IP (100/10 min → `429`)
- **Webhook signatures per platform** (`src/lib/webhooks.ts`): Shopify `x-shopify-hmac-sha256`, Salla `x-salla-signature`, Zid `x-zid-signature`, plus the shared `x-hub-signature-256` fallback — all verified from the raw body, fail closed when the secret is unset
- **Zid secret at rest**: the `authorization` JWT is stored in `store.settings` via `updateSettingsEncrypted` (AES-256-GCM) and read back decrypted by the adapter (`storeRepo.getSecret`); never plaintext
- **Admin endpoints on the admin key**: `GET/POST /api/stores`, `DELETE /api/stores/:storeId` (cascading delete of all tenant rows), `POST /api/session`, plus every analytics/metrics/automation/pdpl/jobs route
- **No credential in the browser**: the dashboard authenticates with an `HttpOnly` session cookie and calls its own server-side proxy, which attaches `ADMIN_API_KEY`. The `X-Api-Key` input page that used to live at `GET /dashboard` is gone, along with the localStorage credential path. `NEXT_PUBLIC_ADMIN_API_KEY` no longer exists; CI fails the build if any privileged identifier reaches the client bundle.
- **Infra**: Postgres/Redis bound to `127.0.0.1` with required `REDIS_PASSWORD` (`redis-server --requirepass`), pinned image digests, `restart: unless-stopped`, memory limits, and a separate `migrate` image that runs `db:migrate` + `db:apply-rls`

## Production next steps already defined in docs/ARCHITECTURE.md
- PostgreSQL + Redis/queue
- OAuth install flows for each platform
- Signed webhook verification
- WhatsApp provider integration
- conversation persistence
- billing/subscriptions
- attribution and analytics
- retry/dead-letter jobs

The items above are now implemented end-to-end (see the phase sections and `docs/ARCHITECTURE.md`). One deliberate limitation remains: Salla/Zid *webhook* payload shapes are pinned to the same documented mappers the sync/backfill paths use (`src/lib/webhookApply.ts`), but only live provider stores can confirm the exact wrapper keys for every event type — until then, a payload that does not resolve to a known `order`/`product` shape is logged and skipped rather than written with a synthetic id.
