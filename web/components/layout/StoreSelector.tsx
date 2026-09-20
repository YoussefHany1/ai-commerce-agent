'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronsUpDown, Plus, Store } from 'lucide-react';
import Link from 'next/link';
import { useSelectedStore } from '@/hooks/useStores';
import { PlatformLogo, PlatformDot } from '@/components/layout/PlatformLogo';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/Skeleton';

export function StoreSelector() {
  const { stores, activeStore, storeId, isLoading, isError, setActiveStoreId } =
    useSelectedStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-2.5 rounded-xl border border-slate-200/80 bg-white px-3 py-2 text-start transition hover:border-violet-400/50 dark:border-white/10 dark:bg-white/5 dark:hover:border-violet-500/50"
      >
        {isLoading ? (
          <>
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-4 w-28" />
          </>
        ) : activeStore ? (
          <>
            <PlatformLogo platform={activeStore.platform} size="sm" />
            <span className="hidden min-w-0 sm:block">
              <span className="block max-w-[140px] truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {activeStore.name}
              </span>
              <span className="block text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
                {activeStore.platform}
              </span>
            </span>
          </>
        ) : (
          <span className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Store className="h-4 w-4" /> No store
          </span>
        )}
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="absolute end-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-2xl dark:border-white/10 dark:bg-surface"
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-white/5">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Switch store
              </p>
              {isError && (
                <span className="text-[11px] font-medium text-red-500">Load failed</span>
              )}
            </div>

            <div className="max-h-64 overflow-y-auto p-2">
              {isLoading &&
                Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-xl px-3 py-2.5">
                    <Skeleton className="h-8 w-8 rounded-lg" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                ))}

              {stores.map((store) => {
                const selected = store.id === storeId;
                return (
                  <button
                    key={store.id}
                    onClick={() => {
                      setActiveStoreId(store.id);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition',
                      selected
                        ? 'bg-violet-500/10 dark:bg-white/[0.06]'
                        : 'hover:bg-slate-50 dark:hover:bg-white/5',
                    )}
                  >
                    <PlatformLogo platform={store.platform} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                        {store.name}
                        <PlatformDot platform={store.platform} />
                      </span>
                      {store.shopDomain && (
                        <span className="block truncate text-xs text-slate-400">
                          {store.shopDomain}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <Check className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" />
                    )}
                  </button>
                );
              })}

              {!isLoading && stores.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                  <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
                    No stores connected
                  </p>
                  <p className="text-xs text-slate-400">
                    Connect your first store to get started.
                  </p>
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 p-2 dark:border-white/5">
              <Link
                href="/dashboard/stores"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-violet-600 transition hover:bg-violet-500/10 dark:text-violet-300"
              >
                <Plus className="h-4 w-4" />
                Manage stores
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}