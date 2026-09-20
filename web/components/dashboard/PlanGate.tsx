'use client';

import Link from 'next/link';
import { Lock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface PlanGateProps {
  locked?: boolean;
  title?: string;
  description?: string;
  children: React.ReactNode;
}

export function PlanGate({
  locked = true,
  title = 'Upgrade to unlock',
  description = 'Attribution analytics, conversion lag and advanced insights are available on the Pro plan.',
  children,
}: PlanGateProps) {
  if (!locked) return <>{children}</>;

  return (
    <div className="relative">
      <div className="pointer-events-none select-none blur-[6px]" aria-hidden>
        {children}
      </div>
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-2xl p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-violet-400 shadow-glow">
          <Lock className="h-5 w-5 text-white" />
        </div>
        <div className="max-w-sm">
          <p className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {title}
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
        </div>
        <Link href="/dashboard/billing" className="mt-1">
          <Button size="lg" rightIcon={<Sparkles className="h-4 w-4" />}>
            Upgrade to Pro
          </Button>
        </Link>
      </div>
    </div>
  );
}