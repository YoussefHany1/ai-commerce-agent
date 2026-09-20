'use client';

import { useTheme } from '@/lib/theme';

export const CHART_COLORS = {
  violet: '#7C3AED',
  violetLight: '#9D6FF5',
  cyan: '#06B6D4',
  emerald: '#10B981',
  amber: '#F59E0B',
  rose: '#EF4444',
  slate: '#64748B',
  muted: '#94A3B8',
  white: '#F8FAFC',
};

export const funnelColors = {
  recommended: '#3B4A5E',
  clicked: '#7C3AED',
  converted: '#06B6D4',
};

export function useChartTheme() {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  return {
    dark,
    tick: dark ? '#64748B' : '#94A3B8',
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(100,116,139,0.18)',
    axis: dark ? 'rgba(255,255,255,0.08)' : 'rgba(100,116,139,0.25)',
    tooltipBg: dark ? '#1A1A24' : '#FFFFFF',
    tooltipBorder: dark ? 'rgba(255,255,255,0.1)' : 'rgba(100,116,139,0.2)',
    tooltipText: dark ? '#F1F5F9' : '#0F172A',
    tooltipMuted: dark ? '#94A3B8' : '#64748B',
  };
}

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
  dataKey?: string | number;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  formatter?: (value: number, key: string) => string;
  labelFormatter?: (label: string | number) => string;
}

export function ChartTooltip({
  active,
  payload,
  label,
  formatter,
  labelFormatter,
}: ChartTooltipProps) {
  const theme = useChartTheme();
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div
      className="rounded-xl border px-3.5 py-2.5 text-xs shadow-lg backdrop-blur-xl"
      style={{
        background: theme.tooltipBg,
        borderColor: theme.tooltipBorder,
        color: theme.tooltipText,
      }}
    >
      {label !== undefined && label !== '' && (
        <p
          className="mb-1.5 font-semibold"
          style={{ color: theme.tooltipText }}
        >
          {labelFormatter ? labelFormatter(label) : String(label)}
        </p>
      )}
      <div className="space-y-1">
        {payload.map((entry, i) => {
          const value = typeof entry.value === 'number' ? entry.value : 0;
          const key = typeof entry.dataKey === 'string' ? entry.dataKey : entry.name ?? '';
          return (
            <div key={i} className="flex items-center justify-between gap-6">
              <span className="flex items-center gap-1.5" style={{ color: theme.tooltipMuted }}>
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: entry.color ?? CHART_COLORS.violet }}
                />
                {entry.name}
              </span>
              <span className="font-semibold" style={{ color: theme.tooltipText }}>
                {formatter ? formatter(value, key) : value.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}