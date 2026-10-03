import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'webhook-secret-123';

function hmac(raw: string): string {
  return createHmac('sha256', SECRET).update(raw).digest('hex');
}

/** Shopify's `X-Shopify-Hmac-Sha256` is base64, not hex. */
function hmacB64(raw: string): string {
  return createHmac('sha256', SECRET).update(raw).digest('base64');
}

async function loadWebhooks(env: Record<string, string>) {
  vi.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, { SHOPIFY_CLIENT_SECRET: SECRET, ...env });
  try {
    return await import('./webhooks.js');
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe('verifyWebhook', () => {
  afterEach(() => vi.resetModules());

  it('accepts a valid base64 Shopify HMAC signature', async () => {
    const { verifyWebhook } = await loadWebhooks({});
    const raw = Buffer.from('{"id":1}');
    const ok = verifyWebhook('shopify', raw, { 'x-shopify-hmac-sha256': hmacB64('{"id":1}') });
    expect(ok).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const { verifyWebhook } = await loadWebhooks({});
    const ok = verifyWebhook('shopify', Buffer.from('{"id":2}'), {
      'x-shopify-hmac-sha256': hmacB64('{"id":1}'),
    });
    expect(ok).toBe(false);
  });

  it('accepts the native plain-hex salla signature header', async () => {
    const { verifyWebhook } = await loadWebhooks({ SALLA_CLIENT_SECRET: SECRET });
    const raw = Buffer.from('{"topic":"product.created"}');
    expect(verifyWebhook('salla', raw, { 'x-salla-signature': hmac('{"topic":"product.created"}') })).toBe(true);
    expect(verifyWebhook('salla', raw, { 'x-salla-signature': hmac('{"topic":"order.created"}') })).toBe(false);
  });

  it('accepts the native plain-hex zid signature header', async () => {
    const { verifyWebhook } = await loadWebhooks({ ZID_CLIENT_SECRET: SECRET });
    const raw = Buffer.from('{"event":"order.created"}');
    expect(verifyWebhook('zid', raw, { 'x-zid-signature': hmac(`{"event":"order.created"}`) })).toBe(true);
    expect(verifyWebhook('zid', raw, { 'x-zid-signature': hmac('{"event":"order.cancelled"}') })).toBe(false);
  });

  it('accepts an x-hub-signature-256 (sha256=) for other platforms', async () => {
    const { verifyWebhook } = await loadWebhooks({ ZID_CLIENT_SECRET: SECRET });
    const val = `sha256=${hmac('{}')}`;
    expect(verifyWebhook('zid', Buffer.from('{}'), { 'x-hub-signature-256': val })).toBe(true);
    expect(verifyWebhook('zid', Buffer.from('{'), { 'x-hub-signature-256': val })).toBe(false);
  });

  it('fails closed when the webhook secret is not configured', async () => {
    const { verifyWebhook } = await loadWebhooks({ SHOPIFY_CLIENT_SECRET: '' });
    expect(verifyWebhook('shopify', Buffer.from('{}'), { 'x-shopify-hmac-sha256': hmac('{}') })).toBe(false);
  });
});

describe('verifyHubSignature', () => {
  it('accepts a valid sha256= signature and rejects tampering', async () => {
    const { verifyHubSignature } = await loadWebhooks({});
    const val = `sha256=${hmac('{}')}`;
    expect(verifyHubSignature(Buffer.from('{}'), { 'x-hub-signature-256': val }, SECRET)).toBe(true);
    expect(verifyHubSignature(Buffer.from('{]'), { 'x-hub-signature-256': val }, SECRET)).toBe(false);
  });

  it('rejects when the secret is missing or the header is absent', async () => {
    const { verifyHubSignature } = await loadWebhooks({});
    expect(verifyHubSignature(Buffer.from('{}'), { 'x-hub-signature-256': `sha256=${hmac('{}')}` }, '')).toBe(false);
    expect(verifyHubSignature(Buffer.from('{}'), {}, SECRET)).toBe(false);
  });
});

describe('verifyStripeSignature', () => {
  function stripeHeader(raw: string, at: number): string {
    const sig = createHmac('sha256', STRIPE_SECRET)
      .update(`${at}.${raw}`)
      .digest('hex');
    return `t=${at},v1=${sig}`;
  }

  const STRIPE_SECRET = 'whsec_test_456';
  const NOW = 1_700_000_000_000;

  it('accepts a valid t,v1 signature inside the tolerance window', async () => {
    const { verifyStripeSignature } = await loadWebhooks({});
    const raw = Buffer.from('{"type":"checkout.session.completed"}');
    expect(verifyStripeSignature(raw, stripeHeader(raw.toString(), NOW / 1000), STRIPE_SECRET, NOW)).toBe(true);
  });

  it('rejects a tampered body (recomputed over the original raw bytes)', async () => {
    const { verifyStripeSignature } = await loadWebhooks({});
    const raw = Buffer.from('{"type":"checkout.session.completed"}');
    const header = stripeHeader(raw.toString(), NOW / 1000);
    expect(verifyStripeSignature(Buffer.from('{"type":"checkout.session.cancelled"}'), header, STRIPE_SECRET, NOW)).toBe(false);
  });

  it('rejects a signature older than the tolerance window', async () => {
    const { verifyStripeSignature } = await loadWebhooks({});
    const raw = Buffer.from('{}');
    expect(verifyStripeSignature(raw, stripeHeader('{}', (NOW - 600_000) / 1000), STRIPE_SECRET, NOW)).toBe(false);
  });

  it('rejects when the secret or header is missing', async () => {
    const { verifyStripeSignature } = await loadWebhooks({});
    const raw = Buffer.from('{}');
    expect(verifyStripeSignature(raw, stripeHeader('{}', NOW / 1000), '', NOW)).toBe(false);
    expect(verifyStripeSignature(raw, '', STRIPE_SECRET, NOW)).toBe(false);
  });
});

describe('extractEvent', () => {
  it('reads topic, shop domain and product id from Shopify headers+body', async () => {
    const { extractEvent } = await loadWebhooks({});
    const body = { id: 'gid://shopify/Product/99', title: 'Cap' };
    const event = extractEvent('shopify', Buffer.from('{}'), {
      'x-shopify-topic': 'products/create',
      'x-shopify-shop-domain': 'demo.myshopify.com',
    }, body);
    expect(event).toMatchObject({ type: 'products/create', storeRef: 'demo.myshopify.com', dedupKey: 'gid://shopify/Product/99' });
  });

  it('reads store_id/id from salla/zid payloads', async () => {
    const { extractEvent } = await loadWebhooks({});
    const event = extractEvent('salla', Buffer.from('{}'), {}, {
      topic: 'order.created', store_id: 'store-9', order_id: 'o-1',
    });
    expect(event).toMatchObject({ type: 'order.created', storeRef: 'store-9', dedupKey: 'o-1' });
  });
});