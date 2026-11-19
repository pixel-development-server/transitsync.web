/**
 * Student portal.
 *
 * Route-centric and read-only: the rider browses every active campus route —
 * code, schedule, pickup stops and the shuttle running it — with no booking,
 * assignment or pass administration here. Those live in the operations
 * console.
 *
 * Operational status is time-based. A route only reads "Live" when the current
 * Nepal Standard Time (UTC+5:45) sits inside its departure→arrival window;
 * otherwise it reads "Offline" (window not open yet) or "Completed" (window
 * closed). The badge is re-evaluated on a timer and agrees with the API.
 *
 * The route list itself is an accordion: every card starts collapsed with just
 * its header (code, name, schedule, status) and expands on click to reveal its
 * pickup stops and buses while the other cards stay folded.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon } from '../../components/Icon.jsx';
import {
  Badge,
  BrandMark,
  EmptyState,
  ErrorState,
  OccupancyBar,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
} from '../../components/ui.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { useApi } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/format.js';
import { evaluateBusStatus, useBusStatusClock } from '../../utils/busStatus.js';

function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[0.75rem] text-mist-500">{label}</dt>
      <dd className={`min-w-0 text-right text-[0.82rem] font-medium text-mist-100 ${mono ? 'font-mono' : ''}`}>
        {value ?? '—'}
      </dd>
    </div>
  );
}

function Stat({ icon, label, value, sub, accent = false }) {
  return (
    <div className={`card flex items-center gap-3 p-3.5 ${accent ? 'ring-1 ring-sky-500/30' : ''}`}>
      <span
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ${
          accent ? 'bg-sky-500/20 text-sky-300 ring-sky-400/40' : 'bg-sky-500/12 text-sky-400 ring-sky-500/25'
        }`}
      >
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[0.7rem] font-semibold tracking-wider text-mist-500 uppercase">{label}</p>
        <p className={`truncate font-bold ${accent ? 'font-mono text-[1rem] text-sky-300' : 'text-[0.9rem] text-mist-100'}`}>
          {value}
        </p>
        {sub ? <p className="truncate text-[0.72rem] text-mist-500">{sub}</p> : null}
      </div>
    </div>
  );
}

/** Branded route/bus indicator: the app's `busicon.png` framed as a chip. */
function BusMark({ size = 30, className = '' }) {
  return <BrandMark size={size} rounded="rounded-lg" className={className} alt="" />;
}

/**
 * Time-based operational badge. `state` comes from the shared
 * `evaluateBusStatus()` classifier (Fleet / Live Monitor use the same one), so
 * a route only reads "Live" while the current NPT sits inside its window.
 */
const SCHEDULE_BADGE = {
  ACTIVE: { tone: 'good', label: 'Live' },
  COMPLETED: { tone: 'info', label: 'Completed' },
  UPCOMING: { tone: 'neutral', label: 'Offline' },
  SCHEDULED: { tone: 'neutral', label: 'Offline' },
  UNKNOWN: { tone: 'neutral', label: 'Offline' },
};

function ScheduleBadge({ state }) {
  const { tone, label } = SCHEDULE_BADGE[state] ?? SCHEDULE_BADGE.UNKNOWN;
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

/** One shuttle on a route: number, driver, occupancy and schedule state. */
function BusCard({ bus, state }) {
  return (
    <div className="rounded-xl bg-[var(--surface-raised)] p-3 ring-1 ring-[var(--border-subtle)]">
      <div className="flex items-center gap-2.5">
        <BusMark size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-mono text-[0.82rem] font-bold text-mist-100">{bus.code}</p>
            <StatusBadge status={bus.status} />
            {state && state !== 'ACTIVE' ? <ScheduleBadge state={state} /> : null}
          </div>
          <p className="truncate text-[0.72rem] text-mist-500">
            {bus.name ?? 'Campus shuttle'}
            {bus.registrationNo ? ` · ${bus.registrationNo}` : ''}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.72rem] text-mist-400">
        <span className="inline-flex min-w-0 items-center gap-1">
          <Icon name="user" className="h-3 w-3 shrink-0 text-mist-500" />
          <span className="truncate">{bus.driverName ?? 'No driver on file'}</span>
        </span>
        {bus.driverPhone ? (
          <a
            href={`tel:${bus.driverPhone}`}
            className="inline-flex items-center gap-1 text-sky-400 transition hover:text-sky-300"
          >
            <Icon name="phone" className="h-3 w-3" />
            <span className="tabular">{bus.driverPhone}</span>
          </a>
        ) : null}
      </div>

      <OccupancyBar occupancy={bus.occupancy} capacity={bus.seatCapacity} className="mt-2.5" />

      {bus.lastSeenAt ? (
        <div className="mt-2 flex items-center justify-end border-t border-[var(--border-subtle)] pt-2">
          <span className="shrink-0 text-[0.68rem] text-mist-500">Seen {formatDateTime(bus.lastSeenAt)}</span>
        </div>
      ) : null}
    </div>
  );
}

export default function StudentPortal() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi('/student/me');
  const { data: scheduleData, error: scheduleError, loading: scheduleLoading, reload: reloadSchedule } =
    useApi('/student/routes');

  // The route board and the rider's own state refresh quietly; occupancy moves
  // as Students scan on and off.
  useEffect(() => {
    const timer = setInterval(() => {
      reload({ silent: true });
      reloadSchedule({ silent: true });
    }, 20000);
    return () => clearInterval(timer);
  }, [reload, reloadSchedule]);

  // A route must flip Live→Completed the minute its window closes, so the NPT
  // clock is re-read on its own cadence rather than only on a data refresh.
  const { now } = useBusStatusClock();

  // One route open at a time (accordion); `null` = all collapsed.
  const [openRouteId, setOpenRouteId] = useState(null);

  const handleSignOut = useCallback(async () => {
    await signOut();
    navigate('/login', { replace: true });
  }, [signOut, navigate]);

  if (loading && !data) {
    return (
      <div className="grid min-h-dvh place-items-center bg-[var(--surface)]">
        <Spinner className="h-6 w-6 text-sky-400" />
      </div>
    );
  }

  const student = data?.student;
  const assignedRoute = data?.route;
  const pass = data?.pass;
  const live = data?.live;

  const routes = scheduleData?.routes ?? [];
  const statusOf = (route) =>
    evaluateBusStatus(
      { departureTime: route?.departureTime, arrivalTime: route?.arrivalTime },
      now,
    );
  const liveCount = routes.filter((route) => statusOf(route).state === 'ACTIVE').length;
  const busCount = routes.reduce((sum, route) => sum + (route.buses?.length ?? 0), 0);
  const riderCount = routes.reduce(
    (sum, route) => sum + (route.buses?.reduce((n, b) => n + (b.occupancy ?? 0), 0) ?? 0),
    0,
  );
  const assignedState = assignedRoute ? statusOf(assignedRoute).state : null;

  return (
    <div className="min-h-dvh bg-[var(--surface)]">
      <div className="aurora" aria-hidden="true" />

      {/* Top bar */}
      <header className="relative z-10 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)]/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <BrandMark size={36} rounded="rounded-xl" />
            <div className="leading-tight">
              <p className="text-[0.9rem] font-extrabold tracking-tight text-mist-100">TransitSync</p>
              <p className="text-[0.68rem] font-medium tracking-wide text-mist-500 uppercase">Students portal</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-[0.8rem] font-semibold text-mist-100">{user?.fullName ?? student?.fullName}</p>
              <p className="text-[0.68rem] text-mist-500">{student?.studentCode ?? 'Student'}</p>
            </div>
            <button type="button" onClick={handleSignOut} className="btn btn-ghost !px-3 !py-2 text-[0.78rem]">
              <Icon name="logout" className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-4xl space-y-5 px-4 py-6">
        {error ? (
          <ErrorState error={error} onRetry={() => reload()} />
        ) : (
          <>
            <PageHeader
              title={`Hello, ${user?.fullName?.split(' ')[0] ?? student?.fullName?.split(' ')[0] ?? 'Student'}`}
              subtitle={data?.college?.name ? `${data.college.name} · campus shuttle` : 'Campus shuttle'}
              breadcrumb="Student portal"
              actions={
                assignedRoute && live?.state !== 'ON_BOARD' ? (
                  <ScheduleBadge state={assignedState} />
                ) : live ? (
                  <Badge tone={live.tone ?? 'neutral'} dot>
                    {live.label}
                  </Badge>
                ) : null
              }
            />

            {/* Essential metrics only: the rider's identity and the route board
                roll-up. No "not assigned" placeholders. */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                accent
                icon="students"
                label="Student ID"
                value={student?.studentCode ?? '—'}
                sub={pass ? `Pass · ${pass.cardStatus ?? 'Issued'}` : student?.program ?? undefined}
              />
              <Stat
                icon="route"
                label="Routes"
                value={scheduleData ? String(routes.length) : '—'}
                sub={scheduleData ? `${liveCount} live now` : 'Loading…'}
              />
              <Stat
                icon="bus"
                label="Shuttles"
                value={scheduleData ? String(busCount) : '—'}
                sub="on campus routes"
              />
              <Stat
                icon="activity"
                label="Riders aboard"
                value={scheduleData ? String(riderCount) : '—'}
                sub="scanned on now"
              />
            </div>

            {/* Campus routes & buses — a collapsed-by-default accordion. Header
                rows show code, name, schedule and the NPT-aware status badge;
                clicking one expands its stops and buses and folds the rest. */}
            <Panel
              title="Campus Routes & Buses"
              subtitle="Every active campus route. Tap a route to see its pickup stops and the shuttle running it."
              icon="route"
              actions={
                <Badge tone="accent" dot>
                  {routes.length} routes
                </Badge>
              }
            >
              {scheduleLoading && !scheduleData ? (
                <div className="flex justify-center py-10">
                  <Spinner className="h-6 w-6 text-sky-400" />
                </div>
              ) : scheduleError ? (
                <ErrorState error={scheduleError} onRetry={reloadSchedule} />
              ) : routes.length ? (
                <div className="space-y-3">
                  {routes.map((route) => {
                    const state = statusOf(route).state;
                    const open = openRouteId === route.id;
                    return (
                      <article key={route.id} className="card overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setOpenRouteId(open ? null : route.id)}
                          aria-expanded={open}
                          className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-[var(--surface-raised)]"
                        >
                          <BusMark size={34} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-[0.8rem] font-bold tracking-wide text-sky-400 uppercase">
                                {route.code}
                              </span>
                              {route.isMine ? <Badge tone="accent">Your route</Badge> : null}
                            </div>
                            <p className="truncate text-[0.9rem] font-semibold text-mist-100">{route.name}</p>
                            <p className="mt-0.5 truncate text-[0.72rem] text-mist-500">
                              {route.shift}
                              <span className="mx-1.5 text-mist-600">·</span>
                              {route.departureTime} – {route.arrivalTime}
                              <span className="mx-1.5 text-mist-600">·</span>
                              {route.stopCount ?? route.stops?.length ?? 0} stops
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <ScheduleBadge state={state} />
                            <Icon
                              name={open ? 'chevronUp' : 'chevronDown'}
                              className="h-4 w-4 text-mist-500"
                            />
                          </div>
                        </button>

                        <div
                          className={`grid transition-all duration-150 ease-out ${
                            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                          }`}
                          aria-hidden={!open}
                        >
                          <div className="overflow-hidden">
                            <div className="border-t border-[var(--border-subtle)] p-4">
                              <p className="mb-3 text-[0.74rem] text-mist-500">
                                {route.startPoint} → {route.endPoint}
                                {route.description ? (
                                  <>
                                    <span className="mx-1.5 text-mist-600">·</span>
                                    {route.description}
                                  </>
                                ) : null}
                              </p>

                              <div className="grid gap-4 sm:grid-cols-2">
                                <div>
                                  <p className="mb-1.5 text-[0.68rem] font-semibold tracking-wider text-mist-500 uppercase">
                                    Pickup stops
                                  </p>
                                  {route.stops?.length ? (
                                    <ol className="space-y-1">
                                      {route.stops.map((stop) => (
                                        <li
                                          key={stop.sequence}
                                          className="flex items-center gap-2 text-[0.8rem] text-mist-300"
                                        >
                                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-sky-500/12 text-[0.62rem] font-bold text-sky-400">
                                            {stop.sequence}
                                          </span>
                                          <span className="min-w-0 flex-1 truncate">{stop.name}</span>
                                          {stop.scheduledTime ? (
                                            <span className="shrink-0 font-mono text-[0.72rem] text-mist-500">
                                              {stop.scheduledTime}
                                            </span>
                                          ) : null}
                                        </li>
                                      ))}
                                    </ol>
                                  ) : (
                                    <p className="text-[0.78rem] text-mist-500">No stops recorded for this route.</p>
                                  )}
                                </div>

                                <div>
                                  <p className="mb-1.5 text-[0.68rem] font-semibold tracking-wider text-mist-500 uppercase">
                                    Buses on this route
                                  </p>
                                  {route.buses?.length ? (
                                    <div className="space-y-2.5">
                                      {route.buses.map((bus) => (
                                        <BusCard key={bus.id} bus={bus} state={state} />
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-[0.78rem] text-mist-500">
                                      No bus assigned to this route right now.
                                    </p>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  icon="route"
                  title="No active routes right now"
                  message="Routes will appear here once the transport office provisions them."
                />
              )}
            </Panel>

            <Panel title="Live status" icon="wifi">
              <div className="flex items-center gap-2">
                {live ? (
                  <Badge tone={live.tone ?? 'neutral'} dot>
                    {live.label}
                  </Badge>
                ) : null}
                {live?.since ? (
                  <span className="text-[0.75rem] text-mist-500">as of {formatDateTime(live.since)}</span>
                ) : null}
              </div>
              {live?.lastScan ? (
                <dl className="mt-3 divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                  <Row label="Last scan" value={formatDateTime(live.lastScan.at)} />
                  <Row label="Direction" value={live.lastScan.direction} />
                  <Row label="Outcome" value={live.lastScan.outcome} />
                  <Row
                    label="Bus"
                    value={live.lastScan.busCode ?? live.lastScan.busName ?? null}
                    mono={Boolean(live.lastScan.busCode)}
                  />
                  {live.lastScan.gate ? <Row label="Gate" value={live.lastScan.gate} /> : null}
                </dl>
              ) : (
                <p className="mt-2 text-[0.8rem] text-mist-500">
                  No boarding activity recorded yet. Tap your card at the gate to begin.
                </p>
              )}
            </Panel>
          </>
        )}
      </main>
    </div>
  );
}
