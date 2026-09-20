'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import { CHART_COLORS, ChartTooltip, useChartTheme } from '@/components/charts/chartTheme';
import type { DailyMetricRow } from '@/lib/types';

export function ConversationsChart({ data }: { data: DailyMetricRow[] }) {
  const theme = useChartTheme();
  const rows = data.map((r) => ({
    date: r.day,
    label: format(new Date(`${r.day}T00:00:00`), 'd MMM'),
    conversations: r.conversations,
    messages: r.messages,
  }));

  return (
    <div className="h-64 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={4}>
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
            width={40}
          />
          <Tooltip content={<ChartTooltip labelFormatter={(l) => String(l)} />} />
          <Bar
            dataKey="conversations"
            name="Conversations"
            fill={CHART_COLORS.violet}
            radius={[6, 6, 0, 0]}
            animationDuration={900}
          />
          <Bar
            dataKey="messages"
            name="Messages"
            fill={CHART_COLORS.cyan}
            radius={[6, 6, 0, 0]}
            animationDuration={900}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}