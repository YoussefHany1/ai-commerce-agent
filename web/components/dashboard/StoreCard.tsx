'use client';

import { motion } from 'framer-motion';
import { ExternalLink, Globe, Trash2 } from 'lucide-react';
import { PlatformLogo } from '@/components/layout/PlatformLogo';
import { Badge } from '@/components/ui/Badge';
import { formatFromNow } from '@/lib/utils';
import type { Store } from '@/lib/types';

const planBadge: Record<string, { label: string; variant: 'success' | 'info' | 'warning' | 'neutral' }> = {
  trial: { label: 'Trial', variant: 'info' },
  active: { label: 'Active', variant: 'success' },
  expired: { label: 'Expired', variant: 'warning' },
  free: { label: 'Free', variant: 'neutral' },
};

interface StoreCardProps {
  store: Store;
  selected?: boolean;
  onSelect?: () => void;
  onDisconnect?: (store: Store) => void;
}

export function StoreCard({ store, selected, onSelect, onDisconnect }: StoreCardProps) {
  const plan = planBadge[store.planStatus ?? 'trial'] ?? { label: store.planStatus ?? '—', variant: 'neutral' as const };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      onClick={onSelect}
      className={
        selected
          ? 'card card-hover cursor-pointer border-violet-500/40 p-5 ring-1 ring-violet-500/30'
          : 'card card-hover group relative cursor-pointer overflow-hidden p-5'
      }
    >
      <div className="pointer-events-none absolute -end-10 -top-10 h-32 w-32 rounded-full bg-violet-500/[0.07] blur-2xl" />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PlatformLogo platform={store.platform} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {store.name}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-500 capitalize dark:text-slate-400">
              <Globe className="h-3 w-3" />
              {store.shopDomain ?? store.platform}
            </p>
          </div>
        </div>
        <Badge variant={plan.variant}>{plan.label}</Badge>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Badge variant="neutral" className="capitalize">
            {store.platform}
          </Badge>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            added {formatFromNow(store.createdAt)}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {store.shopDomain && (
            <a
              href={`https://${store.shopDomain}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5 dark:hover:text-white"
              aria-label="Open store"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          {onDisconnect && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDisconnect(store);
              }}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-red-500/10 hover:text-red-500"
              aria-label="Disconnect store"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}