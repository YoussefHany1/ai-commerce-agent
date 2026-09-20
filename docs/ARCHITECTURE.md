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
`stores`, `platform_connections`, `products`, `variants`, `customers`, `orders`, `conversations`, `messages`, `events`, `automation_rules`, `jobs`, `attributions`.

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
The included server has a working API, Shopify GraphQL adapter, mock adapters for Salla/Zid, webhook endpoints, and a small Arabic admin/test UI. Salla and Zid adapters are deliberately isolated because their production OAuth/scopes/endpoints and merchant-app approval must be configured with each platform's current partner credentials.
