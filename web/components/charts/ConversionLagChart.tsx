'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
} from 'recharts';
import { ChartTooltip, useChartTheme } from '@/components/charts/chartTheme';
import { formatHours } from '@/lib/utils';

const BAR_COLORS = [
  '#7C3AED',
  '#8B5CF6',
  '#A78BFA',
  '#9D6FF5',
  '#06B6D4',
  '#22D3EE',
];

export function ConversionLagChart({
  data,
}: {
  data: Array<{ label: string; count: number; share: number }>;
}) {
  const theme = useChartTheme();

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: theme.tick, fontSize: 11 }}
            axisLine={{ stroke: theme.axis }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: theme.tick, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
            allowDecimals={false}
          />
          <Tooltip
            content={
              <ChartTooltip
                formatter={(value) => `${value.toLocaleString()} conversions`}
                labelFormatter={(l) => `Time to convert: ${String(l)}`}
              />
            }
          />
          <Bar
            dataKey="count"
            name="Conversions"
            radius={[8, 8, 0, 0]}
            animationDuration={900}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LagStatChips({
  overall,
}: {
  overall: { count: number; avgHours: number; medianHours: number; p90Hours: number };
}) {
  const items = [
    { label: 'Conversions', value: overall.count.toLocaleString() },
    { label: 'Avg lag', value: formatHours(overall.avgHours) },
    { label: 'Median', value: formatHours(overall.medianHours) },
    { label: 'P90', value: formatHours(overall.p90Hours) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-xl border border-slate-200/70 bg-white px-4 py-3 dark:border-white/5 dark:bg-white/[0.03]"
        >
          <p className="label-muted">{item.label}</p>
          <p className="mt-1 text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}