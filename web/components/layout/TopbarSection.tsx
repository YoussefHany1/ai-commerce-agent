'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell,
  CheckCircle2,
  AlertTriangle,
  Settings,
  CreditCard,
  Moon,
  Sun,
  Languages,
  LogOut,
} from 'lucide-react';
import Link from 'next/link';
import { useHealth } from '@/hooks/useMetrics';
import { useTheme } from '@/lib/theme';
import { useLocale } from '@/lib/locale';
import { initials } from '@/lib/utils';
import { useSelectedStore } from '@/hooks/useStores';

function useClickOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return ref;
}

function DropdownCard({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="absolute end-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-2xl dark:border-white/10 dark:bg-surface"
    >
      {children}
    </motion.div>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const health = useHealth();
  const degraded = health.data && !health.data.ok;

  const notifications: Array<{ id: string; tone: 'success' | 'warning' | 'error'; title: string; body: string }> = [];

  if (degraded) {
    const deps = health.data?.deps;
    notifications.push({
      id: 'health',
      tone: 'error',
      title: 'System degraded',
      body: `db: ${deps?.db ? 'ok' : 'down'} · redis: ${deps?.redis ? 'ok' : 'down'}`,
    });
  } else if (health.isSuccess) {
    notifications.push({
      id: 'ops',
      tone: 'success',
      title: 'All systems operational',
      body: 'Postgres & Redis are healthy.',
    });
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className="relative rounded-xl p-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
      >
        <Bell className="h-5 w-5" />
        {degraded && (
          <span className="absolute end-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-[#0A0A0F]" />
        )}
      </button>

      <AnimatePresence>
        {open && (
          <DropdownCard>
            <div className="border-b border-slate-100 px-4 py-3 dark:border-white/5">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Notifications</p>
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {notifications.length === 0 && (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                  <Bell className="h-6 w-6 text-slate-300 dark:text-slate-600" />
                  <p className="text-sm text-slate-500 dark:text-slate-400">Nothing yet</p>
                </div>
              )}
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className="flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-white/5"
                >
                  {n.tone === 'success' ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{n.title}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{n.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </DropdownCard>
        )}
      </AnimatePresence>
    </div>
  );
}

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const { theme, toggleTheme } = useTheme();
  const { toggleLocale } = useLocale();
  const { activeStore } = useSelectedStore();
  const name = activeStore?.name ?? 'Store Owner';
  const email = activeStore?.shopDomain ?? 'owner@store.com';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2.5 rounded-xl p-1.5 transition hover:bg-slate-100 dark:hover:bg-white/5"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-violet-400 text-sm font-bold text-white">
          {initials(name)}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <DropdownCard>
            <div className="border-b border-slate-100 px-4 py-3 dark:border-white/5">
              <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{name}</p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{email}</p>
            </div>
            <div className="p-2">
              <MenuLink icon={CreditCard} label="Billing" href="/dashboard/billing" onClose={() => setOpen(false)} />
              <MenuLink icon={Settings} label="Settings" href="/dashboard/settings" onClose={() => setOpen(false)} />
              <div className="my-1 border-t border-slate-100 dark:border-white/5" />
              <button
                onClick={() => {
                  toggleLocale();
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-600 transition hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5"
              >
                <Languages className="h-5 w-5" />
                Language
              </button>
              <button
                onClick={toggleTheme}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-600 transition hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5"
              >
                {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
              <button
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/10"
              >
                <LogOut className="h-5 w-5" />
                Sign out
              </button>
            </div>
          </DropdownCard>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuLink({
  icon: Icon,
  label,
  href,
  onClose,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href: string;
  onClose: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClose}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-600 transition hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-white/5"
    >
      <Icon className="h-5 w-5" />
      {label}
    </Link>
  );
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      aria-label="Toggle theme"
      className="rounded-xl p-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
    >
      {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}

export function LocaleToggle() {
  const { locale, toggleLocale } = useLocale();
  return (
    <button
      onClick={toggleLocale}
      aria-label="Toggle language"
      className="rounded-xl px-2.5 py-2 text-xs font-bold uppercase tracking-wide text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
    >
      {locale === 'en' ? 'ع' : 'EN'}
    </button>
  );
}