import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { storeRateLimitWindow, reqIp } from '../lib/rateLimit.js';
import { storeRepo, connectionRepo } from '../db/repos.js';

const STATE_TTL = 600;
const oauthWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
const SCOPES = ['read_products', 'write_products', 'read_orders', 'read_inventory'];
const SALLA_SCOPES_DEFAULT = 'offline_access';
const ZID_SCOPES_DEFAULT = '';

function normalizeShop(input: string): string {
  return input.replace(/^https?:\/\//, '').split('/')[0].trim();
}

function allowedRedirectOrigins(): string[] {
  const list = [config.APP_BASE_URL];
  for (const o of (config.OAUTH_REDIRECT_ALLOWLIST ?? '').split(',')) {
    const t = o.trim();
    if (t && !list.includes(t)) list.push(t);
  }
  return list;
}

function sanitizeRedirect(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!allowedRedirectOrigins().includes(u.origin)) return null;
  return u.toString();
}

const STATE_IP_CAP = 100;
async function capStateCreation(ip: string): Promise<boolean> {
  try {
    const redis = await getRedis();
    const key = `oauth:state:ip:${ip}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, 600);
    if (used > STATE_IP_CAP) return false;
  } catch {
    // best-effort; never fail the install flow on a Redis blip
  }
  return true;
}

function verifyShopifyHmac(url: string, secret: string): boolean {
  const u = new URL(url, config.APP_BASE_URL);
  const provided = u.searchParams.get('hmac');
  if (!provided) return false;
  const pairs = [...u.searchParams.entries()].filter(([k]) => k !== 'hmac');
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const digest = createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

type OAuthState = { platform: string; ref?: string; redirectAfter?: string | null };

async function saveInstall(input: {
  platform: 'shopify' | 'salla' | 'zid';
  name: string;
  shopDomain?: string | null;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const existing = input.shopDomain ? await storeRepo.byRef(input.shopDomain, input.platform) : null;
  let storeId: string;
  if (existing) {
    storeId = existing.id;
    await connectionRepo.setTokens(storeId, {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      scopes: input.scopes,
    });
  } else {
    storeId = await storeRepo.create({
      name: input.name,
      platform: input.platform,
      shopDomain: input.shopDomain,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      scopes: input.scopes,
    });
  }
  if (input.metadata) await storeRepo.updateSettings(storeId, input.metadata);
  return storeId;
}

function parseExpiry(payload: { expires_in?: number; expires?: string | number }): Date | undefined {
  if (payload.expires_in) return new Date(Date.now() + payload.expires_in * 1000);
  if (typeof payload.expires === 'number' && payload.expires > 1_000_000_000) return new Date(payload.expires * 1000);
  return undefined;
}

export async function oauth(app: FastifyInstance) {
  app.get('/api/oauth/shopify/start', async (req, rep) => {
    const { shop, redirectAfter: rawRedirectAfter } = z
      .object({ shop: z.string().min(1), redirectAfter: z.string().optional() })
      .parse(req.query);
    if (!config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET) {
      return rep.code(503).send({ error: 'shopify_oauth_not_configured' });
    }
    const redirectAfter = sanitizeRedirect(rawRedirectAfter);
    if (rawRedirectAfter && !redirectAfter) return rep.code(400).send({ error: 'invalid_redirect_after' });
    if (!(await capStateCreation(reqIp(req)))) return rep.code(429).send({ error: 'rate_limit_exceeded' });
    const clean = normalizeShop(shop);
    const state = randomBytes(24).toString('base64url');
    const redis = await getRedis();
    await redis.set(`oauth:state:${state}`, JSON.stringify({ platform: 'shopify', shop: clean, redirectAfter }), {
      EX: STATE_TTL,
    });
    const url =
      `https://${clean}/admin/oauth/authorize?client_id=${encodeURIComponent(config.SHOPIFY_CLIENT_ID)}` +
      `&scope=${encodeURIComponent(SCOPES.join(','))}` +
      `&state=${state}` +
      `&redirect_uri=${encodeURIComponent(`${config.APP_BASE_URL}/api/oauth/shopify/callback`)}`;
    return rep.redirect(url);
  });

  app.get('/api/oauth/shopify/callback', { preHandler: [storeRateLimitWindow('api', oauthWindow)] }, async (req, rep) => {
    const q = req.query as Record<string, string>;
    const { code, state, shop, hmac } = q;
    if (!code || !state || !shop || !hmac) return rep.code(400).send({ error: 'missing_oauth_params' });
    if (!config.SHOPIFY_CLIENT_SECRET || !config.SHOPIFY_CLIENT_ID) {
      return rep.code(503).send({ error: 'shopify_oauth_not_configured' });
    }
    if (!verifyShopifyHmac(req.raw.url ?? req.url, config.SHOPIFY_CLIENT_SECRET)) {
      return rep.code(401).send({ error: 'invalid_hmac' });
    }
    const redis = await getRedis();
    const storedRaw = await redis.get(`oauth:state:${state}`);
    if (!storedRaw) return rep.code(401).send({ error: 'invalid_state' });
    await redis.del(`oauth:state:${state}`);
    const stored = JSON.parse(storedRaw) as OAuthState & { shop: string };
    if (stored.shop !== normalizeShop(shop)) return rep.code(401).send({ error: 'state_shop_mismatch' });

    const tokenRes = await fetch(`https://${stored.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.SHOPIFY_CLIENT_ID,
        client_secret: config.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    if (!tokenRes.ok) return rep.code(502).send({ error: 'token_exchange_failed' });
    const token = (await tokenRes.json()) as { access_token: string; scope?: string };
    const id = await saveInstall({
      platform: 'shopify',
      name: stored.shop,
      shopDomain: stored.shop,
      accessToken: token.access_token,
      scopes: token.scope ? token.scope.split(',') : SCOPES,
    });
    const after = sanitizeRedirect(stored.redirectAfter ?? undefined);
    if (after) return rep.redirect(after);
    return { ok: true, storeId: id };
  });

  app.get('/api/oauth/salla/start', async (req, rep) => {
    const { redirectAfter: rawRedirectAfter } = z.object({ redirectAfter: z.string().optional() }).parse(req.query);
    if (!config.SALLA_CLIENT_ID || !config.SALLA_CLIENT_SECRET) {
      return rep.code(503).send({ error: 'salla_oauth_not_configured' });
    }
    const redirectAfter = sanitizeRedirect(rawRedirectAfter);
    if (rawRedirectAfter && !redirectAfter) return rep.code(400).send({ error: 'invalid_redirect_after' });
    if (!(await capStateCreation(reqIp(req)))) return rep.code(429).send({ error: 'rate_limit_exceeded' });
    const state = randomBytes(24).toString('base64url');
    const redis = await getRedis();
    await redis.set(`oauth:state:${state}`, JSON.stringify({ platform: 'salla', redirectAfter } satisfies OAuthState), {
      EX: STATE_TTL,
    });
    const scopes = config.SALLA_SCOPES ?? SALLA_SCOPES_DEFAULT;
    const url =
      `https://accounts.salla.sa/oauth2/auth?client_id=${encodeURIComponent(config.SALLA_CLIENT_ID)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&state=${state}` +
      `&redirect_uri=${encodeURIComponent(`${config.APP_BASE_URL}/api/oauth/salla/callback`)}`;
    return rep.redirect(url);
  });

  app.get('/api/oauth/salla/callback', { preHandler: [storeRateLimitWindow('api', oauthWindow)] }, async (req, rep) => {
    const q = req.query as Record<string, string>;
    const { code, state } = q;
    if (!code || !state) return rep.code(400).send({ error: 'missing_oauth_params' });
    if (!config.SALLA_CLIENT_ID || !config.SALLA_CLIENT_SECRET) {
      return rep.code(503).send({ error: 'salla_oauth_not_configured' });
    }
    const redis = await getRedis();
    const storedRaw = await redis.get(`oauth:state:${state}`);
    if (!storedRaw) return rep.code(401).send({ error: 'invalid_state' });
    await redis.del(`oauth:state:${state}`);
    const stored = JSON.parse(storedRaw) as OAuthState;
    if (stored.platform !== 'salla') return rep.code(401).send({ error: 'state_platform_mismatch' });

    const tokenRes = await fetch('https://accounts.salla.sa/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.SALLA_CLIENT_ID,
        client_secret: config.SALLA_CLIENT_SECRET,
        redirect_uri: `${config.APP_BASE_URL}/api/oauth/salla/callback`,
      }),
    });
    if (!tokenRes.ok) return rep.code(502).send({ error: 'token_exchange_failed' });
    const token = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
      expires?: string | number;
    };
    if (!token.access_token) return rep.code(502).send({ error: 'token_exchange_failed' });

    let name = 'Salla store';
    let shopDomain: string | undefined;
    try {
      const infoRes = await fetch('https://accounts.salla.sa/oauth2/user/info', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const info = (await infoRes.json()) as {
        merchant?: { name?: string; domain?: string; username?: string };
      };
      if (info.merchant?.name) name = info.merchant.name;
      if (info.merchant?.domain) shopDomain = normalizeShop(info.merchant.domain);
      else if (info.merchant?.username) shopDomain = `salla-${info.merchant.username.toLowerCase()}`;
    } catch {
      // merchant profile is best-effort; store still installs
    }

    const id = await saveInstall({
      platform: 'salla',
      name,
      shopDomain,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: parseExpiry(token),
      scopes: (config.SALLA_SCOPES ?? SALLA_SCOPES_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean),
    });
    const after = sanitizeRedirect(stored.redirectAfter ?? undefined);
    if (after) return rep.redirect(after);
    return { ok: true, storeId: id };
  });

  app.get('/api/oauth/zid/start', async (req, rep) => {
    const { redirectAfter: rawRedirectAfter } = z.object({ redirectAfter: z.string().optional() }).parse(req.query);
    if (!config.ZID_CLIENT_ID || !config.ZID_CLIENT_SECRET) {
      return rep.code(503).send({ error: 'zid_oauth_not_configured' });
    }
    const redirectAfter = sanitizeRedirect(rawRedirectAfter);
    if (rawRedirectAfter && !redirectAfter) return rep.code(400).send({ error: 'invalid_redirect_after' });
    if (!(await capStateCreation(reqIp(req)))) return rep.code(429).send({ error: 'rate_limit_exceeded' });
    const state = randomBytes(24).toString('base64url');
    const redis = await getRedis();
    await redis.set(`oauth:state:${state}`, JSON.stringify({ platform: 'zid', redirectAfter } satisfies OAuthState), {
      EX: STATE_TTL,
    });
    const scopes = config.ZID_SCOPES ?? ZID_SCOPES_DEFAULT;
    const url =
      `https://oauth.zid.sa/oauth/authorize?client_id=${encodeURIComponent(config.ZID_CLIENT_ID)}` +
      `&response_type=code` +
      (scopes ? `&scope=${encodeURIComponent(scopes)}` : '') +
      `&state=${state}` +
      `&redirect_uri=${encodeURIComponent(`${config.APP_BASE_URL}/api/oauth/zid/callback`)}`;
    return rep.redirect(url);
  });

  app.get('/api/oauth/zid/callback', { preHandler: [storeRateLimitWindow('api', oauthWindow)] }, async (req, rep) => {
    const q = req.query as Record<string, string>;
    const { code, state } = q;
    if (!code || !state) return rep.code(400).send({ error: 'missing_oauth_params' });
    if (!config.ZID_CLIENT_ID || !config.ZID_CLIENT_SECRET) {
      return rep.code(503).send({ error: 'zid_oauth_not_configured' });
    }
    const redis = await getRedis();
    const storedRaw = await redis.get(`oauth:state:${state}`);
    if (!storedRaw) return rep.code(401).send({ error: 'invalid_state' });
    await redis.del(`oauth:state:${state}`);
    const stored = JSON.parse(storedRaw) as OAuthState;
    if (stored.platform !== 'zid') return rep.code(401).send({ error: 'state_platform_mismatch' });

    const tokenRes = await fetch('https://oauth.zid.sa/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: config.ZID_CLIENT_ID,
        client_secret: config.ZID_CLIENT_SECRET,
        redirect_uri: `${config.APP_BASE_URL}/api/oauth/zid/callback`,
      }),
    });
    if (!tokenRes.ok) return rep.code(502).send({ error: 'token_exchange_failed' });
    const token = (await tokenRes.json()) as {
      access_token?: string;
      authorization?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!token.access_token || !token.authorization) return rep.code(502).send({ error: 'token_exchange_failed' });

    let name = 'Zid store';
    let shopDomain = `zid-${randomBytes(6).toString('hex')}`;
    try {
      const profileRes = await fetch('https://api.zid.sa/v1/managers/account/profile', {
        headers: {
          Authorization: `Bearer ${token.authorization}`,
          'X-Manager-Token': token.access_token,
          'Accept-Language': 'ar',
        },
      });
      if (profileRes.ok) {
        const body = (await profileRes.json()) as { result?: { name?: string; id?: number } };
        const profile = (body.result ?? body) as { name?: string; id?: number };
        if (profile?.name) name = profile.name;
        if (profile?.id) shopDomain = `zid-${profile.id}`;
      }
    } catch {
      // profile is best-effort
    }

    const id = await saveInstall({
      platform: 'zid',
      name,
      shopDomain,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: parseExpiry(token),
      scopes: (config.ZID_SCOPES ?? ZID_SCOPES_DEFAULT).split(',').map((s) => s.trim()).filter(Boolean),
    });
    await storeRepo.updateSettingsEncrypted(id, 'zidAuthorization', token.authorization);
    const after = sanitizeRedirect(stored.redirectAfter ?? undefined);
    if (after) return rep.redirect(after);
    return { ok: true, storeId: id };
  });
}