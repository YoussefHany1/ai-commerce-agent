import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  OAUTH_REDIRECT_ALLOWLIST: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  // Supabase Auth + Postgres. Every human credential in this system now belongs to
  // Supabase — there is no password here to compare — so these are required in
  // production: the anon key verifies sign-ins, the service role key resolves
  // OAuth tokens and manages identities. Optional only to keep an all-local,
  // no-login setup bootable for tests and scripts.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  ADMIN_API_KEY: z.string().min(32).optional(),
  ADMIN_API_KEY_PREVIOUS: z.string().min(32).optional(),
  SENTRY_DSN: z.string().optional(),
  TRUST_PROXY: z.enum(["1", "0", "true", "false", "none"]).default("false"),
  DATABASE_URL: z
    .string()
    .default("postgres://postgres:postgres@localhost:5432/ai_commerce_agent"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL: z.string().default("openai/gpt-4o-mini"),
  OPENROUTER_EMBEDDING_MODEL: z
    .string()
    .default("openai/text-embedding-3-small"),
  SHOPIFY_API_VERSION: z.string().default("2026-07"),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SALLA_CLIENT_ID: z.string().optional(),
  SALLA_CLIENT_SECRET: z.string().optional(),
  ZID_CLIENT_ID: z.string().optional(),
  ZID_CLIENT_SECRET: z.string().optional(),
  SALLA_SCOPES: z.string().optional(),
  ZID_SCOPES: z.string().optional(),
  ENCRYPTION_KEY_VERSION: z.string().default("v1"),
  RETRIEVAL_MODE: z.enum(["fts", "vector", "hybrid"]).default("hybrid"),
  RETRIEVAL_RE_RANK: z.enum(["off", "synonym", "embedding"]).default("synonym"),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default("v21.0"),
  // WhatsApp Web QR pairing runs a persistent Baileys socket per paired number.
  // Off by default: it costs ~100-200 MB of RSS per session and holds an unofficial
  // Meta protocol connection open, so it is opt-in per deployment rather than
  // something every install pays for. See whatsapp_qr_plan.md §1.1.
  WHATSAPP_BAILEYS_ENABLED: z.enum(["1", "0", "true", "false"]).default("1"),
  // One number per deployment. A product limit as much as a memory one: the free
  // tier cannot hold two sockets in 512 MB, and the paid tier still ships with one
  // number per merchant. Raise deliberately, one socket per increment.
  WHATSAPP_BAILEYS_MAX_SESSIONS: z.coerce.number().int().positive().default(1),
  // Bumping this re-prompts every merchant to re-acknowledge the unofficial-protocol
  // warning, because acknowledgement is recorded per version and not as a bare boolean.
  WHATSAPP_BAILEYS_TOS_VERSION: z.string().default("2026-01"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(20),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  CLIENT_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 60 * 60),
  // Operator sessions are longer-lived than the legacy shared password ever implied:
  // each one now belongs to a person, who is expected to use Google so there is no
  // password to type, and who should not be signed out mid-task.
  OPERATOR_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 60 * 60),
  WEBHOOK_BODY_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  RETENTION_CONVERSATIONS_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_ATTRIBUTIONS_DAYS: z.coerce.number().int().positive().default(365),
  RETENTION_EVENTS_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_CUSTOMER_ORPHAN_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(730),
  RETENTION_ENABLED: z.enum(["1", "0", "true", "false"]).default("true"),
  WORKERS_ENABLED: z.enum(["1", "0", "true", "false"]).default("true"),
});

// aes-256-gcm needs exactly 32 bytes. Buffer.from(key, 'hex') silently drops
// non-hex characters rather than erroring, so a malformed key produces a
// wrong-length buffer and only fails later, at the first encryptKey(), as an
// opaque "Invalid key length" from createCipheriv.
const ENCRYPTION_KEY_HEX = /^[0-9a-f]{64}$/i;

function collectKeys(raw: NodeJS.ProcessEnv): Record<string, string> {
  const keys: Record<string, string> = {};
  if (raw.ENCRYPTION_KEY)
    keys[raw.ENCRYPTION_KEY_VERSION ?? "v1"] = raw.ENCRYPTION_KEY;
  for (const [k, v] of Object.entries(raw)) {
    const m = /^ENCRYPTION_KEY_(?!VERSION$)([a-z0-9]+)$/i.exec(k);
    if (m && v) keys[m[1].toLowerCase()] = v;
  }
  return keys;
}

function assertKeyShape(keys: Record<string, string>): void {
  for (const [version, key] of Object.entries(keys)) {
    if (ENCRYPTION_KEY_HEX.test(key)) continue;
    throw new Error(
      `ENCRYPTION_KEY (version ${version}) must be 64 hex characters (32 bytes) — generate one ` +
        `with \`openssl rand -hex 32\`. Hosting platforms that auto-generate secrets produce ` +
        `alphanumeric strings, not hex, and the mismatch would otherwise only surface on the ` +
        `first token write.`,
    );
  }
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(raw);
  const keys = collectKeys(raw);
  const activeVersion = raw.ENCRYPTION_KEY_VERSION ?? "v1";
  const isProd = raw.NODE_ENV === "production";
  if (isProd && !raw.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY is required in production");
  }
  // The default is a superuser connection, which is both the table owner and a
  // BYPASSRLS role, so it ignores every tenant policy while looking perfectly
  // healthy. Failing at boot is the only place this can still be caught.
  if (isProd && !raw.DATABASE_URL?.trim()) {
    throw new Error(
      "DATABASE_URL is required in production — point it at the RLS-restricted runtime role, not the " +
        "owner/superuser connection (see the DATABASE_URL and PGADMIN_URL notes in DEPLOYMENT.md)",
    );
  }
  assertKeyShape(keys);
  if (isProd && !parsed.ADMIN_API_KEY) {
    throw new Error(
      "ADMIN_API_KEY is required in production — set a key of at least 32 characters",
    );
  }
  if (
    isProd &&
    !(
      raw.SUPABASE_URL &&
      raw.SUPABASE_ANON_KEY &&
      raw.SUPABASE_SERVICE_ROLE_KEY
    )
  ) {
    throw new Error(
      "SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are all required in production — " +
        "operator and client credentials are verified by Supabase, so without them nobody can sign in",
    );
  }
  if (isProd) {
    const tp = (raw.TRUST_PROXY ?? "").toLowerCase();
    if (tp !== "1" && tp !== "true" && tp !== "none") {
      throw new Error(
        'TRUST_PROXY must be set explicitly in production: "1"/"true" when TLS terminates upstream ' +
          '(the edge must overwrite X-Forwarded-For), or "none" when the app is directly internet-exposed. ' +
          "Unset makes per-IP rate limits key off the wrong address.",
      );
    }
  }
  return {
    ...parsed,
    retentionEnabled:
      parsed.RETENTION_ENABLED === "1" || parsed.RETENTION_ENABLED === "true",
    workersEnabled:
      parsed.WORKERS_ENABLED === "1" || parsed.WORKERS_ENABLED === "true",
    whatsappBaileysEnabled:
      parsed.WHATSAPP_BAILEYS_ENABLED === "1" ||
      parsed.WHATSAPP_BAILEYS_ENABLED === "true",
    trustProxy: parsed.TRUST_PROXY === "1" || parsed.TRUST_PROXY === "true",
    encryption: {
      version: activeVersion,
      keys,
    },
  };
}

export const config = loadConfig();

export type Config = ReturnType<typeof loadConfig>;
