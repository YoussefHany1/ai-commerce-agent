import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { billingRepo, storeRepo } from '../db/repos.js';
import { verifyStripeSignature } from '../lib/webhooks.js';
import { createCheckoutSession, createPortalSession } from '../integrations/stripe.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireDashboard } from '../lib/auth.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
const bodyStoreIdRef = (req: any) => (req.body as { storeId?: string })?.storeId;
const paramStoreIdRef = (req: any) => ((req as any).params as { storeId?: string })?.storeId;

function mapStoresStatus(subStatus: string): string {
  switch (subStatus) {
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    case 'canceled':
    case 'incomplete_expired':
      return 'expired';
    default:
      return subStatus;
  }
}

function planFromSubscription(obj: any): string {
  if (obj?.metadata?.plan) return obj.metadata.plan;
  const price = obj?.items?.data?.[0]?.price;
  return price?.recurring?.interval === 'year' ? 'enterprise' : 'pro';
}

export async function billing(app: FastifyInstance) {
  app.post(
    '/api/billing/checkout',
    { preHandler: [requireDashboard(bodyStoreIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z.object({ storeId: z.string(), plan: z.enum(['pro', 'enterprise']) }).parse(req.body);
      const store = await storeRepo.get(body.storeId);
      if (!store) throw Object.assign(new Error('store_not_found'), { statusCode: 404 });
      const session = await createCheckoutSession(body.storeId, body.plan);
      return { url: session.url, sessionId: session.id };
    },
  );

  app.post(
    '/api/billing/portal',
    { preHandler: [requireDashboard(bodyStoreIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z.object({ storeId: z.string() }).parse(req.body);
      const sub = await billingRepo.byStore(body.storeId);
      if (!sub?.stripeCustomerId) throw Object.assign(new Error('no_billing_customer'), { statusCode: 400 });
      const session = await createPortalSession(sub.stripeCustomerId);
      return { url: session.url, sessionId: session.id };
    },
  );

  app.get('/api/billing/status/:storeId', { preHandler: [requireDashboard(paramStoreIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] }, async (req, reply) => {
    const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.params);
    const store = await storeRepo.get(storeId);
    if (!store) return reply.code(404).send({ error: 'store_not_found' });
    const sub = await billingRepo.byStore(storeId);
    return {
      storeId,
      planStatus: store.planStatus,
      plan: sub?.plan ?? 'free',
      status: sub?.status ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      stripeCustomerId: sub?.stripeCustomerId ?? null,
    };
  });

  app.post('/webhooks/stripe', async (req) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw || !config.STRIPE_WEBHOOK_SECRET) throw Object.assign(new Error('stripe_not_configured'), { statusCode: 503 });
    const header = String((req.headers as Record<string, string | string[] | undefined>)['stripe-signature'] ?? '');
    if (!verifyStripeSignature(raw, header, config.STRIPE_WEBHOOK_SECRET)) {
      throw Object.assign(new Error('invalid_signature'), { statusCode: 403 });
    }
    const event = JSON.parse(raw.toString('utf8')) as { type: string; data?: { object?: any } };
    const obj = event.data?.object ?? {};

    if (event.type === 'checkout.session.completed') {
      const storeId = obj.metadata?.store_id;
      const plan = obj.metadata?.plan ?? 'pro';
      if (storeId) {
        await billingRepo.upsertByStripeCustomer({
          storeId,
          plan,
          status: obj.subscription ? 'active' : mapStoresStatus(obj.status ?? 'active'),
          stripeCustomerId: obj.customer,
          stripeSubscriptionId: obj.subscription ?? null,
        });
        await billingRepo.setPlanStatus(storeId, 'active');
      }
    }

    if (event.type.startsWith('customer.subscription.')) {
      const status = obj.status ?? 'active';
      const plan = planFromSubscription(obj);
      const storeId = await billingRepo.updateSubscription({
        stripeSubscriptionId: obj.id,
        status,
        plan,
        stripeCustomerId: obj.customer ?? null,
        currentPeriodEnd: obj.current_period_end ? new Date(obj.current_period_end * 1000) : null,
      });
      if (storeId) {
        await billingRepo.setPlanStatus(storeId, event.type === 'customer.subscription.deleted' ? 'expired' : mapStoresStatus(status));
      }
    }

    return { received: true };
  });
}