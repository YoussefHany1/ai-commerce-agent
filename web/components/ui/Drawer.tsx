'use client';

import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useLocale } from '@/lib/locale';
import { cn } from '@/lib/utils';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  side?: 'start' | 'end';
  className?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = 'end',
  className,
}: DrawerProps) {
  const { dir } = useLocale();
  const anchor = side === 'end' ? (dir === 'ltr' ? 'right' : 'left') : dir === 'ltr' ? 'left' : 'right';

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            key="panel"
            initial={{ x: anchor === 'right' ? '100%' : '-100%', opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: anchor === 'right' ? '100%' : '-100%', opacity: 0.6 }}
            transition={{ type: 'spring', damping: 32, stiffness: 340 }}
            style={{ [anchor]: 0 } as React.CSSProperties}
            className={cn(
              'fixed inset-y-0 z-10 flex w-full max-w-md flex-col border-slate-200/80 bg-white text-slate-900 shadow-2xl dark:border-white/10 dark:bg-surface dark:text-slate-100',
              anchor === 'right'
                ? 'border-l dark:border-l-white/5'
                : 'border-r dark:border-r-white/5',
              className,
            )}
          >
            {(title || description) && (
              <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5 dark:border-white/5">
                <div className="min-w-0">
                  {title && (
                    <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                  )}
                  {description && (
                    <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                      {description}
                    </p>
                  )}
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
            {footer && (
              <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-6 py-4 dark:border-white/5">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}