import { cn } from '@/lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  lines?: number;
}

export function Skeleton({ className, lines, ...props }: SkeletonProps) {
  if (lines) {
    return (
      <div className={cn('space-y-3', className)} {...props}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="shimmer shimmer-slow h-3.5 rounded-md bg-slate-200 dark:bg-white/5"
            style={{ width: `${100 - i * 15}%` }}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      className={cn('shimmer shimmer-slow rounded-lg bg-slate-200 dark:bg-white/5', className)}
      {...props}
    />
  );
}