'use client';

import { useMemo } from 'react';
import { CreditCard, ExternalLink, LifeBuoy } from 'lucide-react';
import { toast } from 'sonner';
import { differenceInDays, format } from 'date-fns';
import { useSelectedStore } from '@/hooks/useStores';
import { useBillingStatus, useCheckout, useBillingPortal } from '@/hooks/useBilling';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { PlanCard, type PlanDef } from '@/components/dashboard/PlanCard';
import { Card } from '@/components/ui/Card';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';

const PLANS: PlanDef[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    priceNote: 'forever',
    tagline: 'Try the AI agent with a single store.',
    features: [
      { label: '1 store', included: true },
      { label: 'AI chat on the web widget', included: true },
      { label: 'Product recommendations', included: true },
      { label: 'Attribution analytics', included: false },
      { label: 'Automation rules', included: false },
      { label: 'WhatsApp channel', included: false },
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$49',
    priceNote: '/ month',
    tagline: 'For growing stores that sell hard.',
    highlighted: true,
    features: [
      { label: 'Up to 5 stores', included: true },
      { label: 'WhatsApp channel', included: true },
      { label: 'Attribution analytics', included: true },
      { label: 'Automation rules', included: true },
      { label: 'Conversion lag insights', included: true },
      { label: 'Priority chat support', included: false },
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    priceNote: 'annual',
    tagline: 'For agencies & high-volume merchants.',
    features: [
      { label: 'Unlimited stores', included: true },
      { label: 'White-label dashboard', included: true },
      { label: 'Dedicated onboarding', included: true },
      { label: '99.9% SLA', included: true },
      { label: 'Priority support', included: true },
      { label: 'Custom funnel events', included: true },
    ],
  },
];

const STATUS_META: Record<string, { label: string; variant: BadgeVariant }> = {
  trial: { label: 'Trial', variant: 'info' },
  active: { label: 'Active', variant: 'success' },
  expired: { label: 'Expired', variant: 'danger' },
  free: { label: 'Free', variant: 'neutral' },
};

export default function BillingPage() {
  const { storeId, stores } = useSelectedStore();
  const billing = useBillingStatus(storeId);
  const checkout = useCheckout();
  const portal = useBillingPortal();

  const data = billing.data;
  const planId: string = data?.plan ?? 'free';
  const planStatus: string = data?.planStatus ?? 'trial';
  // Hoisted so the memo's dependency is the value the callback actually reads.
  // Depending on `data?.currentPeriodEnd` while reading `data.currentPeriodEnd`
  // inside lets the compiler infer a different key and skip the optimization.
  const periodEnd = data?.currentPeriodEnd ?? null;

  const daysRemaining = useMemo(() => {
    if (!periodEnd || planStatus !== 'trial') return null;
    const diff = differenceInDays(new Date(periodEnd), new Date());
    return Math.max(0, diff);
  }, [periodEnd, planStatus]);

  const onAction = async (plan: PlanDef) => {
    if (!storeId) {
      toast.error('Select a store first');
      return;
    }
    if (plan.id === 'free') {
      toast.info('Cancel via the billing portal');
      try {
        const res = await portal.mutateAsync(storeId);
        window.open(res.url, '_blank');
      } catch {
        /* handled */
      }
      return;
    }
    const res = await checkout.mutateAsync({ storeId, plan: plan.id as 'pro' | 'enterprise' });
    window.location.href = res.url;
  };

  const openPortal = async () => {
    if (!storeId) return;
    const res = await portal.mutateAsync(storeId);
    window.open(res.url, '_blank');
  };

  const statusMeta = STATUS_META[planStatus] ?? { label: planStatus, variant: 'neutral' as const };

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Manage your plan, invoices and payment method."
      >
        <Button variant="secondary" onClick={openPortal} disabled={!data?.stripeCustomerId}>
          <CreditCard className="h-4 w-4" />
          Billing portal
        </Button>
      </PageHeader>

      {stores.length === 0 ? (
        <Card>
          <EmptyState title="No store selected" description="Connect a store to set up billing." />
        </Card>
      ) : billing.isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      ) : (
        <>
          {/* Current subscription status */}
          <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200/80 bg-gradient-to-r from-violet-600/10 via-transparent to-cyan-500/10 p-5 dark:border-white/5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
              <div>
                <p className="label-muted">Current plan</p>
                <p className="mt-0.5 text-xl font-bold tracking-tight capitalize text-slate-900 dark:text-slate-50">
                  {planId}
                </p>
              </div>
              <Badge variant={statusMeta.variant} dot>
                {statusMeta.label}
              </Badge>
              {daysRemaining !== null && (
                <Badge variant="warning">
                  {daysRemaining} day{daysRemaining === 1 ? '' : 's'} left in trial
                </Badge>
              )}
            </div>
            {data?.currentPeriodEnd && (
              <div className="text-end">
                <p className="text-xs text-slate-500 dark:text-slate-400">Period ends</p>
                <p className="text-sm font-semibold capitalize text-slate-800 dark:text-slate-200">
                  {format(new Date(data.currentPeriodEnd), 'd MMM yyyy')}
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                currentPlan={planId}
                onAction={onAction}
                loading={checkout.isPending || portal.isPending}
              />
            ))}
          </div>

          <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-slate-200/70 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-white/5">
            <div className="flex items-start gap-3">
              <LifeBuoy className="mt-0.5 h-5 w-5 text-violet-500" />
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Need a custom plan?
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Multi-store pricing, white-label setups and annual billing — talk to us.
                </p>
              </div>
            </div>
            <Button variant="secondary" onClick={() => window.open('mailto:hello@aicommerce.agent', '_blank')}>
              <ExternalLink className="h-4 w-4" />
              Contact sales
            </Button>
          </div>
        </>
      )}
    </div>
  );
}