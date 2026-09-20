'use client';

import { useState } from 'react';
import { Filter, Globe, MessageCircle, RefreshCw } from 'lucide-react';
import { useSelectedStore } from '@/hooks/useStores';
import { useBillingStatus } from '@/hooks/useBilling';
import {
  useAttributions,
  useConversionLag,
  useSources,
  useTopProducts,
} from '@/hooks/useAnalytics';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { PlanGate } from '@/components/dashboard/PlanGate';
import { ConversionLagChart, LagStatChips } from '@/components/charts/ConversionLagChart';
import { Card } from '@/components/ui/Card';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn, formatCurrency, formatFromNow, formatPercent } from '@/lib/utils';
import type { AttributionStatus } from '@/lib/types';

const RANGES = [7, 14, 30, 90] as const;

const statusBadge: Record<AttributionStatus, { label: string; variant: BadgeVariant }> = {
  converted: { label: 'Converted', variant: 'success' },
  clicked: { label: 'Clicked', variant: 'cyan' },
  recommended: { label: 'Recommended', variant: 'neutral' },
};

const statusFilters = [
  { value: undefined, label: 'All' },
  { value: 'clicked', label: 'Clicked' },
  { value: 'converted', label: 'Converted' },
] as const;

function rangeControl(days: number, onChange: (d: number) => void) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-slate-200/80 bg-white p-1 dark:border-white/10 dark:bg-white/5">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-semibold transition',
            days === r
              ? 'bg-gradient-to-r from-violet-600 to-violet-500 text-white shadow-sm'
              : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
          )}
        >
          {r}d
        </button>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const { storeId, stores } = useSelectedStore();
  const billing = useBillingStatus(storeId);
  const [days, setDays] = useState(14);
  const [statusFilter, setStatusFilter] = useState<(typeof statusFilters)[number]['value']>(undefined);

  const lag = useConversionLag(storeId, days);
  const sources = useSources(storeId);
  const products = useTopProducts(storeId, 8);
  const attributions = useAttributions(storeId);

  const locked = !!billing.data && !['trial', 'active'].includes(billing.data.planStatus);
  const loading = !!storeId && (lag.isLoading || sources.isLoading || products.isLoading || attributions.isLoading);

  const anyError = lag.isError || sources.isError || products.isError || attributions.isError;

  if (stores.length === 0) {
    return (
      <div>
        <PageHeader title="Analytics" description="See exactly how your AI agent performs." />
        <Card>
          <EmptyState title="No store selected" description="Connect a store to view attribution analytics." />
        </Card>
      </div>
    );
  }

  const content = (
    <div className="space-y-6">
      {loading ? (
        <>
          <Skeleton className="h-24" />
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
          <Skeleton className="h-80" />
        </>
      ) : anyError ? (
        <Card>
          <EmptyState
            icon={<RefreshCw className="h-6 w-6" />}
            title="Couldn’t load analytics"
            description="Something went wrong talking to the analytics API."
            action={<Button onClick={() => { void Promise.all([lag.refetch(), sources.refetch(), products.refetch(), attributions.refetch()]); }}>Retry</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Conversion lag */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card
              title="Conversion lag histogram"
              description={`Time from recommendation click to purchase (last ${days} days)`}
              className="lg:col-span-2"
            >
              {lag.data && lag.data.distribution.length > 0 && lag.data.overall.count > 0 ? (
                <>
                  <LagStatChips overall={lag.data.overall} />
                  <div className="mt-4">
                    <ConversionLagChart data={lag.data.distribution} />
                  </div>
                </>
              ) : (
                <EmptyState title="No conversions yet" description="Converted recommendations will appear here." />
              )}
            </Card>

            <Card title="Recommendations by channel" description="Funnel breakdown across channels">
              {sources.data?.channels.length ? (
                <div className="space-y-4">
                  {sources.data.channels.map((c) => {
                    const max = c.recommended || 1;
                    const bClicked = (c.clicked / max) * 100;
                    const bConverted = (c.converted / max) * 100;
                    const bRecommended = ((c.recommended - c.clicked) / max) * 100;
                    return (
                      <div key={c.channel}>
                        <div className="mb-1.5 flex items-center justify-between text-sm">
                          <span className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-200">
                            {c.channel === 'whatsapp' ? (
                              <MessageCircle className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                              <Globe className="h-3.5 w-3.5 text-violet-500" />
                            )}
                            <span className="capitalize">{c.channel}</span>
                          </span>
                          <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-semibold text-slate-700 dark:text-slate-200">
                              {c.recommended}
                            </span>
                            recs
                          </span>
                        </div>
                        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/5">
                          <div className="h-full bg-slate-400/40 transition-all" style={{ width: `${bRecommended}%` }} />
                          <div className="h-full bg-violet-500 transition-all" style={{ width: `${bClicked}%` }} />
                          <div className="h-full bg-cyan-500 transition-all" style={{ width: `${bConverted}%` }} />
                        </div>
                        <div className="mt-1 flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
                          <span>
                            CTR <span className="font-semibold text-slate-700 dark:text-slate-200">{formatPercent(c.ctr)}</span>
                          </span>
                          <span>
                            CVR <span className="font-semibold text-slate-700 dark:text-slate-200">{formatPercent(c.cvr)}</span>
                          </span>
                          <span>
                            Rev <span className="font-semibold text-slate-700 dark:text-slate-200">{formatCurrency(c.revenue)}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState title="No channels yet" description="Attributed recommendations will appear by channel." />
              )}
            </Card>
          </div>

          {/* Top products */}
          <Card title="Top recommended products" description="Best performers by AI recommendations">
            {products.data?.products.length ? (
              <>
                <div className="hidden md:block">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-100 text-start dark:border-white/5">
                        {['Product', 'Price', 'Recs', 'Clicks', 'Conv', 'CVR', 'Revenue'].map((h, i) => (
                          <th
                            key={h}
                            className={cn('px-4 pb-2 text-xs font-medium uppercase tracking-wider text-slate-400', i === 0 && 'text-start')}
                          >
                            <span className={cn(i === 0 ? 'text-start' : 'text-end', 'block')}>{h}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                      {products.data.products.map((p) => (
                        <tr key={p.productId} className="text-sm">
                          <td className="max-w-[240px] truncate px-4 py-3 font-medium text-slate-800 dark:text-slate-200">
                            {p.productTitle}
                          </td>
                          <td className="px-4 py-3 text-end text-slate-500 dark:text-slate-400">{formatCurrency(p.productPrice)}</td>
                          <td className="px-4 py-3 text-end tabular-nums">{p.recommended}</td>
                          <td className="px-4 py-3 text-end tabular-nums">{p.clicked}</td>
                          <td className="px-4 py-3 text-end tabular-nums">
                            <Badge variant={p.converted > 0 ? 'success' : 'neutral'}>{p.converted}</Badge>
                          </td>
                          <td className="px-4 py-3 text-end tabular-nums">
                            <span className="font-semibold text-violet-600 dark:text-violet-300">{formatPercent(p.cvr)}</span>
                          </td>
                          <td className="px-4 py-3 text-end font-semibold tabular-nums">{formatCurrency(p.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
                  {products.data.products.map((p) => (
                    <div key={p.productId} className="rounded-xl border border-slate-200/70 p-4 dark:border-white/5">
                      <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-200">{p.productTitle}</p>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <Metric label="Recs" value={p.recommended} />
                        <Metric label="Clicks" value={p.clicked} />
                        <Metric label="Conv" value={p.converted} />
                        <Metric label="CVR" value={formatPercent(p.cvr)} />
                        <Metric label="Revenue" value={formatCurrency(p.revenue)} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="No recommendations yet" description="Chat with your agent to start generating product recommendations." />
            )}
          </Card>

          {/* Attribution table */}
          <Card
            title="Attribution history"
            description="Conversions tracked from AI recommendations"
            action={
              <div className="flex items-center gap-1.5">
                {statusFilters.map((f) => (
                  <button
                    key={f.label}
                    onClick={() => setStatusFilter(f.value)}
                    className={cn(
                      'rounded-lg px-2.5 py-1 text-xs font-semibold transition',
                      statusFilter === f.value
                        ? 'bg-violet-500/15 text-violet-600 dark:text-violet-300'
                        : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            }
          >
            {attributions.data?.attributions.length ? (
              <>
                <div className="hidden md:block">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-100 text-start dark:border-white/5">
                        {['Product', 'Channel', 'Status', 'Clicked', 'Converted', 'Revenue'].map((h) => (
                          <th key={h} className="px-4 pb-2 text-xs font-medium uppercase tracking-wider text-slate-400 text-start">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                      {attributions.data.attributions.slice(0, 20).map((a, i) => {
                        const badge = statusBadge[a.status];
                        return (
                          <tr key={i} className="text-sm">
                            <td className="max-w-[240px] truncate px-4 py-3 font-medium text-slate-800 dark:text-slate-200">
                              {a.productTitle}
                            </td>
                            <td className="px-4 py-3 text-slate-500 capitalize dark:text-slate-400">{a.channel}</td>
                            <td className="px-4 py-3">
                              <Badge variant={badge.variant} dot>
                                {badge.label}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                              {a.clickedAt ? formatFromNow(a.clickedAt) : '—'}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                              {a.convertedAt ? formatFromNow(a.convertedAt) : '—'}
                            </td>
                            <td className="px-4 py-3 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                              {a.convertedAt ? formatCurrency(a.revenue) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-2 md:hidden">
                  {attributions.data.attributions.slice(0, 10).map((a, i) => {
                    const badge = statusBadge[a.status];
                    return (
                      <div key={i} className="rounded-xl border border-slate-200/70 p-4 dark:border-white/5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-200">{a.productTitle}</p>
                          <Badge variant={badge.variant} dot>{badge.label}</Badge>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="capitalize">{a.channel}</span>
                          <span>·</span>
                          {a.convertedAt ? formatFromNow(a.convertedAt) : 'No conversion'}
                          {a.convertedAt && (
                            <span className="ms-auto font-semibold text-emerald-500">{formatCurrency(a.revenue)}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <EmptyState
                icon={<Filter className="h-6 w-6" />}
                title="No attributions recorded"
                description="When customers click and buy your recommended products, the sequence shows up here."
              />
            )}
          </Card>
        </>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Attribution, funnels and conversion behavior across your channels."
      >
        {rangeControl(days, setDays)}
      </PageHeader>

      {locked ? (
        <PlanGate title="Analytics require the Pro plan" description="Upgrade to keep tracking attribution, funnels and conversion lag.">
          {content}
        </PlanGate>
      ) : (
        content
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-white/[0.03]">
      <p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-800 dark:text-slate-200">{value}</p>
    </div>
  );
}