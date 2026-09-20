import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  OAUTH_REDIRECT_ALLOWLIST: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  ADMIN_API_KEY: z.string().min(32).optional(),
  TRUST_PROXY: z.enum(['1', '0', 'true', 'false']).default('false'),
  DATABASE_URL: z
    .string()
    .default('postgres://postgres:postgres@localhost:5432/ai_commerce_agent'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('openai/gpt-4o-mini'),
  OPENROUTER_EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),
  SHOPIFY_API_VERSION: z.string().default('2026-07'),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SALLA_CLIENT_ID: z.string().optional(),
  SALLA_CLIENT_SECRET: z.string().optional(),
  ZID_CLIENT_ID: z.string().optional(),
  ZID_CLIENT_SECRET: z.string().optional(),
  SALLA_SCOPES: z.string().optional(),
  ZID_SCOPES: z.string().optional(),
  ENCRYPTION_KEY_VERSION: z.string().default('v1'),
  RETRIEVAL_MODE: z.enum(['fts', 'vector', 'hybrid']).default('hybrid'),
  RETRIEVAL_RE_RANK: z.enum(['off', 'synonym', 'embedding']).default('synonym'),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(20),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  RETENTION_CONVERSATIONS_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_ATTRIBUTIONS_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_EVENTS_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_CUSTOMER_ORPHAN_DAYS: z.coerce.number().int().positive().default(730),
  RETENTION_ENABLED: z.enum(['1', '0', 'true', 'false']).default('true'),
});

function collectKeys(raw: NodeJS.ProcessEnv): Record<string, string> {
  const keys: Record<string, string> = {};
  if (raw.ENCRYPTION_KEY) keys[raw.ENCRYPTION_KEY_VERSION ?? 'v1'] = raw.ENCRYPTION_KEY;
  for (const [k, v] of Object.entries(raw)) {
    const m = /^ENCRYPTION_KEY_(?!VERSION$)([a-z0-9]+)$/i.exec(k);
    if (m && v) keys[m[1].toLowerCase()] = v;
  }
  return keys;
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(raw);
  const keys = collectKeys(raw);
  const activeVersion = raw.ENCRYPTION_KEY_VERSION ?? 'v1';
  const isProd = raw.NODE_ENV === 'production';
  if (isProd && !raw.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is required in production');
  }
  if (isProd && !parsed.ADMIN_API_KEY) {
    throw new Error('ADMIN_API_KEY is required in production — set a key of at least 32 characters');
  }
  if (isProd && !(raw.TRUST_PROXY === '1' || raw.TRUST_PROXY?.toLowerCase() === 'true')) {
    console.warn('TRUST_PROXY not set — ensure HTTPS is terminated upstream (Nginx/Caddy/Load Balancer)');
  }
  return {
    ...parsed,
    retentionEnabled: parsed.RETENTION_ENABLED === '1' || parsed.RETENTION_ENABLED === 'true',
    trustProxy: parsed.TRUST_PROXY === '1' || parsed.TRUST_PROXY === 'true',
    encryption: {
      version: activeVersion,
      keys,
    },
  };
}

export const config = loadConfig();

export type Config = ReturnType<typeof loadConfig>;