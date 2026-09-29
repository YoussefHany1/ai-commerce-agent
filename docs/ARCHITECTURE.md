# AI Commerce Agent — Architecture

## Product
A multi-tenant AI sales layer for ecommerce stores. The commerce platform remains the system of record. This service indexes product/order data, answers customer questions, recommends products, and triggers follow-up workflows.

## Core modules
- Tenant/store management
- Platform adapters: Shopify, Salla, Zid
- Product sync + normalized catalog
- Order lookup
- AI sales agent with catalog grounding
- Conversation history (production: PostgreSQL)
- Webhook ingestion
- Follow-up workflow engine
- Analytics: conversations → product clicks → checkout/order attribution

## Production data model
`clients`, `stores`, `platform_connections`, `products`, `variants`, `customers`, `orders`, `conversations`, `messages`, `events`, `automation_rules`, `jobs`, `attributions`.

## Security
Never expose platform tokens to the browser. Encrypt tokens at rest. Verify webhook signatures/authentication for each provider. Request minimum scopes. Log access and errors without customer secrets.

## Data handling (PDPL)
Target stores (Salla/Zid) are subject to the Saudi Personal Data Protection Law, which applies to customer PII stored in `customers`, `orders`, and `messages`.
- **Purpose limitation**: collect only what the sales agent needs (name/phone/email/order context); do not harvest fields for unrelated analytics.
- **Retention**: conversations and customer records must have defined retention windows; add a purge job before customer-facing analytics are launched.
- **Access & deletion**: support "access my data" and "delete my data" flows per customer once conversations are production-persisted.
- **Encryption at rest**: platform access/refresh tokens are encrypted; conversation message bodies are encrypted; avoid logging customer secrets.

## MVP behavior
1. Merchant connects a store.
2. Initial catalog sync.
3. Webhooks keep catalog/orders current.
4. Customer message enters the agent.
5. Agent retrieves relevant products/order context.
6. LLM answers only from retrieved data.
7. Product links are returned.
8. Conversation and attribution are persisted.

## Current implementation
The API (Fastify) ships a working multi-store server with real Shopify, Salla, and Zid adapters: product/order sync + order backfill, OAuth install flows for all three platforms, signed webhook ingestion, catalog-grounded AI sales replies, WhatsApp messaging, Stripe billing, attribution analytics, an automation engine, and PDPL retention/access/erasure. Production hardening covers RLS tenant isolation (health-gated), AES-256-GCM token + PII encryption with key rotation, per-tenant rate limiting, and operator session revocation. The operator surface is the separate `web/` Next.js dashboard served by its own authenticated proxy — the admin key never reaches a browser. Client (merchant) credentials have moved to Supabase Auth in a staged migration: the identity layer is Supabase (`clients.supabase_uid`), the tenancy RLS is expressed on `request.jwt.claims` (with a `public.auth_jwt()` shim so the same policies run on plain Postgres), and only pre-import accounts still verify the legacy scrypt hash. Salla/Zid webhook payloads are mapped through the same mappers the sync/backfill paths use; exact wrapper keys for every live event type still need confirmation from a production store.

Merchant **client accounts** (invite-only, one-to-many stores) unlock a second role in the same dashboard. Client sessions are Redis sids bound to a per-account epoch; every guarded API call re-resolves the session and the owning store, so a client can only ever reach its own data and a suspension takes effect instantly. `requireDashboard` grants tenant routes to the operator admin key or a client session, with the client session taking precedence (least privilege).
