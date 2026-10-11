/**
 * Student rider portal (read-only).
 *
 * A pre-authorized student signs in here to see a single thing: their own
 * assigned route, the bus and driver on it, the scheduled departure, and a live
 * badge for where they are in the journey. There are no controls — every action
 * lives in the operations console.
 */

import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon } from '../../components/Icon.jsx';
import { Badge, ErrorState, PageHeader, Panel, Spinner, StatusBadge } from '../../components/ui.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { useApi } from '../../lib/hooks.js';
import { formatDateTime } from '../../lib/format.js';

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

function Stat({ icon, label, value, sub }) {
  return (
    <div className="card flex items-center gap-3 p-3.5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-sky-500/12 text-sky-400 ring-1 ring-sky-500/25">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[0.7rem] font-semibold tracking-wider text-mist-500 uppercase">{label}</p>
        <p className="truncate text-[0.9rem] font-bold text-mist-100">{value}</p>
        {sub ? <p className="truncate text-[0.72rem] text-mist-500">{sub}</p> : null}
      </div>
    </div>
  );
}

export default function StudentPortal() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi('/student/me');

  // Live status is worth a gentle refresh without a manual action.
  useEffect(() => {
    const timer = setInterval(() => reload({ silent: true }), 20000);
    return () => clearInterval(timer);
  }, [reload]);

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
  const route = data?.route;
  const bus = data?.bus;
  const pass = data?.pass;
  const live = data?.live;

  return (
    <div className="min-h-dvh bg-[var(--surface)]">
      <div className="aurora" aria-hidden="true" />

      {/* Top bar */}
      <header className="relative z-10 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)]/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/25">
              <Icon name="bus" className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <p className="text-[0.9rem] font-extrabold tracking-tight text-mist-100">TransitSync</p>
              <p className="text-[0.68rem] font-medium tracking-wide text-mist-500 uppercase">Rider portal</p>
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
              title={`Hello, ${student?.fullName?.split(' ')[0] ?? 'rider'}`}
              subtitle={data?.college?.name ? `${data.college.name} · campus shuttle` : 'Campus shuttle'}
              breadcrumb="Rider portal"
              actions={live ? <Badge tone={live.tone ?? 'neutral'} dot>{live.label}</Badge> : null}
            />

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                icon="route"
                label="Route"
                value={route ? route.code ?? route.name : 'Not assigned'}
                sub={route?.shift ?? route?.name}
              />
              <Stat
                icon="bus"
                label="Bus"
                value={bus ? bus.code ?? bus.name : 'Not assigned'}
                sub={bus?.driverName ? `Driver · ${bus.driverName}` : 'No driver on file'}
              />
              <Stat
                icon="activity"
                label="Departure"
                value={route?.departureTime ?? '—'}
                sub={route?.arrivalTime ? `Arrives ${route.arrivalTime}` : route?.shift}
              />
              <Stat
                icon="students"
                label="Student ID"
                value={student?.studentCode ?? '—'}
                sub={student?.program ?? student?.faculty ?? undefined}
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Panel title="Assigned route" subtitle={route ? route.name : 'Not assigned yet'} icon="route">
                {route ? (
                  <dl className="divide-y divide-[var(--border-subtle)]">
                    <Row label="Route code" value={route.code} mono />
                    <Row label="Shift" value={route.shift} />
                    <Row label="Departure" value={route.departureTime} />
                    <Row label="Arrival" value={route.arrivalTime} />
                    <Row label="From" value={route.startPoint} />
                    <Row label="To" value={route.endPoint} />
                    {student?.pickupStop ? <Row label="Your stop" value={student.pickupStop} /> : null}
                    {route.stops?.length ? (
                      <div className="pt-2">
                        <p className="mb-1 text-[0.75rem] text-mist-500">Stops</p>
                        <ol className="space-y-1">
                          {route.stops.map((stop) => (
                            <li key={stop.sequence} className="flex items-center gap-2 text-[0.8rem] text-mist-300">
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
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p className="py-6 text-center text-[0.82rem] text-mist-500">
                    Your route has not been assigned yet. Contact your college transport office.
                  </p>
                )}
              </Panel>

              <div className="space-y-5">
                <Panel title="Active bus &amp; driver" icon="bus">
                  {bus ? (
                    <dl className="divide-y divide-[var(--border-subtle)]">
                      <Row label="Bus" value={`${bus.code ?? bus.name}`} mono />
                      <Row label="Registration" value={bus.registrationNo} mono />
                      <Row label="Driver" value={bus.driverName} />
                      <Row label="Driver phone" value={bus.driverPhone} mono />
                      <Row label="Capacity" value={bus.seatCapacity ? `${bus.seatCapacity} seats` : null} />
                      <Row label="Bus status" value={<StatusBadge status={bus.status} />} />
                    </dl>
                  ) : (
                    <p className="py-6 text-center text-[0.82rem] text-mist-500">
                      No bus is assigned to your route right now.
                    </p>
                  )}
                </Panel>

                <Panel title="Rider pass" icon="shield">
                  {pass ? (
                    <dl className="divide-y divide-[var(--border-subtle)]">
                      <Row label="Pass number" value={pass.number} mono />
                      <Row label="Valid from" value={pass.validFrom} />
                      <Row label="Valid to" value={pass.validTo} />
                      <Row label="Card status" value={<StatusBadge status={pass.cardStatus} />} />
                    </dl>
                  ) : (
                    <p className="py-6 text-center text-[0.82rem] text-mist-500">No rider pass on file.</p>
                  )}
                </Panel>
              </div>
            </div>

            <Panel title="Live status" icon="wifi">
              <div className="flex items-center gap-2">
                {live ? <Badge tone={live.tone ?? 'neutral'} dot>{live.label}</Badge> : null}
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
