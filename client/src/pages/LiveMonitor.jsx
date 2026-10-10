import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon.jsx';
import {
  Badge,
  EmptyState,
  LiveIndicator,
  OccupancyBar,
  PageHeader,
  Panel,
  StatCard,
  StatusBadge,
} from '../components/ui.jsx';
import { copyText, useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useEventStream } from '../lib/stream.js';
import { useToast } from '../lib/toast.jsx';
import { formatNumber, formatTime } from '../lib/format.js';

/** Severity palette for a live event, shared by the feed and the counters. */
const OUTCOME_STYLE = {
  VALID: { dot: 'bg-emerald-400', badge: 'good', label: 'Accepted' },
  UNREGISTERED_BUS: { dot: 'bg-red-400', badge: 'bad', label: 'Wrong bus' },
  UNREGISTERED_CARD: { dot: 'bg-violet-400', badge: 'accent', label: 'Unknown card' },
  CAPACITY_EXCEEDED: { dot: 'bg-amber-400', badge: 'warn', label: 'Bus full' },
  SYSTEM: { dot: 'bg-slate-400', badge: 'neutral', label: 'System' },
};

/**
 * Full-screen live operations monitor.
 *
 * Deliberately does *not* poll. Every row arrives over SSE, so this page costs
 * one long-lived connection regardless of fleet size — which is the whole point
 * of choosing SSE on the server side.
 */
export default function LiveMonitor() {
  const { can } = useAuth();
  const toast = useToast();

  const [events, setEvents] = useState([]);
  const [occupancy, setOccupancy] = useState(null);
  const [visitorRows, setVisitorRows] = useState({});
  const [filter, setFilter] = useState('all');
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(null);

  // While paused the stream stays connected and events land in `buffered` state
  // (a ref would force a render-time read to show the count). Nothing is lost.
  const [buffered, setBuffered] = useState([]);
  const pausedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const { data: dashboard } = useApi('/dashboard', { enabled: can('dashboard:read') });

  const { status } = useEventStream({
    onEvent: useCallback(
      (event, payload) => {
        if (event === 'scan' || event === 'activity') {
          const row = { ...payload, _receivedAt: Date.now() };
          if (pausedRef.current) {
            setBuffered((current) => [row, ...current].slice(0, 200));
          } else {
            setEvents((current) => [row, ...current].slice(0, 200));
          }
        } else if (event === 'visitor' && payload) {
          // The server broadcasts the *rolled-up* counter for a bus/route/day, so
          // keep the latest row per scope and surface it both as a KPI and as a
          // feed entry. The delta between successive frames is the press itself.
          setVisitorRows((current) => ({ ...current, [payload.id]: payload }));
          const row = { ...payload, _kind: 'visitor', _receivedAt: Date.now() };
          if (pausedRef.current) {
            setBuffered((current) => [row, ...current].slice(0, 200));
          } else {
            setEvents((current) => [row, ...current].slice(0, 200));
          }
        } else if (event === 'occupancy' && payload) {
          setOccupancy(payload);
        } else if (event === 'alert') {
          toast.warning(payload?.title ? `Alert: ${payload.title}` : 'New alert raised', { duration: 6000 });
        }
      },
      [toast],
    ),
  });

  // Backfill the feed so the page is not empty before the first tap.
  useEffect(() => {
    if (events.length || !dashboard?.activity?.length) return;
    setEvents(dashboard.activity.slice(0, 60).map((row) => ({ ...row, _backfill: true })));
  }, [dashboard, events.length]);

  const resume = () => {
    setEvents((current) => [...buffered, ...current].slice(0, 200));
    setBuffered([]);
    setPaused(false);
  };

  const visible = useMemo(() => {
    if (filter === 'all') return events;
    if (filter === 'visitors') return events.filter((row) => row._kind === 'visitor');
    if (filter === 'rejected') return events.filter((row) => row._kind !== 'visitor' && row.outcome !== 'VALID');
    if (filter === 'revenue') return events.filter((row) => row._kind !== 'visitor' && row.direction === 'BOARD');
    if (filter === 'outbound') return events.filter((row) => row._kind !== 'visitor' && row.direction === 'DEBOARD');
    return events;
  }, [events, filter]);

  const counts = useMemo(() => {
    const tally = { VALID: 0, rejected: 0, boards: 0 };
    for (const row of events) {
      if (row._kind === 'visitor') continue; // head counts are not scans
      if (row.outcome === 'VALID') tally.VALID += 1;
      else tally.rejected += 1;
      if (row.direction === 'BOARD') tally.boards += 1;
    }
    return tally;
  }, [events]);

  // Sum the latest counter from every bus/route scope seen this session.
  const visitorTotal = useMemo(
    () => Object.values(visitorRows).reduce((sum, row) => sum + (row.count ?? 0), 0),
    [visitorRows],
  );
  const visitorBreakdown = useMemo(
    () => Object.values(visitorRows).sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    [visitorRows],
  );

  const copyLog = async () => {
    const text = visible
      .map((row) =>
        row._kind === 'visitor'
          ? `${formatTime(row.lastAt)} VISITOR ${row.count} ${row.busCode ?? ''} ${row.routeCode ?? ''} — head count`
          : `${formatTime(row.scanTime)} ${row.outcome} ${row.direction} ${row.studentName ?? row.rfidSerial} ${row.busCode ?? ''} — ${row.message}`,
      )
      .join('\n');

    const ok = await copyText(text);
    if (ok) {
      setCopied('log');
      setTimeout(() => setCopied(null), 2000);
      toast.success('Event log copied to the clipboard.');
    } else {
      toast.error('Could not copy the log. Your browser blocked clipboard access.');
    }
  };

  const buses = dashboard?.fleet ?? [];
  const streamLabel = paused
    ? 'Paused'
    : status === 'open'
      ? 'Streaming'
      : status === 'connecting'
        ? 'Reconnecting'
        : 'Offline';

  return (
    <>
      <PageHeader
        title="Live Monitor"
        subtitle="Real-time RFID reader events across the fleet"
        actions={
          <>
            <LiveIndicator status={paused ? 'idle' : status} label={streamLabel} />
            <button type="button" className="btn btn-ghost" onClick={copyLog}>
              <Icon name={copied === 'log' ? 'copyCheck' : 'copy'} className="h-3.5 w-3.5" />
              {copied === 'log' ? 'Copied' : 'Copy log'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEvents([])} disabled={!events.length}>
              <Icon name="trash" className="h-3.5 w-3.5" />
              Clear
            </button>
            {paused ? (
              <button type="button" className="btn btn-primary" onClick={resume}>
                <Icon name="refresh" className="h-3.5 w-3.5" />
                Resume
                {buffered.length ? ` (${buffered.length})` : ''}
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" onClick={() => setPaused(true)}>
                <Icon name="clock" className="h-3.5 w-3.5" />
                Pause
              </button>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Events this session" value={events.length} icon="activity" tone="info" />
        <StatCard label="Accepted" value={counts.VALID} icon="check" tone="good" />
        <StatCard
          label="Rejected"
          value={counts.rejected}
          icon="alert"
          tone={counts.rejected > 0 ? 'bad' : 'good'}
        />
        <StatCard label="Boards" value={counts.boards} icon="login" tone="accent" />
        <StatCard label="Visitors today" value={visitorTotal} icon="user" tone="warn" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1.05fr)_minmax(0,1fr)]">
        {/* Feed */}
        <Panel
          title="Event stream"
          subtitle={paused ? 'Paused — events are being buffered' : `${visible.length} shown`}
          icon="wifi"
          bodyClass="p-0"
          actions={
            <div className="flex flex-wrap gap-1">
              {[
                { value: 'all', label: 'All' },
                { value: 'rejected', label: 'Rejected' },
                { value: 'revenue', label: 'Boards' },
                { value: 'outbound', label: 'Alights' },
                { value: 'visitors', label: 'Visitors' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={`chip ring-1 transition ${
                    filter === option.value
                      ? 'bg-sky-500/18 text-sky-300 ring-sky-500/45'
                      : 'text-mist-500 ring-[var(--border-subtle)] hover:text-mist-300'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        >
          <div className="max-h-[36rem] overflow-y-auto">
            {visible.length ? (
              <ul className="divide-y divide-[var(--border-subtle)]/60">
                {visible.map((row) => {
                  if (row._kind === 'visitor') {
                    const isNew = !row._backfill;
                    return (
                      <li
                        key={`visitor-${row.id}-${row.count}-${row._receivedAt}`}
                        className={`flex items-start gap-3 px-3.5 py-2.5 ${isNew ? 'ts-flash' : ''}`}
                      >
                        <span className="mt-1.5 grid h-2 w-2 shrink-0 place-items-center rounded-full bg-amber-400" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <p className="truncate text-[0.82rem] font-semibold text-mist-100">
                              Visitor head count
                            </p>
                            <Badge tone="warn">
                              #{row.count}
                            </Badge>
                            {row.busCode ? (
                              <span className="text-[0.7rem] text-mist-500">
                                {row.busCode}
                                {row.routeCode ? ` · ${row.routeCode}` : ''}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-[0.73rem] text-mist-400">
                            Green button pressed{row.deviceId ? ` on ${row.deviceId}` : ''}.
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="tabular text-[0.78rem] font-semibold text-mist-300">
                            {formatTime(row.lastAt)}
                          </p>
                          <p className="text-[0.66rem] text-mist-500">NPT</p>
                        </div>
                      </li>
                    );
                  }

                  const style = OUTCOME_STYLE[row.outcome] ?? OUTCOME_STYLE.SYSTEM;
                  return (
                    <li
                      key={row.id ?? `${row._receivedAt}-${row.rfidSerial}`}
                      className={`flex items-start gap-3 px-3.5 py-2.5 ${row._backfill ? '' : 'ts-flash'}`}
                    >
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <p className="truncate text-[0.82rem] font-semibold text-mist-100">
                            {row.studentName ?? row.rfidSerial}
                          </p>
                          {row.studentName ? (
                            <span className="tabular text-[0.7rem] text-mist-500">{row.collegeId}</span>
                          ) : (
                            <Badge tone="accent">Unregistered</Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-[0.73rem] text-mist-400">{row.message}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <StatusBadge status={row.outcome} label={style.label} dot={false} />
                          <span className="text-[0.68rem] text-mist-500">
                            {row.direction === 'BOARD' ? 'Boarding' : 'Alighting'} · {row.busCode ?? 'no bus'}
                            {row.routeCode ? ` · ${row.routeCode}` : ''}
                            {row.gate ? ` · ${row.gate}` : ''}
                          </span>
                        </div>
                      </div>

                      <div className="shrink-0 text-right">
                        <p className="tabular text-[0.78rem] font-semibold text-mist-300">{formatTime(row.scanTime)}</p>
                        {typeof row.occupancy === 'number' ? (
                          <p className="tabular text-[0.68rem] text-mist-500">
                            {row.occupancy}/{row.capacity} aboard
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                icon="wifi"
                title={paused ? 'Stream paused' : 'Waiting for reader events'}
                message={
                  paused
                    ? 'The stream is still connected. Resume to flush the buffered events into the feed.'
                    : 'Events appear here the moment an RFID tag is presented. Use the simulator to generate traffic.'
                }
              />
            )}
          </div>
        </Panel>

        {/* Fleet occupancy */}
        <div className="space-y-4">
          <Panel title="Occupancy now" subtitle="Live seat usage by bus" icon="bus">
            {buses.length ? (
              <ul className="space-y-3">
                {buses.map((bus) => {
                  // A live occupancy frame wins over the periodic dashboard snapshot.
                  const live =
                    occupancy && String(occupancy.busId ?? occupancy.bus_id) === String(bus.id)
                      ? occupancy.occupancy ?? occupancy.occupancyAfter
                      : bus.occupancy;

                  return (
                    <li key={bus.id}>
                      <div className="mb-1 flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: bus.route?.color ?? '#38bdf8' }}
                            aria-hidden="true"
                          />
                          <span className="truncate text-[0.8rem] font-semibold text-mist-200">{bus.code}</span>
                          <span className="truncate text-[0.7rem] text-mist-500">{bus.name}</span>
                        </span>
                        <StatusBadge status={bus.status} dot={false} />
                      </div>
                      <OccupancyBar occupancy={live ?? 0} capacity={bus.seatCapacity ?? 0} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon="bus" title="No fleet data" />
            )}
          </Panel>

          <Panel title="Visitor counts" subtitle="Green button · head count" icon="user">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="tabular text-3xl font-bold tracking-tight text-mist-100">
                  {formatNumber(visitorTotal)}
                </p>
                <p className="text-[0.7rem] text-mist-500">presses today (NPT)</p>
              </div>
              <Badge tone="warn" icon="user">
                Live
              </Badge>
            </div>
            {visitorBreakdown.length ? (
              <ul className="space-y-2">
                {visitorBreakdown.map((row) => (
                  <li key={row.id} className="flex items-center gap-2.5">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[0.78rem] text-mist-300">
                      {row.busCode ?? 'Unassigned bus'}
                      {row.routeCode ? ` · ${row.routeCode}` : ''}
                    </span>
                    <Badge tone="warn">{formatNumber(row.count)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.78rem] text-mist-500">
                No visitor presses yet today. Press the green button on the reader to count one.
              </p>
            )}
          </Panel>
        </div>

        {/* Right rail: outcome mix + stream health */}
        <div className="space-y-4">
          <Panel title="Outcome mix" subtitle="This session" icon="activity">
            <ul className="space-y-2">
              {Object.entries(OUTCOME_STYLE).map(([outcome, style]) => {
                const count = events.filter((row) => row.outcome === outcome).length;
                if (!count) return null;
                return (
                  <li key={outcome} className="flex items-center gap-2.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-[0.78rem] text-mist-300">{style.label}</span>
                    <Badge tone={style.badge}>{formatNumber(count)}</Badge>
                  </li>
                );
              })}
              {!events.length ? <li className="text-[0.78rem] text-mist-500">No events yet.</li> : null}
            </ul>
          </Panel>

          <Panel title="Stream health" icon="activity">
            <dl className="grid grid-cols-2 gap-2 text-[0.76rem]">
              <div className="rounded-lg bg-[var(--surface-sunken)] px-3 py-2">
                <dt className="text-[0.66rem] tracking-wide text-mist-500 uppercase">Subscribers</dt>
                <dd className="tabular font-bold text-mist-200">
                  {formatNumber(dashboard?.realtime?.subscribers ?? 0)}
                </dd>
              </div>
              <div className="rounded-lg bg-[var(--surface-sunken)] px-3 py-2">
                <dt className="text-[0.66rem] tracking-wide text-mist-500 uppercase">Buffered</dt>
                <dd className="tabular font-bold text-mist-200">{buffered.length}</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}
