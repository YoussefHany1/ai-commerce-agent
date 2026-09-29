'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  BarChart3,
  CreditCard,
  LayoutDashboard,
  Settings,
  Sparkles,
  Store,
  Users,
  Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLocale } from '@/lib/locale';
import { makeTranslator } from '@/lib/i18n';
import { useSession, isOperator } from '@/hooks/useSession';

interface NavItem {
  href: string;
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  mobile?: boolean;
}

const MAIN_NAV: NavItem[] = [
  { href: '/dashboard', key: 'navOverview', icon: LayoutDashboard, mobile: true },
  { href: '/dashboard/analytics', key: 'navAnalytics', icon: BarChart3, mobile: true },
  { href: '/dashboard/stores', key: 'navStores', icon: Store, mobile: true },
];

const MANAGE_NAV: NavItem[] = [
  { href: '/dashboard/automation', key: 'navAutomation', icon: Workflow, mobile: true },
  { href: '/dashboard/billing', key: 'navBilling', icon: CreditCard, mobile: true },
  { href: '/dashboard/settings', key: 'navSettings', icon: Settings, mobile: true },
];

/** Operator-only: tenants of this install are managed here, never by the tenants themselves. */
const ADMIN_NAV: NavItem[] = [
  { href: '/dashboard/clients', key: 'navClients', icon: Users, mobile: true },
];

interface SidebarProps {
  collapsed: boolean;
}

function NavLink({
  item,
  collapsed,
  t,
}: {
  item: NavItem;
  collapsed: boolean;
  t: (key: string, fallback?: string) => string;
}) {
  const pathname = usePathname();
  const active = pathname === item.href || pathname.startsWith(item.href + '/');
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
        collapsed && 'justify-center px-2',
        active
          ? 'bg-violet-500/10 text-violet-700 dark:bg-white/[0.06] dark:text-white'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-100',
      )}
    >
      {active && (
        <motion.span
          layoutId="sidebar-active"
          className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-gradient-to-b from-violet-500 to-violet-400"
          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
        />
      )}
      <Icon
        className={cn(
          'h-[18px] w-[18px] shrink-0 transition-colors',
          active && 'text-violet-600 dark:text-violet-300',
        )}
      />
      {!collapsed && (
        <AnimatePresence initial={false}>
          <motion.span
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            transition={{ duration: 0.15 }}
          >
            {t(item.key, item.key)}
          </motion.span>
        </AnimatePresence>
      )}
    </Link>
  );
}

export function Sidebar({ collapsed }: SidebarProps) {
  const { locale } = useLocale();
  const t = makeTranslator(locale);
  const pathname = usePathname();
  const who = useSession();
  const showAdmin = isOperator(who.data);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 z-30 hidden h-screen shrink-0 flex-col border-e border-slate-200/80 bg-slate-50/80 backdrop-blur-xl transition-[width] duration-300 md:flex dark:border-white/5 dark:bg-[#0D0D14]/80',
          collapsed ? 'w-[72px]' : 'w-64',
        )}
      >
        {/* Brand */}
        <div className={cn('flex h-16 items-center gap-3 border-b border-slate-200/70 px-4 dark:border-white/5', collapsed && 'justify-center px-0')}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-violet-400 shadow-glow">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50">
                {t('appName', 'AI Commerce Agent')}
              </p>
              <p className="text-[10px] font-medium uppercase tracking-wider text-violet-600 dark:text-violet-400">
                Sales Agent
              </p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
          <div className="space-y-1">
            {!collapsed && (
              <p className="label-muted px-3 pb-1">{t('navSectionMain', 'Workspace')}</p>
            )}
            {MAIN_NAV.map((item) => (
              <NavLink key={item.href} item={item} collapsed={collapsed} t={t} />
            ))}
          </div>
          <div className="space-y-1">
            {!collapsed && (
              <p className="label-muted px-3 pb-1">{t('navSectionManage', 'Manage')}</p>
            )}
            {MANAGE_NAV.map((item) => (
              <NavLink key={item.href} item={item} collapsed={collapsed} t={t} />
            ))}
          </div>
          {showAdmin && (
            <div className="space-y-1">
              {!collapsed && (
                <p className="label-muted px-3 pb-1">{t('navSectionAdmin', 'Admin')}</p>
              )}
              {ADMIN_NAV.map((item) => (
                <NavLink key={item.href} item={item} collapsed={collapsed} t={t} />
              ))}
            </div>
          )}
        </nav>

        {/* Upgrade card */}
        {!collapsed && (
          <div className="mx-3 mb-4">
            <Link
              href="/dashboard/billing"
              className="group relative block overflow-hidden rounded-2xl border border-violet-500/20 bg-gradient-to-br from-violet-600/15 via-violet-500/10 to-cyan-500/10 p-4 transition hover:border-violet-400/40"
            >
              <div className="pointer-events-none absolute -end-8 -top-8 h-24 w-24 rounded-full bg-violet-500/20 blur-2xl" />
              <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Sparkles className="h-4 w-4 text-violet-500" />
                Unlock Pro
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Attribution analytics, automation & more.
              </p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-violet-600 dark:text-violet-300 transition group-hover:gap-2">
                Upgrade now <span aria-hidden>→</span>
              </span>
            </Link>
          </div>
        )}
      </aside>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch justify-around border-t border-slate-200/80 bg-white/90 px-1 backdrop-blur-xl md:hidden dark:border-white/5 dark:bg-[#0D0D14]/90">
        {[...MAIN_NAV, ...MANAGE_NAV, ...(showAdmin ? ADMIN_NAV : [])].map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition',
                active
                  ? 'text-violet-600 dark:text-violet-300'
                  : 'text-slate-400 dark:text-slate-500',
              )}
            >
              <Icon className="h-5 w-5" />
            </Link>
          );
        })}
      </nav>
    </>
  );
}