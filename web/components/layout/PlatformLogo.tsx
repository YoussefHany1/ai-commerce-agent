import { Store as StoreIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Platform } from '@/lib/types';

const brand: Record<Platform, { color: string; label: string }> = {
  shopify: { color: '#95BF47', label: 'S' },
  salla: { color: '#0EA5E9', label: 'S' },
  zid: { color: '#E11D48', label: 'Z' },
};

export function PlatformLogo({
  platform,
  size = 'md',
  className,
}: {
  platform: Platform | string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const p = brand[platform as Platform] ?? { color: '#64748B', label: (platform?.[0] ?? 'S').toUpperCase() };
  const box =
    size === 'lg' ? 'h-11 w-11 rounded-xl text-lg' : size === 'sm' ? 'h-7 w-7 rounded-lg text-xs' : 'h-9 w-9 rounded-xl text-sm';

  return (
    <div
      className={cn('flex shrink-0 items-center justify-center font-bold text-white', box, className)}
      style={{ background: `linear-gradient(135deg, ${p.color}, ${p.color}99)` }}
      title={platform}
    >
      {p.label}
    </div>
  );
}

export function PlatformDot({ platform, className }: { platform: Platform | string; className?: string }) {
  const p = brand[platform as Platform] ?? { color: '#64748B', label: '' };
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', className)}
      style={{ background: p.color }}
    />
  );
}

export function StoreIconFallback({ className }: { className?: string }) {
  return <StoreIcon className={className} />;
}