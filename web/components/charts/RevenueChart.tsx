'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import { CHART_COLORS, ChartTooltip, useChartTheme } from '@/components/charts/chartTheme';
import type { DailyMetricRow } from '@/lib/types';
import { formatCurrency } from '@/lib/utils';

export function RevenueChart({ data }: { data: DailyMetricRow[] }) {
  const theme = useChartTheme();
  const rows = data.map((r) => ({
    date: r.day,
    label: format(new Date(`${r.day}T00:00:00`), 'd MMM'),
    revenue: r.revenue,
    attributed: r.attributedRevenue,
  }));

  const tooltipFormatter = (value: number) => formatCurrency(value);

  return (
    <div className="h-64 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.violet} stopOpacity={0.45} />
              <stop offset="100%" stopColor={CHART_COLORS.violet} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradAttributed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.cyan} stopOpacity={0.4} />
              <stop offset="100%" stopColor={CHART_COLORS.cyan} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: theme.tick, fontSize: 11 }}
            axisLine={{ stroke: theme.axis }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: theme.tick, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={52}
            tickFormatter={(v: number) =>
              v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
            }
          />
          <Tooltip
            content={<ChartTooltip formatter={tooltipFormatter} labelFormatter={(l) => String(l)} />}
          />
          <Area
            type="monotone"
            dataKey="revenue"
            name="Revenue"
            stroke={CHART_COLORS.violet}
            strokeWidth={2.5}
            fill="url(#gradRevenue)"
            animationDuration={900}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2 }}
          />
          <Area
            type="monotone"
            dataKey="attributed"
            name="AI-attributed"
            stroke={CHART_COLORS.cyan}
            strokeWidth={2}
            fill="url(#gradAttributed)"
            animationDuration={900}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}