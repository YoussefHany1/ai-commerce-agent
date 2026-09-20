'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/Skeleton';

export type KpiAccent = 'violet' | 'cyan' | 'emerald' | 'amber' | 'rose';

interface KPICardProps {
  label: string;
  value: number;
  format?: (value: number) => string;
  delta?: number | null;
  deltaLabel?: string;
  icon: React.ReactNode;
  accent?: KpiAccent;
  loading?: boolean;
  hint?: string;
}

const accents: Record<KpiAccent, { icon: string; glow: string; text: string }> = {
  violet: {
    icon: 'from-violet-600/25 to-violet-500/5 text-violet-500 dark:text-violet-400',
    glow: 'group-hover:shadow-[0_0_40px_-12px_rgba(124,58,237,0.5)]',
    text: 'text-violet-600 dark:text-violet-300',
  },
  cyan: {
    icon: 'from-cyan-600/25 to-cyan-500/5 text-cyan-500 dark:text-cyan-400',
    glow: 'group-hover:shadow-[0_0_40px_-12px_rgba(6,182,212,0.5)]',
    text: 'text-cyan-600 dark:text-cyan-300',
  },
  emerald: {
    icon: 'from-emerald-600/25 to-emerald-500/5 text-emerald-500 dark:text-emerald-400',
    glow: 'group-hover:shadow-[0_0_40px_-12px_rgba(16,185,129,0.5)]',
    text: 'text-emerald-600 dark:text-emerald-300',
  },
  amber: {
    icon: 'from-amber-600/25 to-amber-500/5 text-amber-500 dark:text-amber-400',
    glow: 'group-hover:shadow-[0_0_40px_-12px_rgba(245,158,11,0.5)]',
    text: 'text-amber-600 dark:text-amber-300',
  },
  rose: {
    icon: 'from-rose-600/25 to-rose-500/5 text-rose-500 dark:text-rose-400',
    glow: 'group-hover:shadow-[0_0_40px_-12px_rgba(244,63,94,0.5)]',
    text: 'text-rose-600 dark:text-rose-300',
  },
};

function useCountUp(target: number, duration = 1100) {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(target * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return value;
}

export function KPICard({
  label,
  value,
  format = (v) => v.toLocaleString(),
  delta,
  deltaLabel = 'vs previous',
  icon,
  accent = 'violet',
  loading = false,
  hint,
}: KPICardProps) {
  const animated = useCountUp(loading ? 0 : value);
  const display = format(animated);

  if (loading) {
    return (
      <div className="card card-hover group p-5">
        <div className="flex items-start justify-between">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-10 w-10 rounded-xl" />
        </div>
        <Skeleton className="mt-3 h-8 w-28" />
        <Skeleton className="mt-2 h-3 w-20" />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className={cn('card card-hover group relative overflow-hidden p-5', accents[accent].glow)}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="label-muted">{label}</p>
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br',
            accents[accent].icon,
          )}
        >
          {icon}
        </div>
      </div>

      <p className="mt-2 truncate text-[26px] font-bold tracking-tight text-slate-900 tabular-nums dark:text-slate-50">
        {display}
      </p>

      <div className="mt-1.5 flex items-center gap-2">
        {delta === null || delta === undefined ? (
          <span className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
            <Minus className="h-3.5 w-3.5" />
            {deltaLabel}
          </span>
        ) : delta >= 0 ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            <TrendingUp className="h-3.5 w-3.5" />
            {delta >= 0 ? '+' : ''}
            {(delta * 100).toFixed(1)}%
            <span className="font-normal text-slate-500 dark:text-slate-400">{deltaLabel}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
            <TrendingDown className="h-3.5 w-3.5" />
            {(delta * 100).toFixed(1)}%
            <span className="font-normal text-slate-500 dark:text-slate-400">{deltaLabel}</span>
          </span>
        )}
        {hint && (
          <span className="ms-auto text-[11px] text-slate-500 dark:text-slate-400">{hint}</span>
        )}
      </div>
    </motion.div>
  );
}