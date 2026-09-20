import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'violet'
  | 'cyan';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
}

const variants: Record<BadgeVariant, string> = {
  neutral:
    'bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-300 border-slate-200/60 dark:border-white/5',
  success:
    'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  warning:
    'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  danger:
    'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
  info:
    'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
  violet:
    'bg-violet-500/10 text-violet-600 dark:text-violet-300 border-violet-500/25',
  cyan:
    'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300 border-cyan-500/25',
};

const dots: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-400 dark:bg-slate-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-sky-500',
  violet: 'bg-violet-500',
  cyan: 'bg-cyan-500',
};

export function Badge({
  className,
  variant = 'neutral',
  dot = false,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        variants[variant],
        className,
      )}
      {...props}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dots[variant])} />}
      {children}
    </span>
  );
}