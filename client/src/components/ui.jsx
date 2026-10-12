/**
 * Shared presentational primitives: badges, status pills, KPI cards, tables,
 * pagination, empty/loading states and modals.
 *
 * Status → colour mapping is centralised here (and driven by the same vocabulary
 * the server uses) so "SUSPENDED" or "CRITICAL" is never styled two ways in two
 * different pages.
 */

import { useEffect, useRef, useState } from 'react';

import { Icon } from './Icon.jsx';
import { formatNumber } from '../lib/format.js';

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

const TONES = {
  good: 'bg-emerald-500/12 text-emerald-400 ring-emerald-500/25',
  warn: 'bg-amber-500/12 text-amber-400 ring-amber-500/25',
  bad: 'bg-red-500/12 text-red-400 ring-red-500/25',
  info: 'bg-sky-500/12 text-sky-400 ring-sky-500/25',
  accent: 'bg-violet-500/12 text-violet-400 ring-violet-500/25',
  neutral: 'bg-slate-500/12 text-slate-400 ring-slate-500/25',
};

export function Badge({ tone = 'neutral', children, className = '', dot = false, icon }) {
  return (
    <span className={`chip ring-1 ${TONES[tone] ?? TONES.neutral} ${className}`}>
      {dot ? (
        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {icon ? <Icon name={icon} className="h-3 w-3" /> : null}
      {children}
    </span>
  );
}

/** Map a domain status/enum string onto a badge tone + label. */
export function StatusBadge({ status, label, dot = true }) {
  const key = String(status ?? '').toUpperCase();
  const map = {
    // students
    ACTIVE: 'good', SUSPENDED: 'bad', GRADUATED: 'info', WITHDRAWN: 'neutral',
    // rfid
    BLOCKED: 'bad', LOST: 'warn', UNASSIGNED: 'neutral',
    // fleet
    MAINTENANCE: 'warn', RETIRED: 'neutral',
    // alerts
    OPEN: 'bad', ACKNOWLEDGED: 'warn', RESOLVED: 'good', DISMISSED: 'neutral',
    // severity
    CRITICAL: 'bad', HIGH: 'warn', MEDIUM: 'info', LOW: 'neutral',
    // scan outcomes
    VALID: 'good', INVALID: 'bad', EXPIRED: 'warn',
    UNREGISTERED_BUS: 'bad', UNREGISTERED_CARD: 'accent',
    CAPACITY_EXCEEDED: 'warn', SYSTEM: 'neutral',
    // directions
    BOARD: 'info', DEBOARD: 'neutral',
    // roles / modes
    INHERIT: 'info', CUSTOM: 'accent',
    MORNING: 'info', EVENING: 'accent', BOTH: 'good',
  };

  return (
    <Badge tone={map[key] ?? 'neutral'} dot={dot}>
      {label ?? String(status ?? '—').replace(/_/g, ' ')}
    </Badge>
  );
}

export function SeverityBadge({ severity }) {
  const key = String(severity ?? '').toUpperCase();
  const tone = { CRITICAL: 'bad', HIGH: 'warn', MEDIUM: 'info', LOW: 'neutral', INFO: 'neutral' }[key] ?? 'neutral';
  return (
    <Badge tone={tone} dot>
      {key || '—'}
    </Badge>
  );
}

/**
 * Colour-coded alert taxonomy tag. The `tag` slug comes from the server's
 * ALERT_TYPES registry, so a new alert kind is styled the moment the backend
 * defines it — an unknown slug degrades to a neutral pill rather than breaking.
 */
const ALERT_TAG_TONES = {
  'invalid-card': 'bad',
  'unregistered-device': 'bad',
  'unauthorized-route': 'warn',
  'expired-pass': 'warn',
  'capacity-exceeded': 'accent',
  system: 'info',
};

export function AlertTypeTag({ tag, label, className = '' }) {
  return (
    <Badge tone={ALERT_TAG_TONES[tag] ?? 'neutral'} className={className}>
      {label ?? tag ?? 'Notice'}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

export function StatCard({ label, value, sub, icon, tone = 'info', trend, loading = false, className = '' }) {
  const accent = {
    info: 'text-sky-400 bg-sky-500/10 ring-sky-500/20',
    good: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20',
    warn: 'text-amber-400 bg-amber-500/10 ring-amber-500/20',
    bad: 'text-red-400 bg-red-500/10 ring-red-500/20',
    accent: 'text-violet-400 bg-violet-500/10 ring-violet-500/20',
  }[tone] ?? 'text-sky-400 bg-sky-500/10 ring-sky-500/20';

  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.7rem] font-semibold tracking-[0.06em] text-mist-500 uppercase">{label}</p>
        {icon ? (
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1 ${accent}`}>
            <Icon name={icon} className="h-4 w-4" />
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-2.5 h-8 w-20 animate-pulse rounded bg-ink-700/60" />
      ) : (
        <p className="tabular mt-1.5 text-2xl font-bold tracking-tight text-mist-100">
          {typeof value === 'number' ? formatNumber(value) : (value ?? '—')}
        </p>
      )}

      <div className="mt-1 flex items-center gap-2 text-[0.72rem]">
        {trend ? (
          <span className={`inline-flex items-center gap-0.5 font-semibold ${trend.dir === 'up' ? 'text-emerald-400' : trend.dir === 'down' ? 'text-red-400' : 'text-mist-400'}`}>
            <Icon name={trend.dir === 'down' ? 'trendingDown' : 'trendingUp'} className="h-3 w-3" />
            {trend.value}
          </span>
        ) : null}
        {sub ? <span className="truncate text-mist-500">{sub}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel / section wrapper
// ---------------------------------------------------------------------------

export function Panel({ title, subtitle, actions, children, className = '', bodyClass = 'p-4', icon }) {
  return (
    <section className={`card overflow-hidden ${className}`}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {icon ? <Icon name={icon} className="h-4 w-4 shrink-0 text-mist-500" /> : null}
            <div className="min-w-0">
              <h2 className="truncate text-[0.9rem] font-bold text-mist-100">{title}</h2>
              {subtitle ? <p className="truncate text-[0.73rem] text-mist-500">{subtitle}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumb }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-1 text-[0.7rem] text-mist-500">{breadcrumb}</div> : null}
        <h1 className="text-xl font-bold tracking-tight text-mist-100 sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[0.82rem] text-mist-400">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Loading / empty / error states
// ---------------------------------------------------------------------------

export function Spinner({ className = 'h-5 w-5' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function LoadingBlock({ label = 'Loading…', className = 'py-10' }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2.5 text-mist-500 ${className}`} role="status">
      <Spinner className="h-6 w-6 text-sky-400" />
      <p className="text-[0.8rem]">{label}</p>
    </div>
  );
}

export function SkeletonRows({ rows = 6, cols = 5 }) {
  return (
    <div className="space-y-2 p-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: cols }).map((__, colIndex) => (
            <div
              key={colIndex}
              className="h-4 animate-pulse rounded bg-ink-700/50"
              style={{ flex: colIndex === 0 ? '1.4' : '1', animationDelay: `${(rowIndex * cols + colIndex) * 40}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'search', title, message, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2.5 px-6 py-12 text-center ${className}`}>
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-ink-800 text-mist-500 ring-1 ring-[var(--border-subtle)]">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <p className="text-[0.88rem] font-semibold text-mist-200">{title}</p>
      {message ? <p className="max-w-sm text-[0.8rem] leading-relaxed text-mist-500">{message}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className = '' }) {
  const code = error?.code;
  // A 403 means the user simply lacks the permission — framing that as an
  // error is misleading, so show it as an access notice instead.
  if (code === 'FORBIDDEN') {
    return (
      <EmptyState
        icon="lock"
        title="You do not have access to this view"
        message="Your role does not include the permission required for this page. Ask an administrator to grant it."
        className={className}
      />
    );
  }

  return (
    <EmptyState
      icon="alert"
      title="Could not load this data"
      message={error?.message || 'An unexpected error occurred.'}
      action={
        onRetry ? (
          <button type="button" className="btn btn-ghost" onClick={onRetry}>
            <Icon name="refresh" className="h-3.5 w-3.5" />
            Try again
          </button>
        ) : null
      }
      className={className}
    />
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/**
 * DataTable driven by a column spec.
 *
 * `columns[i].render(row)` returns the cell; `key` is the React key. `onSort`
 * is invoked with `{ key, direction }` and the parent owns the sort state — the
 * table stays stateless so pagination and sorting can be driven by the URL or
 * the API query.
 */
export function DataTable({
  columns,
  rows,
  rowKey = (row) => row.id,
  loading = false,
  skeletonRows = 8,
  empty,
  onSort,
  sort,
  onRowClick,
  rowClassName,
  stickyHeader = true,
}) {
  if (loading) return <SkeletonRows rows={skeletonRows} cols={columns.length} />;
  if (!rows?.length) return empty ?? <EmptyState title="Nothing to show" />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead className={stickyHeader ? 'sticky top-0 z-10 bg-[var(--surface-raised)]' : ''}>
          <tr className="border-b border-[var(--border-subtle)]">
            {columns.map((column) => {
              const sortable = Boolean(column.sortKey && onSort);
              const active = sortable && sort?.key === column.sortKey;

              return (
                <th
                  key={column.key}
                  className={`th ${column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : ''}`}
                  aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1 transition hover:text-mist-200 ${active ? 'text-sky-400' : ''}`}
                      onClick={() =>
                        onSort({
                          key: column.sortKey,
                          direction: active && sort.direction === 'asc' ? 'desc' : 'asc',
                        })
                      }
                    >
                      {column.label}
                      <Icon
                        name={active ? (sort.direction === 'asc' ? 'chevronUp' : 'chevronDown') : 'arrowUpDown'}
                        className={`h-3 w-3 ${active ? '' : 'opacity-40'}`}
                      />
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-[var(--border-subtle)]/60 transition last:border-0 hover:bg-brand-500/[0.06] ${onRowClick ? 'cursor-pointer' : ''} ${rowClassName?.(row) ?? ''}`}
            >
              {columns.map((column) => (
                <td key={column.key} className={`td ${column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : ''} ${column.nowrap ? 'whitespace-nowrap' : ''} ${column.className ?? ''}`}>
                  {column.render ? column.render(row, index) : row[column.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function Pagination({ meta, limit, onLimitChange, onPageChange }) {
  if (!meta) return null;
  const { page, totalPages, total, hasPrev, hasNext } = meta;

  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-4 py-2.5">
      <p className="text-[0.75rem] text-mist-500">
        Showing <span className="tabular font-semibold text-mist-300">{from}</span>–
        <span className="tabular font-semibold text-mist-300">{to}</span> of{' '}
        <span className="tabular font-semibold text-mist-300">{formatNumber(total)}</span>
      </p>

      <div className="flex items-center gap-2">
        {onLimitChange ? (
          <label className="flex items-center gap-1.5 text-[0.72rem] text-mist-500">
            Rows
            <select
              value={limit}
              onChange={(event) => onLimitChange(event.target.value)}
              className="field w-auto py-1 text-[0.75rem]"
              aria-label="Rows per page"
            >
              {[10, 25, 50, 100].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost !px-2"
            disabled={!hasPrev}
            onClick={() => onPageChange(page - 1)}
            aria-label="Previous page"
          >
            <Icon name="chevronLeft" className="h-3.5 w-3.5" />
          </button>
          <span className="tabular min-w-[5.5rem] text-center text-[0.75rem] text-mist-400">
            Page {page} / {totalPages || 1}
          </span>
          <button
            type="button"
            className="btn btn-ghost !px-2"
            disabled={!hasNext}
            onClick={() => onPageChange(page + 1)}
            aria-label="Next page"
          >
            <Icon name="chevronRight" className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);

    // Lock body scroll so the page behind cannot move while the dialog is up.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the first control for keyboard users.
    const timer = setTimeout(() => {
      const focusable = panelRef.current?.querySelector(
        'input:not([type="hidden"]), select, textarea, button',
      );
      focusable?.focus();
    }, 40);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  const width = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
  }[size] ?? 'max-w-2xl';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <div
        className="fixed inset-0 bg-black/65 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`card relative my-auto w-full ${width} shadow-2xl`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[0.95rem] font-bold text-mist-100">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[0.75rem] text-mist-500">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost !p-1.5" aria-label="Close dialog">
            <Icon name="close" className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[calc(100dvh-14rem)] overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

export function Button({ children, className = '', variant = 'primary', size = 'md', type = 'button', ...props }) {
  const variants = {
    primary: 'btn-primary',
    ghost: 'btn-ghost',
    danger: 'btn-danger',
    'danger-ghost': 'btn-ghost text-red-400 hover:text-red-300',
  };
  const sizes = {
    sm: '!px-2.5 !py-1.5 text-xs',
    md: '',
    lg: '!px-4 !py-2.5 text-sm',
  };
  return (
    <button type={type} className={`btn ${variants[variant] || ''} ${sizes[size] || ''} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Input({ className = '', ...props }) {
  return <input className={`field ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }) {
  return (
    <select className={`field ${className}`} {...props}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, disabled = false, label }) {
  return (
    <label className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange?.(e.target.checked)} disabled={disabled} />
      {label}
    </label>
  );
}

export const Table = DataTable;

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  busy = false,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[0.85rem] leading-relaxed text-mist-300">{message}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function LiveIndicator({ status, label = 'Live' }) {
  const map = {
    open: { tone: 'bg-emerald-400', text: 'text-emerald-400', pulse: true },
    connecting: { tone: 'bg-amber-400', text: 'text-amber-400', pulse: true },
    error: { tone: 'bg-red-400', text: 'text-red-400', pulse: false },
    idle: { tone: 'bg-slate-500', text: 'text-mist-500', pulse: false },
  }[status] ?? { tone: 'bg-slate-500', text: 'text-mist-500', pulse: false };

  return (
    <span className={`inline-flex items-center gap-1.5 text-[0.7rem] font-semibold ${map.text}`} role="status">
      <span className={`h-1.5 w-1.5 rounded-full ${map.tone} ${map.pulse ? 'ts-pulse' : ''}`} aria-hidden="true" />
      {status === 'open' ? label : status === 'connecting' ? 'Reconnecting' : status === 'error' ? 'Offline' : 'Idle'}
    </span>
  );
}

export function ProgressBar({ value = 0, tone = 'info', className = '', label }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  const bar = {
    info: 'bg-sky-500',
    good: 'bg-emerald-500',
    warn: 'bg-amber-500',
    bad: 'bg-red-500',
  }[tone] ?? 'bg-sky-500';

  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-ink-700/70 ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={`h-full rounded-full transition-[width] duration-500 ${bar}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Occurrence bar with an explicit tone derived from the percentage. */
export function OccupancyBar({ occupancy = 0, capacity = 0, className = '' }) {
  const pct = capacity > 0 ? (occupancy / capacity) * 100 : 0;
  const tone = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'good';

  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[0.72rem]">
        <span className="tabular font-semibold text-mist-200">
          {occupancy}
          <span className="text-mist-500"> / {capacity}</span>
        </span>
        <span className="tabular text-mist-500">{Math.round(pct)}%</span>
      </div>
      <ProgressBar value={pct} tone={tone} label="Seat occupancy" />
    </div>
  );
}

/**
 * Route progress bar: how far a bus has travelled along its scheduled shift
 * window, with the departure/arrival stamps either end and stop ticks between.
 * Falls back to an "unscheduled" hint when the route has no usable window.
 */
export function RouteProgressBar({ departureTime, arrivalTime, color = '#38bdf8', className = '' }) {
  const [now, setNow] = useState(() => Date.now());

  // Tick once a minute: shift windows are hour-scale, so a per-second timer
  // would burn renders in an operations wall display for no visible gain.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const start = parseClockTime(departureTime);
  const end = parseClockTime(arrivalTime);

  if (start == null || end == null || end <= start) {
    return (
      <p className={`text-[0.66rem] text-mist-500 ${className}`}>
        No scheduled window for this route
      </p>
    );
  }

  const span = end - start;
  const pct = Math.max(0, Math.min(100, ((now - start) / span) * 100));
  const departed = now >= start;
  const arrived = now >= end;

  return (
    <div className={className}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[0.66rem] text-mist-500">
        <span className="tabular">Dep {departureTime ?? '—'}</span>
        <span
          className={`font-semibold ${arrived ? 'text-mist-400' : departed ? 'text-sky-300' : 'text-mist-500'}`}
        >
          {arrived ? 'Arrived' : departed ? `${Math.round(pct)}% en route` : 'Not departed'}
        </span>
        <span className="tabular">Arr {arrivalTime ?? '—'}</span>
      </div>

      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink-700/70"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Route progress, ${departureTime} to ${arrivalTime}`}
      >
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}99, ${color})`,
          }}
        />
        {/* Travelled marker so the leading edge is legible on a busy card. */}
        <span
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--surface)] shadow"
          style={{ left: `${pct}%`, background: color }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

/** "HH:MM" (or "HH:MM:SS") to minutes since midnight; null when unparseable. */
function parseClockTime(value) {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return (hours * 60 + minutes) * 60_000;
}

export function Tooltip({ label, children, side = 'top' }) {
  const position = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  }[side];

  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-ink-800 px-2 py-1 text-[0.68rem] font-medium text-mist-200 opacity-0 shadow-xl transition-opacity group-hover/tt:block group-hover/tt:opacity-100 ${position}`}
      >
        {label}
      </span>
    </span>
  );
}

export { TONES };