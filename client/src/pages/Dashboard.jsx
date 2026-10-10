import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import {
  Badge,
  EmptyState,
  ErrorState,
  LiveIndicator,
  OccupancyBar,
  PageHeader,
  Panel,
  StatCard,
  StatusBadge,
  Tooltip,
} from '../components/ui.jsx';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useEventStream } from '../lib/stream.js';
import { formatNumber, formatTime } from '../lib/format.js';

/** Shared empty reference so `data?.x ?? EMPTY` stays memo-stable. */
const EMPTY = [];

/** Ring/usage colour by headroom so an overloaded bus is obvious at a glance. */
function toneForPct(pct) {
  if (pct >= 90) return 'bad';
  if (pct >= 75) return 'warn';
  return 'good';
}

/**
 * One bus in the Fleet Monitor. Shows the passenger count, the operational
 * status and the green-button visitor head-count for the day.
 */
function FleetCard({ bus }) {
  const [flash, setFlash] = useState(false);

  // Re-pulse the card when occupancy changes from a live event.
  const key = `${bus.id}:${bus.occupancy}`;
  useEffect(() => {
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(timer);
  }, [key]);

  return (
    <div className={`card p-3.5 transition ${flash ? 'ts-flash' : ''}`}>
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: bus.route?.color ?? '#38bdf8' }}
              aria-hidden="true"
            />
            <p className="truncate text-[0.86rem] font-bold text-mist-100">{bus.code}</p>
            <span className="truncate text-[0.72rem] text-mist-500">{bus.name}</span>
          </div>
          <p className="mt-0.5 truncate text-[0.68rem] text-mist-500">
            {bus.route ? `${bus.route.code} · ${bus.route.name}` : 'No route assigned'}
          </p>
        </div>
        <StatusBadge status={bus.status} dot={false} />
      </div>

      <OccupancyBar occupancy={bus.occupancy ?? 0} capacity={bus.seatCapacity ?? 0} className="mt-2" />

      <div className="mt-2.5 flex items-center justify-between text-[0.68rem] text-mist-500">
        <span className="truncate">
          <Icon name="user" className="mr-1 inline h-3 w-3" />
          {bus.occupancy ?? 0} passenger{(bus.occupancy ?? 0) === 1 ? '' : 's'} · {bus.allocated ?? 0} allocated
        </span>
        <span className="tabular inline-flex shrink-0 items-center gap-1 text-emerald-400">
          <Icon name="zap" className="h-3 w-3" />
          {bus.visitors ?? 0} visitors
        </span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { can, user } = useAuth();
  const [liveFeeds, setLiveFeeds] = useState(0);

  const { data, error, loading, refreshing, reload } = useApi('/dashboard', {
    enabled: can('dashboard:read'),
  });

  // Live counters: cheap local state fed by the stream rather than a full
  // dashboard refetch per scan, which would hammer the API during rush hour.
  const { status: streamStatus } = useEventStream({
    enabled: can('dashboard:read'),
    onEvent: useCallback((event) => {
      if (event === 'scan' || event === 'activity') setLiveFeeds((count) => count + 1);
    }, []),
  });

  const kpis = data?.kpis;
  // Stable empty references: a fresh `[]` literal every render would make every
  // downstream render churn on each stream-driven re-render.
  const fleet = data?.fleet ?? EMPTY;
  const activity = data?.activity ?? EMPTY;

  if (error) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Live operational overview" />
        <ErrorState error={error} onRetry={reload} />
      </>
    );
  }

  if (loading) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Live operational overview" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="card h-[6.5rem] animate-pulse bg-ink-800/50" />
          ))}
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div className="card h-80 animate-pulse bg-ink-800/50" />
          <div className="card h-80 animate-pulse bg-ink-800/50" />
        </div>
      </>
    );
  }

  const utilizationTone = toneForPct(kpis?.utilization?.percent ?? 0);
  const firstName = user?.fullName?.split(' ')[0] ?? 'there';
  const activeShuttles = kpis?.fleet?.active ?? 0;
  const onboard = kpis?.students?.onboard ?? 0;
  const openAlerts = kpis?.alerts?.open ?? 0;

  return (
    <>
      {/* ---------------------------------------------------------------- */}
      {/* 1. Operations Control banner                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className="relative mb-4 overflow-hidden rounded-3xl bg-brand-500 p-6 text-white shadow-lg shadow-brand-500/20">
        <div className="relative z-10 max-w-2xl">
          <p className="text-[0.68rem] font-semibold tracking-[0.16em] text-white/70 uppercase">
            Operations Control
            {data?.generatedAt ? ` · ${formatTime(data.generatedAt)} NPT` : ''}
          </p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-3xl">
            Namaste, {firstName}!
          </h2>
          <p className="mt-1.5 max-w-xl text-[0.85rem] leading-relaxed text-white/85">
            {activeShuttles} shuttle{activeShuttles === 1 ? '' : 's'} in service ·{' '}
            {formatNumber(onboard)} students onboard · {openAlerts} open alert
            {openAlerts === 1 ? '' : 's'}.
            {liveFeeds > 0 ? ` ${liveFeeds} live events this session.` : ''}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link to="/live" className="btn bg-white text-brand-600 hover:bg-white/90">
              <Icon name="activity" className="h-3.5 w-3.5" />
              Open live monitor
            </Link>
            <button
              type="button"
              className="btn border border-white/30 bg-white/10 text-white hover:bg-white/20"
              onClick={() => reload({ silent: true })}
              disabled={refreshing}
            >
              <Icon name="refresh" className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <span className="ml-1 [&>span]:text-white [&_.ts-pulse]:bg-white">
              <LiveIndicator status={streamStatus} />
            </span>
          </div>
        </div>

        <svg
          viewBox="0 0 200 200"
          aria-hidden="true"
          className="pointer-events-none absolute -right-8 -bottom-10 hidden h-52 w-52 sm:block"
        >
          <circle cx="150" cy="52" r="72" fill="rgba(255,255,255,0.10)" />
          <circle cx="150" cy="52" r="48" fill="rgba(255,255,255,0.14)" />
          <path d="M24 156h140" stroke="rgba(255,255,255,0.35)" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 12" />
          <circle cx="44" cy="156" r="9" fill="#ffffff" />
          <circle cx="44" cy="156" r="4" fill="#0b36d1" />
        </svg>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. Quick navigation cards                                        */}
      {/* ---------------------------------------------------------------- */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ActionCard to="/live" icon="activity" tone="info" title="Live Fleet Stream" subtitle="Real-time tap feed" />
        <ActionCard
          to="/alerts"
          icon="alerts"
          tone={openAlerts > 0 ? 'bad' : 'warn'}
          title="Unregistered Alerts"
          subtitle={`${openAlerts} open now`}
        />
        <ActionCard to="/fleet" icon="route" tone="good" title="Route Schedules" subtitle="Buses, routes & stops" />
        <ActionCard
          to="/live"
          icon="attendance"
          tone="accent"
          title="Visitor Counts"
          subtitle="Green-button head count"
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* 3. Stat overview cards                                           */}
      {/* ---------------------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Registered students"
          value={kpis?.students?.total ?? 0}
          sub={`${kpis?.students?.active ?? 0} active · ${kpis?.students?.onboard ?? 0} onboard`}
          icon="students"
          tone="info"
        />
        <StatCard
          label="Fleet in service"
          value={`${activeShuttles}/${kpis?.fleet?.total ?? 0}`}
          sub={`${formatNumber(kpis?.fleet?.activeCapacity ?? 0)} seats · ${kpis?.fleet?.maintenance ?? 0} in maintenance`}
          icon="bus"
          tone="good"
        />
        <StatCard
          label="Open alerts"
          value={openAlerts}
          sub={`${kpis?.alerts?.critical ?? 0} critical · ${kpis?.alerts?.last24h ?? 0} in 24h`}
          icon="alerts"
          tone={kpis?.alerts?.critical > 0 ? 'bad' : 'warn'}
        />
        <StatCard
          label="Seat utilisation"
          value={kpis?.utilization?.percent ?? 0}
          sub={`${kpis?.utilization?.onboard ?? 0} of ${formatNumber(kpis?.utilization?.capacity ?? 0)} seats`}
          icon="activity"
          tone={utilizationTone}
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* 4. Fleet monitor + 5. Live scan feed                             */}
      {/* ---------------------------------------------------------------- */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel
          title="Fleet monitor"
          subtitle="Live occupancy & visitor head-count by bus"
          icon="bus"
          actions={
            <Link to="/fleet" className="text-[0.73rem] font-semibold text-sky-400 hover:underline">
              Manage fleet
            </Link>
          }
        >
          {fleet.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {fleet.map((bus) => (
                <FleetCard key={bus.id} bus={bus} />
              ))}
            </div>
          ) : (
            <EmptyState icon="bus" title="No buses registered" message="Add buses to begin monitoring occupancy." />
          )}
        </Panel>

        <Panel
          title="Live scan feed"
          subtitle={streamStatus === 'open' ? 'Streaming now' : 'Reconnecting…'}
          icon="wifi"
          actions={<LiveIndicator status={streamStatus} />}
          bodyClass="p-0"
        >
          <div className="max-h-[32rem] overflow-y-auto">
            {activity.length ? (
              <ul className="divide-y divide-[var(--border-subtle)]/60">
                {activity.slice(0, 30).map((row) => (
                  <li key={row.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                    <span
                      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                        row.outcome === 'VALID' ? 'bg-emerald-400' : 'bg-red-400'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.79rem] font-medium text-mist-200">
                        {row.studentName ?? row.rfidSerial}
                        {row.studentName ? (
                          <span className="ml-1.5 text-[0.7rem] font-normal text-mist-500">{row.collegeId}</span>
                        ) : null}
                      </p>
                      <p className="truncate text-[0.7rem] text-mist-500">{row.message}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <StatusBadge status={row.direction} label={row.direction === 'BOARD' ? 'In' : 'Out'} dot={false} />
                      <p className="tabular mt-0.5 text-[0.66rem] text-mist-500">{formatTime(row.scanTime)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="wifi" title="No scans yet" message="Live taps appear here as students board." />
            )}
          </div>
        </Panel>
      </div>

      {/* Visitor head-count summary chip row */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge tone="good">
          <Icon name="zap" className="mr-1 inline h-3 w-3" />
          {formatNumber(kpis?.visitors?.today ?? 0)} visitor presses today
        </Badge>
        <Tooltip label="Green-button presses counted per bus and Nepal calendar day.">
          <span className="text-[0.72rem] text-mist-500">Green-button head count</span>
        </Tooltip>
      </div>
    </>
  );
}

/**
 * Compact clickable tile in the operations row. Each one deep-links into a
 * workflow, so the dashboard is a launch pad rather than a dead-end report.
 */
function ActionCard({ to, icon, title, subtitle, tone = 'info' }) {
  const chip = {
    info: 'bg-sky-500/12 text-sky-400',
    good: 'bg-emerald-500/12 text-emerald-400',
    bad: 'bg-red-500/12 text-red-400',
    warn: 'bg-amber-500/12 text-amber-400',
    accent: 'bg-violet-500/12 text-violet-400',
  }[tone];

  return (
    <Link
      to={to}
      className="card group flex items-center gap-3 p-4 transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${chip}`}>
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.85rem] font-semibold text-mist-100">{title}</span>
        <span className="block truncate text-[0.72rem] text-mist-500">{subtitle}</span>
      </span>
      <Icon
        name="chevronRight"
        className="h-4 w-4 shrink-0 text-mist-500 transition group-hover:translate-x-0.5 group-hover:text-brand-500"
      />
    </Link>
  );
}
