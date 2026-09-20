'use client';

import { motion } from 'framer-motion';
import { Check, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

export type PlanId = 'free' | 'pro' | 'enterprise';

export interface PlanFeature {
  label: string;
  included: boolean;
}

export interface PlanDef {
  id: PlanId;
  name: string;
  price: string;
  priceNote: string;
  tagline: string;
  features: PlanFeature[];
  highlighted?: boolean;
}

interface PlanCardProps {
  plan: PlanDef;
  currentPlan: string;
  onAction: (plan: PlanDef) => void;
  actionLabel?: (plan: PlanDef) => string;
  loading?: boolean;
  locker?: boolean;
}

export function PlanCard({
  plan,
  currentPlan,
  onAction,
  actionLabel,
  loading,
  locker,
}: PlanCardProps) {
  const isCurrent = currentPlan === plan.id;
  const included = plan.features.filter((f) => f.included);

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'card relative flex flex-col overflow-hidden p-6',
        plan.highlighted && 'border-violet-500/40 ring-1 ring-violet-500/20 dark:border-violet-500/50',
      )}
    >
      {plan.highlighted && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-600 via-violet-400 to-cyan-500" />
      )}

      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {plan.name}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{plan.tagline}</p>
        </div>
        {isCurrent && (
          <Badge variant={plan.highlighted ? 'violet' : 'success'} dot>
            Current
          </Badge>
        )}
      </div>

      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          {plan.price}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{plan.priceNote}</span>
      </div>

      <div className="my-5 border-t border-slate-100 dark:border-white/5" />

      <ul className="flex-1 space-y-2.5">
        {included.map((f) => (
          <li key={f.label} className="flex items-center gap-2.5 text-sm text-slate-600 dark:text-slate-300">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
              <Check className="h-3 w-3 text-emerald-500" />
            </span>
            {f.label}
          </li>
        ))}
        {plan.features
          .filter((f) => !f.included)
          .map((f) => (
            <li key={f.label} className="flex items-center gap-2.5 text-sm text-slate-400 dark:text-slate-600">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-500/10">
                <X className="h-3 w-3" />
              </span>
              {locker ? (
                <span className="flex items-center gap-1.5">
                  {f.label}
                  <Badge variant="neutral">Locked</Badge>
                </span>
              ) : (
                f.label
              )}
            </li>
          ))}
      </ul>

      <div className="pt-6">
        <Button
          variant={isCurrent ? 'secondary' : plan.highlighted ? 'primary' : 'secondary'}
          className="w-full"
          disabled={isCurrent}
          loading={loading}
          onClick={() => onAction(plan)}
        >
          {isCurrent
            ? 'Current plan'
            : actionLabel?.(plan) ??
              (plan.id === 'free' ? 'Downgrade' : plan.highlighted ? <><Sparkles className="h-4 w-4" /> Upgrade to {plan.name}</> : 'Choose plan')}
        </Button>
      </div>
    </motion.div>
  );
}