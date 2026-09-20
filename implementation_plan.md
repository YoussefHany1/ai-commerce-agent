# Production Issues Remediation Plan

## Overview

The project is close to production, but it needs fixes distributed across **3 phases**, ordered from most critical to least critical.
There are no major architectural changes — these are all targeted additions and fixes.

---

## Phase One — P0 (Critical, required before any deployment)

### 1. Authentication — API Key Middleware

**Problem:** All endpoints are exposed without auth.

**Solution:** Add an `X-Api-Key` header check as a Fastify preHandler on all sensitive routes. The key is stored in `.env` as `ADMIN_API_KEY`.

#### [NEW] `src/lib/auth.ts`
- A `requireApiKey(req, reply)` function that validates the `X-Api-Key` header
- Compare it with `config.ADMIN_API_KEY` using `timingSafeEqual`
- Return 401 if missing or incorrect
- Excluded from auth: `/api/health`, `/webhooks/*`, `/api/oauth/*`, `/api/chat`, `/api/attributions/click`, `GET /dashboard`

#### [MODIFY] `src/config.ts`
- Add `ADMIN_API_KEY: z.string().min(32).optional()` to the schema
- Add a startup warning if it is not configured in production

#### [MODIFY] `src/routes/api.ts`
- Add `requireApiKey` as a preHandler on: `GET /api/stores`, `POST /api/stores`, `GET /api/products/:storeId`

#### [MODIFY] `src/routes/analytics.ts`, `automation.ts`, `billing.ts`, `pdpl.ts`, `whatsapp.ts`, `jobs.ts`
- Add `requireApiKey` as the first preHandler on all administrative routes
- `/api/chat` remains open (it is used by the widget)

---

### 2. Fix Shopify OAuth Bug (duplicate store)

**Problem:** The Shopify callback always calls `storeRepo.create()`, while Salla/Zid use `saveInstall()`.

#### [MODIFY] `src/routes/oauth.ts`
- In `GET /api/oauth/shopify/callback`, replace `storeRepo.create(...)` with `saveInstall({...})` following the same pattern as Salla
- Add platform: `'shopify'` to `saveInstall` (update the type to include shopify)

#### Diff
```diff
- const id = await storeRepo.create({
-   name: stored.shop,
-   platform: 'shopify',
-   shopDomain: stored.shop,
-   accessToken: token.access_token,
-   scopes: token.scope ? token.scope.split(',') : SCOPES,
- });
+ const id = await saveInstall({
+   platform: 'shopify',
+   name: stored.shop,
+   shopDomain: stored.shop,
+   accessToken: token.access_token,
+   scopes: token.scope ? token.scope.split(',') : SCOPES,
+ });
```

---

### 3. Rate Limiting on `/api/chat`

**Problem:** `/api/chat` is open to the widget without any rate limit — anyone can fully drain LLM API costs.

#### [MODIFY] `src/server.ts`
- Add the `@fastify/rate-limit` plugin:
```ts
await app.register(import('@fastify/rate-limit'), {
  max: 20,           // 20 requests
  timeWindow: '1 minute',
  keyGenerator: (req) => req.headers['x-store-id'] as string ?? req.ip,
  errorResponseBuilder: () => ({ error: 'Too Many Requests', statusCode: 429 }),
});
```
- Add `{ config: { rateLimit: { max: 5, timeWindow: '10 seconds' } } }` specifically to the `/api/chat` route because it is the most expensive endpoint

#### [MODIFY] `package.json`
- Add `@fastify/rate-limit` to the dependencies

---

### 4. HTTPS / TLS Verification

**Problem:** If there is no reverse proxy (Nginx/Caddy) in front of the server, the API key is sent as clear text over the network.

#### [MODIFY] `src/config.ts`
- Add a startup warning:
```ts
if (process.env.NODE_ENV === 'production' && !process.env.TRUST_PROXY) {
  logger.warn('TRUST_PROXY not set — ensure HTTPS is terminated upstream (Nginx/Caddy/Load Balancer)');
}
```

#### [MODIFY] `src/server.ts`
- Add `trustProxy: true` to Fastify options when there is a reverse proxy:
```ts
const app = Fastify({ logger: true, trustProxy: !!config.TRUST_PROXY });
```

#### [NEW] `DEPLOYMENT.md` (note)
- Explain that the server must be behind an HTTPS proxy in production
- Add a simple Nginx/Caddy config example

---

### 5. Pin Package Versions

**Problem:** All dependencies use `"latest"`.

#### [MODIFY] `package.json`
- Run `npm ls` to get the current versions and pin them
- Convert every `"latest"` to an exact version (e.g. `"fastify": "5.4.0"`)

---

## Phase Two — P1 (Important, before the first real traffic)

### 4. Graceful Shutdown for Workers

**Problem:** The workers use `setInterval` without cleanup — if the server goes down in the middle, the process does not stop cleanly.

#### [MODIFY] `src/server.ts`
- Add `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)`
- Call `await app.close()` and clear all intervals
- Each worker should return `{ stop: () => void }` instead of void

#### [MODIFY] `src/workers/catalogSync.ts`, `metricsRollup.ts`, `jobs.ts`, `automation.ts`, `retention.ts`
- Each `startXxxWorker()` should return `{ stop(): void }` instead of `void`
- `stop()` should call `clearInterval` on the interval handle

```ts
// Example of the new pattern
export function startRetentionWorker(): { stop(): void } {
  const handle = setInterval(() => tick().catch(() => {}), RETENTION_INTERVAL_MS);
  tick().catch(() => {});
  return { stop: () => clearInterval(handle) };
}
```

#### `server.ts` collects all stop functions:
```ts
const workers = [
  startCatalogSync(),
  startMetricsRollup(),
  startJobsWorker(),
  startAutomationWorker(),
  startRetentionWorker(),
];

const shutdown = async () => {
  workers.forEach(w => w.stop());
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

---

### 7. Database Health Check

**Problem:** The `/api/health` endpoint returns `200` even when the DB connection is dead — the load balancer will not know that the instance is actually dead.

#### [MODIFY] `src/routes/api.ts` (or health route)
- Update the `/api/health` handler:
```ts
app.get('/api/health', async (_req, reply) => {
  try {
    await db.execute(sql`SELECT 1`); // simple DB ping
    return { status: 'ok', db: 'connected', uptime: process.uptime() };
  } catch (err) {
    reply.status(503);
    return { status: 'error', db: 'disconnected' };
  }
});
```
- `503` causes any load balancer/k8s to remove the instance automatically

---

### 8. CORS Configuration

**Problem:** If the widget comes from a different domain, the browser will block the requests.

#### [MODIFY] `src/server.ts`
- Add the `@fastify/cors` plugin with a whitelist:
```ts
await app.register(import('@fastify/cors'), {
  origin: config.ALLOWED_ORIGINS?.split(',') ?? false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Api-Key', 'X-Store-Id'],
});
```

#### [MODIFY] `src/config.ts`
- Add `ALLOWED_ORIGINS: z.string().optional()` — comma-separated list

#### [MODIFY] `.env.example`
```diff
+ # Comma-separated list of allowed origins for CORS (e.g. https://yourstore.com)
+ ALLOWED_ORIGINS=
```

---

### 9. Remove `/test` Route and Secure Dashboard

**Problem:** The `/test` route serves `web/index.html` in production. The dashboard is also not protected by auth.

#### [MODIFY] `src/routes/dashboard.ts`
- Delete the `/test` route completely
- Add `requireApiKey` preHandler to `GET /dashboard`
- Change the path from `process.cwd()` to `import.meta.dirname` (more stable in Docker)

#### Diff
```diff
- app.get('/test', async (_req, reply) => {
-   const html = await readFile(join(process.cwd(), 'web', 'index.html'), 'utf8');
-   return reply.type('text/html').send(html);
- });
```

---

### 6. Make `ENCRYPTION_KEY` Mandatory in Production

**Problem:** `ENCRYPTION_KEY` is optional in the config — if it is missing, `encryptKey()` throws an error at usage time instead of at startup.

#### [MODIFY] `src/config.ts`
- Add validation in `loadConfig()`:
```ts
if (process.env.NODE_ENV === 'production' && !raw.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY is required in production');
}
```
- Add `ADMIN_API_KEY` to the schema and to `.env.example`

#### [MODIFY] `.env.example`
```diff
+ # Required in production (min 32 chars hex). Generate: openssl rand -hex 32
+ ADMIN_API_KEY=
  ENCRYPTION_KEY=
```

---

### 11. Webhook HMAC Signature Verification

**Problem:** `/webhooks/*` is excluded from API key auth, but does it verify the HMAC signature from Shopify/Salla? If not, anyone can send fake webhook events.

#### [MODIFY] `src/lib/auth.ts`
- Add a `verifyWebhookSignature(platform, rawBody, signature)` function:
```ts
export function verifyShopifyWebhook(rawBody: Buffer, hmacHeader: string): boolean {
  const digest = crypto.createHmac('sha256', config.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}
```

#### [MODIFY] `src/routes/webhooks.ts` (or webhook handler)
- Add signature verification at the beginning of every webhook handler before any processing
- Add `SHOPIFY_WEBHOOK_SECRET`, `SALLA_WEBHOOK_SECRET` to the config and `.env.example`

---

### 12. Input Validation Hardening

**Problem:** Do all endpoints use Zod/JSON Schema for request body validation? Without validation, malformed data could reach the DB or LLM.

#### [MODIFY] `src/routes/api.ts`, `analytics.ts`, `automation.ts`
- Review every `POST`/`PUT` endpoint and, for those without a schema, add Fastify JSON Schema validation:
```ts
const schema = {
  body: {
    type: 'object',
    required: ['storeId', 'message'],
    properties: {
      storeId: { type: 'string', minLength: 1 },
      message: { type: 'string', maxLength: 2000 },
    },
    additionalProperties: false,
  },
};
app.post('/api/chat', { schema }, handler);
```
- `additionalProperties: false` is important because it prevents injection via extra fields

---

## Phase Three — P2 (Quality Improvements)

### 7. Multi-turn Conversation History in Chat

**Problem:** `POST /api/chat` calls `answerWithTools` with a single message and no conversation history.

#### [MODIFY] `src/services/agent.ts`
- `answerWithTools` accepts an additional `history: {role, content}[]` parameter
- Add the history before the user message in the input array

#### [MODIFY] `src/routes/api.ts`
- In `POST /api/chat`, get the last N messages from the conversation via `conversationRepo`
- Pass them to `answerWithTools`

```ts
const history = await conversationRepo.getMessages(conversationId, 10); // last 10 messages
const reply = await answerWithTools(body.storeId, body.message, history);
```

---

### 8. Structured Logging

**Problem:** All workers use `console.log/warn/error` instead of Fastify's built-in logger.

**Solution:** Use `pino`, which Fastify includes by default — export it as an independent logger.

#### [NEW] `src/lib/logger.ts`
```ts
import pino from 'pino';
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
```

#### [MODIFY] All workers and services
- Replace `console.log/warn/error` with `logger.info/warn/error`
- Add a context object to each log call (e.g. `{ storeId, jobType }`)

---

### 9. Error Tracking (optional but recommended)

**Solution:** Add the Sentry SDK — minimal integration, just captures unhandled errors.

#### [MODIFY] `src/server.ts`
```ts
import * as Sentry from '@sentry/node';
if (config.SENTRY_DSN) {
  Sentry.init({ dsn: config.SENTRY_DSN, environment: process.env.NODE_ENV });
}
```

#### [MODIFY] `src/config.ts`
- Add `SENTRY_DSN: z.string().url().optional()`

---

## Implementation Order

```mermaid
graph LR
    A[1. API Auth] --> B[2. Shopify Bug]
    B --> C[3. Rate Limiting]
    C --> D[4. HTTPS Check]
    D --> E[5. Pin Versions]
    E --> F[6. Graceful Shutdown]
    F --> G[7. DB Health Check]
    G --> H[8. CORS]
    H --> I[9. Remove /test]
    I --> J[10. Encryption Validation]
    J --> K[11. Webhook HMAC]
    K --> L[12. Input Validation]
    L --> M[13. Chat History]
    M --> N[14. Structured Logging]
    N --> O[15. Error Tracking]
```

---

## Verification Plan

### Automated Tests
```bash
npm test           # runs all unit tests — all should pass
npm run typecheck  # no TypeScript errors
```

### Manual Verification
| Test | Expected |
|---------|---------|
| `GET /api/stores` without API key | `401 Unauthorized` |
| `GET /api/stores` with correct API key | `200` + list |
| `GET /api/health` without API key | `200` (auth not required) |
| `GET /api/health` with dead DB connection | `503 Service Unavailable` |
| `POST /api/chat` more than 5 times in 10 seconds | `429 Too Many Requests` |
| `POST /api/oauth/shopify/callback` for an existing store | updates the token, does not create a duplicate |
| Stop the server with `CTRL+C` | logs "graceful shutdown" and exits cleanly |
| `GET /test` in production | `404` |
| Start the server without `ENCRYPTION_KEY` in production | throws an error immediately |
| Webhook request with an incorrect HMAC signature | `401 Unauthorized` |
| `POST /api/chat` with a `message` longer than 2000 characters | `400 Bad Request` |
| CORS request from an origin not in the whitelist | Browser blocks the request |
