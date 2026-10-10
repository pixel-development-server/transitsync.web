/**
 * Recharts wrappers.
 *
 * Recharts' defaults assume a light background and hard-code `#fff` fills on
 * tooltips and grid lines, which look broken on the console's dark surface. Each
 * component here supplies console-consistent defaults so pages only declare
 * *what* they are charting, never how it should look.
 *
 * Grid, axis and hover-cursor colours are resolved from the live theme via a
 * MutationObserver on `<html class>` (see `useChartTheme`), so a theme toggle
 * repaints the charts in place. The series palette is fixed at Tailwind's
 * 500-level: those hues are saturated enough to carry on the white light surface
 * and still bright enough against the near-black dark one.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export const CHART_COLORS = [
  '#0ea5e9', // sky
  '#8b5cf6', // violet
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#f97316', // orange
  '#a855f7', // purple
];

/** Tracks the `dark` class on <html> so chart chrome can follow the theme. */
function useIsDark() {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

function useChartTheme() {
  const dark = useIsDark();
  return useMemo(
    () => ({
      dark,
      grid: dark ? 'rgba(148,163,184,0.16)' : 'rgba(100,116,139,0.18)',
      axis: dark ? '#8494b3' : '#64748b',
      cursor: dark ? 'rgba(56,189,248,0.08)' : 'rgba(11,54,209,0.06)',
      axisProps: {
        stroke: 'transparent',
        tick: { fill: dark ? '#8494b3' : '#64748b', fontSize: 11 },
        tickLine: false,
        axisLine: false,
      },
    }),
    [dark],
  );
}

function ChartTooltip({ active, payload, label, formatter, labelFormatter, totalLabel }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-ink-800/96 px-3 py-2 shadow-2xl backdrop-blur">
      {label != null ? (
        <p className="mb-1 text-[0.72rem] font-bold text-mist-100">
          {labelFormatter ? labelFormatter(label, payload) : label}
        </p>
      ) : null}
      <ul className="space-y-0.5">
        {payload.map((entry, index) => {
          // Pie/Radial entries put the value in `payload` rather than `value`.
          const raw = entry.value ?? entry.payload?.value;
          const name = entry.name ?? entry.dataKey;
          const display = typeof raw === 'number' ? raw.toLocaleString() : (raw ?? '—');
          const formatted = formatter ? formatter(raw, name, entry, index) : display;

          return (
            <li key={index} className="flex items-center gap-2 text-[0.72rem]">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: entry.color ?? entry.payload?.fill ?? CHART_COLORS[0] }}
                aria-hidden="true"
              />
              <span className="text-mist-400">{name}</span>
              <span className="tabular ml-auto font-semibold text-mist-100">{formatted}</span>
            </li>
          );
        })}
      </ul>
      {totalLabel && payload.length > 1 ? (
        <p className="mt-1.5 border-t border-[var(--border-subtle)] pt-1.5 text-[0.7rem] text-mist-400">
          {totalLabel}:{' '}
          <span className="tabular font-semibold text-mist-100">
            {payload.reduce((sum, entry) => sum + (Number(entry.value) || 0), 0).toLocaleString()}
          </span>
        </p>
      ) : null}
    </div>
  );
}

const tooltipProps = (options, cursor) => ({
  content: <ChartTooltip {...options} />,
  cursor,
});

/** Vertical bars — boards/alights per day, ridership per bus. */
export function SimpleBarChart({
  data,
  xKey,
  bars = [{ key: 'value', color: CHART_COLORS[0], name: 'Value' }],
  height = 260,
  stacked = false,
  totalLabel,
  xTickFormatter,
  yTickFormatter,
  onBarClick,
}) {
  const theme = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="22%">
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
        <XAxis dataKey={xKey} {...theme.axisProps} tickFormatter={xTickFormatter} interval="preserveStartEnd" />
        <YAxis {...theme.axisProps} tickFormatter={yTickFormatter} width={48} />
        <Tooltip {...tooltipProps({ totalLabel }, theme.cursor)} />
        {bars.length > 1 ? (
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            iconType="circle"
            iconSize={7}
            formatter={(value) => <span style={{ color: theme.axis }}>{value}</span>}
          />
        ) : null}
        {bars.map((bar) => (
          <Bar
            key={bar.key}
            dataKey={bar.key}
            name={bar.name ?? bar.key}
            fill={bar.color}
            stackId={stacked ? 'stack' : undefined}
            radius={stacked ? 0 : [4, 4, 0, 0]}
            maxBarSize={48}
            onClick={onBarClick ? (entry) => onBarClick(entry) : undefined}
            cursor={onBarClick ? 'pointer' : undefined}
            {...(stacked ? { stackOffset: 'none' } : {})}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars — per-bus, per-route, per-hour breakdowns. */
export function HorizontalBarChart({ data, xKey, bars, height = 280, totalLabel }) {
  const theme = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }} barCategoryGap="20%">
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} horizontal={false} />
        <XAxis type="number" {...theme.axisProps} />
        <YAxis type="category" dataKey={xKey} {...theme.axisProps} width={92} />
        <Tooltip {...tooltipProps({ totalLabel }, theme.cursor)} />
        {bars.map((bar) => (
          <Bar key={bar.key} dataKey={bar.key} name={bar.name ?? bar.key} fill={bar.color} radius={[0, 4, 4, 0]} maxBarSize={22} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SimpleLineChart({
  data,
  xKey,
  lines = [{ key: 'value', color: CHART_COLORS[0], name: 'Value' }],
  height = 260,
  totalLabel,
  xTickFormatter,
}) {
  const theme = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
        <XAxis dataKey={xKey} {...theme.axisProps} tickFormatter={xTickFormatter} interval="preserveStartEnd" />
        <YAxis {...theme.axisProps} width={48} />
        <Tooltip {...tooltipProps({ totalLabel }, theme.cursor)} />
        {lines.length > 1 ? (
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 6 }}
            iconType="circle"
            iconSize={7}
            formatter={(value) => <span style={{ color: theme.axis }}>{value}</span>}
          />
        ) : null}
        {lines.map((line) => (
          <Line
            key={line.key}
            type="monotone"
            dataKey={line.key}
            name={line.name ?? line.key}
            stroke={line.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
            {...(line.dashed ? { strokeDasharray: '4 4' } : {})}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function SimpleAreaChart({ data, xKey, areas, height = 240, stacked = false, totalLabel }) {
  const theme = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
        <XAxis dataKey={xKey} {...theme.axisProps} interval="preserveStartEnd" />
        <YAxis {...theme.axisProps} width={48} />
        <Tooltip {...tooltipProps({ totalLabel }, theme.cursor)} />
        {areas.map((area) => (
          <Area
            key={area.key}
            type="monotone"
            dataKey={area.key}
            name={area.name ?? area.key}
            stroke={area.color}
            strokeWidth={2}
            fill={area.color}
            fillOpacity={0.16}
            stackId={stacked ? 'stack' : undefined}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Donut. `data` must carry a label field, a value field and optionally a color. */
export function DonutChart({ data, nameKey = 'name', valueKey = 'value', height = 230, colors = CHART_COLORS, centerLabel, centerValue }) {
  const theme = useChartTheme();

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Tooltip {...tooltipProps({}, theme.cursor)} />
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={nameKey}
            innerRadius="58%"
            outerRadius="88%"
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((entry, index) => (
              <Cell key={index} fill={entry.color ?? colors[index % colors.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>

      {centerValue != null ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="tabular text-xl font-bold text-mist-100">{centerValue}</p>
            {centerLabel ? <p className="text-[0.68rem] text-mist-500">{centerLabel}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RadialGauge({ value = 0, max = 100, label, height = 190, color = CHART_COLORS[0], caption }) {
  const data = [{ name: label ?? 'Value', value: Number(value) || 0 }];

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <RadialBarChart
          data={data}
          innerRadius="72%"
          outerRadius="100%"
          startAngle={215}
          endAngle={-35}
          dataKey="value"
        >
          <PolarAngleAxis type="number" domain={[0, max || 100]} angleAxisId={0} tick={false} />
          <RadialBar background={{ fill: 'rgba(148,163,184,0.15)' }} dataKey="value" cornerRadius={12} fill={color} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="text-center">
          <p className="tabular text-2xl font-bold text-mist-100">
            {Number.isFinite(value) ? Math.round(value) : 0}
            <span className="text-sm text-mist-500">%</span>
          </p>
          {caption ? <p className="text-[0.68rem] text-mist-500">{caption}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** Compact sparkline for KPI cards. */
export function Sparkline({ data, dataKey, color = CHART_COLORS[0], height = 44 }) {
  const points = (data ?? []).map((entry) => entry[dataKey] ?? 0);
  if (points.length < 2) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`spark-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={1.75}
          fill={`url(#spark-${dataKey})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Empty-state wrapper so charts never render as a bare 40px sliver. */
export function ChartFrame({ children, height = 260, empty, isEmpty }) {
  if (isEmpty) {
    return (
      <div className="grid place-items-center text-[0.78rem] text-mist-500" style={{ height }}>
        {empty ?? 'No data in this range.'}
      </div>
    );
  }
  return <div style={{ height }}>{children}</div>;
}
