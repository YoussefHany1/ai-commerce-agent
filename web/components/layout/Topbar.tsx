'use client';

import { PanelLeftClose, PanelLeftOpen, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { StoreSelector } from '@/components/layout/StoreSelector';
import {
  LocaleToggle,
  NotificationBell,
  ThemeToggle,
  UserMenu,
} from '@/components/layout/TopbarSection';

interface TopbarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Topbar({ collapsed, onToggleCollapse }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200/80 bg-slate-50/80 px-4 backdrop-blur-xl dark:border-white/5 dark:bg-[#0A0A0F]/80 sm:px-6">
      <button
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="hidden rounded-xl p-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 md:inline-flex dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-white"
      >
        {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
      </button>

      <Link href="/dashboard" className="inline-flex items-center gap-2 md:hidden">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-violet-400">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
      </Link>

      <div className="min-w-0 flex-1">
        <StoreSelector />
      </div>

      <div className="flex items-center gap-1">
        <LocaleToggle />
        <ThemeToggle />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}