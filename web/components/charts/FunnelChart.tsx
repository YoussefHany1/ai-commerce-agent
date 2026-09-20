'use client';

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CHART_COLORS, ChartTooltip, useChartTheme } from '@/components/charts/chartTheme';
import { formatPercent, formatNumber } from '@/lib/utils';

interface FunnelSegment {
  name: string;
  value: number;
  color: string;
  sub?: string;
}

export function FunnelChart({
  recommended,
  clicked,
  converted,
}: {
  recommended: number;
  clicked: number;
  converted: number;
}) {
  const theme = useChartTheme();
  const data: FunnelSegment[] = [
    { name: 'Recommended', value: recommended, color: '#33415560' },
    { name: 'Clicked', value: clicked, color: CHART_COLORS.violet },
    { name: 'Converted', value: converted, color: CHART_COLORS.cyan },
  ].filter((d) => d.value > 0);

  const conversionRate = clicked > 0 ? converted / clicked : 0;
  const total = recommended + clicked + converted;
  const centerValue = total > 0 ? conversionRate : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="relative h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={58}
              outerRadius={84}
              paddingAngle={3}
              cornerRadius={6}
              stroke="none"
              animationDuration={900}
              startAngle={90}
              endAngle={-270}
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(value, key) => `${formatNumber(value)}${key === 'converted' ? '' : ''}`}
                />
              }
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-2xl font-bold tracking-tight"
            style={{ color: theme.tooltipText }}
          >
            {formatPercent(centerValue)}
          </span>
          <span className="text-[11px] uppercase tracking-wider" style={{ color: theme.tick }}>
            Conv. rate
          </span>
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        {data.map((d) => (
          <div key={d.name} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} />
              {d.name}
            </span>
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {formatNumber(d.value)}
            </span>
          </div>
        ))}
        {total === 0 && (
          <p className="text-center text-xs text-slate-500 dark:text-slate-400">No data yet</p>
        )}
      </div>
    </div>
  );
}