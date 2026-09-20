'use client';

import { useMemo } from 'react';
import { Banknote, MessageSquare, ShoppingCart, Sparkles, TrendingDown, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useSelectedStore } from '@/hooks/useStores';
import { useMetrics } from '@/hooks/useMetrics';
import { useBillingStatus } from '@/hooks/useBilling';
import { KPICard, type KpiAccent } from '@/components/dashboard/KPICard';
import { QuickChat } from '@/components/dashboard/QuickChat';
import { PlanGate } from '@/components/dashboard/PlanGate';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { RevenueChart } from '@/components/charts/RevenueChart';
import { ConversationsChart } from '@/components/charts/ConversationsChart';
import { FunnelChart } from '@/components/charts/FunnelChart';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatCurrency, formatNumber } from '@/lib/utils';
import type { DailyMetricRow } from '@/lib/types';

interface Delta {
  pct: number | null;
  label: string;
}

type NumericMetricKey = Exclude<keyof DailyMetricRow, 'day'>;

function computeDelta(values: number[][]): Delta {
  const [current, previous] = values;
  const cur = current.reduce((a, b) => a + b, 0);
  const prev = previous.reduce((a, b) => a + b, 0);
  if (prev === 0 && cur === 0) return { pct: null, label: 'no data this period' };
  if (prev === 0) return { pct: null, label: 'new in this period' };
  return { pct: (cur - prev) / prev, label: 'vs previous period' };
}

export default function OverviewPage() {
  const { storeId, stores, activeStore, isLoading: storesLoading } = useSelectedStore();
  const metrics = useMetrics(storeId, 14);
  const billing = useBillingStatus(storeId);

  const isLoading = storesLoading || (!!storeId && metrics.isLoading);

  const locked =
    !!billing.data && !['trial', 'active'].includes(billing.data.planStatus);

  const kpis = useMemo(() => {
    const days = metrics.data?.days ?? [];
    const half = Math.floor(days.length / 2);
    const cur = days.slice(half);
    const prev = days.slice(0, half);
    const sum = (key: NumericMetricKey) => days.reduce((a, d) => a + d[key], 0);
    const byKey = (key: NumericMetricKey) =>
      computeDelta([cur.map((d) => d[key]), prev.map((d) => d[key])]);

    const revenue = sum('revenue');
    const attributed = sum('attributedRevenue');
    const conversations = sum('conversations');
    const orders = sum('orders');

    const items: Array<{
      key: string;
      label: string;
      value: number;
      format: (v: number) => string;
      delta: Delta;
      icon: React.ReactNode;
      accent: KpiAccent;
      hint?: string;
    }> = [
      {
        key: 'revenue',
        label: 'Total Revenue',
        value: revenue,
        format: (v) => formatCurrency(v),
        delta: byKey('revenue'),
        icon: <Banknote className="h-5 w-5" />,
        accent: 'violet',
      },
      {
        key: 'attributed',
        label: 'AI-Attributed Revenue',
        value: attributed,
        format: (v) => formatCurrency(v),
        delta: byKey('attributedRevenue'),
        icon: <Sparkles className="h-5 w-5" />,
        accent: 'cyan',
        hint:
          revenue > 0 ? `${((attributed / revenue) * 100).toFixed(0)}% of revenue` : undefined,
      },
      {
        key: 'conversations',
        label: 'Conversations',
        value: conversations,
        format: (v) => formatNumber(v),
        delta: byKey('conversations'),
        icon: <MessageSquare className="h-5 w-5" />,
        accent: 'emerald',
      },
      {
        key: 'orders',
        label: 'Orders',
        value: orders,
        format: (v) => formatNumber(v),
        delta: byKey('orders'),
        icon: <ShoppingCart className="h-5 w-5" />,
        accent: 'amber',
      },
    ];
    return items;
  }, [metrics.data]);

  const totals = metrics.data?.totals;

  if (!storesLoading && stores.length === 0) {
    return (
      <div>
        <PageHeader title="Welcome to AI Commerce Agent" description="Connect your first store to start selling with AI." />
        <div className="rounded-2xl border border-dashed border-slate-300 dark:border-white/10">
          <EmptyState
            icon={<ShoppingCart className="h-6 w-6" />}
            title="No stores connected"
            description="Connect a Shopify, Salla or Zid store to activate your AI sales agent and start tracking attribution."
            action={
              <Link href="/dashboard/stores">
                <Button>Connect your first store</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const kpiGrid = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map((kpi) => (
        <KPICard
          key={kpi.key}
          label={kpi.label}
          value={kpi.value}
          format={kpi.format}
          delta={kpi.delta.pct}
          deltaLabel={kpi.delta.label}
          icon={kpi.icon}
          accent={kpi.accent}
          loading={isLoading}
          hint={kpi.hint}
        />
      ))}
    </div>
  );

  const chartsSection = (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title="Revenue over time"
          description="Daily revenue vs AI-attributed revenue"
          className="lg:col-span-2"
        >
          {isLoading ? (
            <Skeleton className="h-72" />
          ) : (
            <RevenueChart data={metrics.data?.days ?? []} />
          )}
        </Card>

        <Card title="Test your agent" description="Live chat with the AI sales agent" className="flex flex-col">
          <QuickChat />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Conversations vs Messages"
          description="Engagement across channels, per day"
        >
          {isLoading ? (
            <Skeleton className="h-72" />
          ) : (
            <ConversationsChart data={metrics.data?.days ?? []} />
          )}
        </Card>

        <Card
          title="Recommendation funnel"
          description="From recommendation to purchase"
        >
          {isLoading ? (
            <Skeleton className="h-64" />
          ) : (
            <FunnelChart
              recommended={totals?.recommended ?? 0}
              clicked={totals?.clicked ?? 0}
              converted={totals?.converted ?? 0}
            />
          )}
        </Card>
      </div>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={activeStore ? `${activeStore.name}` : 'Overview'}
        description="Performance of your AI sales agent over the last 14 days."
      >
        <Link href="/dashboard/analytics">
          <Button variant="secondary" size="sm">
            View analytics
          </Button>
        </Link>
      </PageHeader>

      {locked ? (
        <PlanGate
          title="Your analytics are paused"
          description="Attribution, revenue and funnel insights are available on the Pro plan. Keep your trial or upgrade to continue."
        >
          {kpiGrid}
          {chartsSection}
        </PlanGate>
      ) : (
        <>
          {kpiGrid}
          {chartsSection}
        </>
      )}

      {metrics.isError && !locked && (
        <div className="flex items-center justify-between rounded-2xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          <span>Couldn’t load metrics for this store.</span>
          <Button variant="secondary" size="sm" onClick={() => metrics.refetch()}>
            <RefreshCw className="h-4 w-4" /> Retry
          </Button>
        </div>
      )}

      {metrics.data && [...metrics.data.days].every((d) => d.revenue === 0 && d.conversations === 0) && (
        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
          <TrendingDown className="h-4 w-4" />
          No activity in this store yet — connect your catalog and try the chat to generate a first recommendation.
        </div>
      )}
    </div>
  );
}