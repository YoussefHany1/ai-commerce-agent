# AI Commerce Agent — Dashboard (Next.js 14)

Premium SaaS dashboard for the AI Commerce Agent backend (Fastify API in the repo root).

## Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS v3 (custom theme, dark/light mode, RTL support)
- `@tanstack/react-query` (server state + cache)
- `recharts` (charts) + `framer-motion` (animations)
- `lucide-react`, `clsx` + `tailwind-merge`, `date-fns`, `sonner`

## Getting started

```bash
npm install
npm run dev        # http://localhost:3001
```

By default the app calls the API at `http://localhost:3000` (the Fastify backend).
If you run the backend on another origin, set it in `web/.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3000
```

When `NEXT_PUBLIC_API_URL` is set, Next.js also proxies `/api/*` to that origin, so
the dashboard works same-origin in dev and build. Otherwise the backend must allow
the dashboard origin via `CORS_ORIGINS` (e.g. `*`) in its `.env`.

## Pages

| Route                      | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `/dashboard`               | KPI cards, revenue/conversations/funnel charts, quick chat |
| `/dashboard/analytics`     | Attribution table, top products, sources funnel, lag chart |
| `/dashboard/stores`        | Store cards, add-store modal + Shopify OAuth, disconnect   |
| `/dashboard/automation`    | Automation rules, toggle, create drawer, delete dialog     |
| `/dashboard/billing`       | Plan cards, Stripe checkout/portal, trial status           |
| `/dashboard/settings`      | WhatsApp channel config, live health, danger zone          |

## Env vars

| Var                       | Default               | Notes                                          |
| ------------------------- | --------------------- | ---------------------------------------------- |
| `NEXT_PUBLIC_API_URL`     | `http://localhost:3000` | Backend base URL; also used for the `/api/*` proxy |

## Notes

- `DELETE /api/stores/:id` is used by Stores/Settings for disconnecting stores —
  add it to the backend route list for full end-to-end disconnect support.
- Metrics/analytics endpoints are billed as `402 payment_required` when a store is
  not on `trial`/`active`; the UI reacts with a blurred "Upgrade to Pro" gate.