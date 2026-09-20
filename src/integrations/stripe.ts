import { config } from '../config.js';

function stripeApi(): string {
  if (!config.STRIPE_SECRET_KEY) throw Object.assign(new Error('stripe_not_configured'), { statusCode: 503 });
  return config.STRIPE_SECRET_KEY;
}

export type StripeSession = { url: string | null; id: string };

export async function createCheckoutSession(
  storeId: string,
  plan: 'pro' | 'enterprise',
): Promise<StripeSession> {
  const priceId = plan === 'pro' ? config.STRIPE_PRICE_PRO : config.STRIPE_PRICE_ENTERPRISE;
  if (!priceId) throw Object.assign(new Error('stripe_price_not_configured'), { statusCode: 503 });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeApi()}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[store_id]': storeId,
      'metadata[plan]': plan,
      success_url: `${config.APP_BASE_URL}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.APP_BASE_URL}/?billing=cancel`,
    }),
  });
  if (!res.ok) throw new Error(`stripe_create_checkout_failed: ${res.status}`);
  const data: any = await res.json();
  return { url: data.url ?? null, id: data.id };
}

export async function createPortalSession(stripeCustomerId: string): Promise<StripeSession> {
  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${stripeApi()}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: stripeCustomerId,
      return_url: `${config.APP_BASE_URL}/?billing=manage`,
    }),
  });
  if (!res.ok) throw new Error(`stripe_create_portal_failed: ${res.status}`);
  const data: any = await res.json();
  return { url: data.url ?? null, id: data.id };
}