import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Platform } from '../types.js';
import { config } from '../config.js';

const SHOPIFY_HMAC = 'x-shopify-hmac-sha256';
const SHOPIFY_TOPIC = 'x-shopify-topic';
const SHOPIFY_DOMAIN = 'x-shopify-shop-domain';

export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function webhookSecretFor(platform: Platform): string | null {
  switch (platform) {
    case 'shopify':
      return config.SHOPIFY_CLIENT_SECRET ?? null;
    case 'salla':
      return config.SALLA_CLIENT_SECRET ?? null;
    case 'zid':
      return config.ZID_CLIENT_SECRET ?? null;
  }
}

export function verifyHubSignature(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  if (!secret) return false;
  const provided = getHeader(headers, 'x-hub-signature-256');
  if (!provided) return false;
  const digest = createHmac('sha256', secret).update(raw).digest('hex');
  const value = String(provided);
  const expected = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
  return safeEqual(digest, expected);
}

const PLATFORM_HEADERS: Record<Platform, string[]> = {
  shopify: [SHOPIFY_HMAC],
  salla: ['x-salla-signature', 'x-hub-signature-256'],
  zid: ['x-zid-signature', 'x-hub-signature-256'],
};

export function verifyPlatformSignature(
  platform: Platform,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const secret = webhookSecretFor(platform);
  if (!secret) return false;
  for (const name of PLATFORM_HEADERS[platform]) {
    const provided = getHeader(headers, name);
    if (!provided) continue;
    const value = String(provided);
    const expected = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
    // Shopify sends the digest base64-encoded; Salla, Zid and the Meta-style
    // `x-hub-signature-256` header send hex. Comparing a hex digest against Shopify's
    // base64 header can never match, so every Shopify delivery was rejected with a 401
    // and orders only ever arrived via the slow poll. Accept either encoding: it is the
    // same keyed MAC over the same body, so the encoding is not a security boundary.
    const base64 = createHmac('sha256', secret).update(raw).digest('base64');
    const hex = createHmac('sha256', secret).update(raw).digest('hex');
    return safeEqual(base64, expected) || safeEqual(hex, expected);
  }
  return false;
}

export function verifyStripeSignature(
  raw: Buffer,
  header: string,
  secret: string,
  nowMs = Date.now(),
  toleranceMs = 300_000,
): boolean {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const eq = p.indexOf('=');
      return [p.slice(0, eq), p.slice(eq + 1)];
    }),
  );
  const ts = Number(parts.t ?? NaN);
  const v1 = parts.v1 ?? '';
  if (!ts || !v1 || Math.abs(nowMs - ts * 1000) > toleranceMs) return false;
  const signed = `${ts}.${raw.toString('utf8')}`;
  const digest = createHmac('sha256', secret).update(signed).digest('hex');
  return safeEqual(digest, v1);
}

export function verifyWebhook(
  platform: Platform,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return verifyPlatformSignature(platform, raw, headers);
}

export type WebhookEvent = {
  type: string;
  storeRef?: string;
  dedupKey?: string;
  payload: Record<string, unknown>;
};

export function extractEvent(
  platform: Platform,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
): WebhookEvent {
  const payload = (body ?? {}) as Record<string, unknown>;
  if (platform === 'shopify') {
    const type = getHeader(headers, SHOPIFY_TOPIC) ?? 'unknown';
    const storeRef = getHeader(headers, SHOPIFY_DOMAIN);
    const dedupKey =
      typeof payload.id === 'string' || typeof payload.id === 'number'
        ? String(payload.id)
        : createHmac('sha256', webhookSecretFor('shopify') ?? '').update(raw).digest('hex').slice(0, 24);
    return { type, storeRef, dedupKey, payload };
  }
  const p = payload as Record<string, any>;
  const type = p?.topic ?? p?.type ?? p?.event ?? 'unknown';
  const storeRef = p?.store_id ?? p?.storeId ?? p?.merchant_id ?? p?.store?.id;
  const dedupKey = p?.id ?? p?.order_id ?? p?.product_id;
  return {
    type: String(type),
    storeRef: storeRef != null ? String(storeRef) : undefined,
    dedupKey: dedupKey != null ? String(dedupKey) : undefined,
    payload,
  };
}