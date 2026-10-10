import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import {
  AlertTypeTag,
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SeverityBadge,
  Spinner,
  StatCard,
  StatusBadge,
  Tooltip,
} from '../components/ui.jsx';
import { FilterBar, FormError, Input, Select, Textarea } from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi, useDebounced, usePagination } from '../lib/hooks.js';
import { useEventStream } from '../lib/stream.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime, formatNumber, formatRelative, titleCase } from '../lib/format.js';

const STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'];
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

/** Resolve / dismiss dialog, reused for single and bulk actions. */
function ResolveDialog({ open, onClose, onDone, alertIds, bulk }) {
  const toast = useToast();
  const [status, setStatus] = useState('RESOLVED');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setStatus('RESOLVED');
      setNote('');
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (bulk) {
        await api.post('/alerts/bulk/resolve', { ids: alertIds, status, note: note.trim() || undefined });
        toast.success(`${alertIds.length} alerts updated.`, { title: 'Bulk update complete' });
      } else {
        await api.post(`/alerts/${alertIds[0]}/resolve`, { status, note: note.trim() || undefined });
        toast.success('Alert updated.');
      }
      onDone();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={bulk ? `Resolve ${alertIds.length} alerts` : 'Resolve alert'}
      subtitle={bulk ? 'One note is applied to every selected alert.' : undefined}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !alertIds.length}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            {bulk ? `Update ${alertIds.length}` : 'Update'}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormError error={error} onDismiss={() => setError(null)} />

        <Select
          label="New status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          options={[
            { value: 'RESOLVED', label: 'Resolved — action taken' },
            { value: 'ACKNOWLEDGED', label: 'Acknowledged — seen, still open' },
            { value: 'DISMISSED', label: 'Dismissed — not actionable' },
          ]}
          disabled={busy}
        />

        <Textarea
          label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="What was done about this?"
          disabled={busy}
          hint={bulk ? 'Leave blank to record "Bulk cleared from console".' : undefined}
        />
      </div>
    </Modal>
  );
}

/**
 * Quick action for an Unregistered Alert: match the unknown UID to a student who
 * has just enrolled, which binds the card and resolves the alert in one step.
 */
function RegisterCardDialog({ alert, open, onClose, onDone }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const debounced = useDebounced(search);

  useEffect(() => {
    if (open) {
      setSearch('');
      setSelected(null);
      setError(null);
    }
  }, [open]);

  const { data, loading } = useApi('/students', {
    enabled: open,
    params: { search: debounced, limit: 8, status: 'ACTIVE' },
  });
  const students = data?.students ?? [];
  const serial = alert?.metadata?.serial ?? '—';

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/alerts/${alert.id}/register-card`, { studentId: selected.id });
      toast.success(`Card registered to ${selected.fullName}.`);
      onDone();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register card to student"
      subtitle={`Bind unknown UID ${serial} to an existing student record.`}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !selected}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            Register card
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormError error={error} onDismiss={() => setError(null)} />

        <Input
          label="Find student"
          icon="search"
          placeholder="Name or college ID…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search students"
          disabled={busy}
        />

        <div className="max-h-64 overflow-y-auto rounded-xl border border-[var(--border-subtle)]">
          {loading && !students.length ? (
            <p className="px-3 py-4 text-center text-[0.78rem] text-mist-500">Searching…</p>
          ) : students.length ? (
            <ul className="divide-y divide-[var(--border-subtle)]/60">
              {students.map((student) => {
                const active = selected?.id === student.id;
                return (
                  <li key={student.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(student)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors ${
                        active ? 'bg-sky-500/10' : 'hover:bg-[var(--surface-sunken)]'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[0.8rem] font-medium text-mist-200">
                          {student.fullName}
                        </span>
                        <span className="tabular block truncate text-[0.7rem] text-mist-500">
                          {student.collegeId}
                        </span>
                      </span>
                      {active ? <Icon name="check" className="h-4 w-4 shrink-0 text-sky-400" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-4 text-center text-[0.78rem] text-mist-500">
              No students match this search.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function DetailModal({ alert, open, onClose, onDone, canResolve, canEditStudents }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);

  if (!alert) return null;

  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.post(`/alerts/${alert.id}/acknowledge`);
      toast.success('Alert acknowledged.');
      onDone();
      onClose();
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    try {
      await api.post(`/alerts/${alert.id}/resolve`, { status: 'DISMISSED', note: 'Dismissed from alert detail' });
      toast.success('Alert dismissed.');
      onDone();
      onClose();
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const isUnregistered = alert.type === 'UNREGISTERED_DEVICE';
  const openish = ['OPEN', 'ACKNOWLEDGED'].includes(alert.status);

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={alert.title}
        subtitle={`${alert.typeLabel} · raised ${formatRelative(alert.createdAt)}`}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            {canResolve && alert.status === 'OPEN' ? (
              <button type="button" className="btn btn-ghost" onClick={acknowledge} disabled={busy}>
                {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="eye" className="h-3.5 w-3.5" />}
                Acknowledge
              </button>
            ) : null}
            {canResolve && openish ? (
              <button type="button" className="btn btn-ghost" onClick={dismiss} disabled={busy}>
                <Icon name="close" className="h-3.5 w-3.5" />
                Dismiss
              </button>
            ) : null}
            {isUnregistered && canEditStudents && openish ? (
              <button type="button" className="btn btn-primary" onClick={() => setRegisterOpen(true)}>
                <Icon name="card" className="h-3.5 w-3.5" />
                Register card to student
              </button>
            ) : null}
            {!isUnregistered && canResolve && openish ? (
              <button type="button" className="btn btn-primary" onClick={() => setResolveOpen(true)}>
                <Icon name="check" className="h-3.5 w-3.5" />
                Resolve
              </button>
            ) : null}
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={alert.severity} />
            <StatusBadge status={alert.status} />
            <AlertTypeTag tag={alert.tag} label={alert.typeLabel} />
          </div>

          <p className="text-[0.85rem] leading-relaxed text-mist-300">{alert.message}</p>

          <dl className="grid gap-x-4 gap-y-2.5 text-[0.78rem] sm:grid-cols-2">
            <Field label="Raised at" value={formatDateTime(alert.createdAt)} />
            <Field label="Severity" value={alert.severity} />
            {alert.studentName ? (
              <Field
                label="Student"
                value={
                  <Link to={`/students/${alert.studentId}`} className="text-sky-400 hover:underline">
                    {alert.studentName} <span className="text-mist-500">({alert.collegeId})</span>
                  </Link>
                }
              />
            ) : null}
            <Field label="Card UID" value={alert.metadata?.serial ?? '—'} mono />
            {alert.busCode ? <Field label="Bus" value={`${alert.busCode}${alert.routeCode ? ` · ${alert.routeCode}` : ''}`} /> : null}
            {alert.gate ? <Field label="Gate" value={alert.gate} /> : null}
            {alert.scanEventId ? <Field label="Scan event" value={`#${alert.scanEventId}`} /> : null}
            {alert.acknowledgedByName ? <Field label="Acknowledged by" value={`${alert.acknowledgedByName} · ${formatRelative(alert.acknowledgedAt)}`} /> : null}
            {alert.resolvedByName ? <Field label="Resolved by" value={`${alert.resolvedByName} · ${formatRelative(alert.resolvedAt)}`} /> : null}
          </dl>

          {alert.resolutionNote ? (
            <div className="rounded-lg bg-[var(--surface-sunken)] px-3.5 py-2.5">
              <p className="mb-1 text-[0.66rem] font-bold tracking-[0.06em] text-mist-500 uppercase">
                Resolution note
              </p>
              <p className="text-[0.8rem] text-mist-300">{alert.resolutionNote}</p>
            </div>
          ) : null}
        </div>
      </Modal>

      <ResolveDialog
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        onDone={() => {
          onDone();
          onClose();
        }}
        alertIds={[alert.id]}
        bulk={false}
      />

      <RegisterCardDialog
        alert={alert}
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onDone={() => {
          onDone();
          onClose();
        }}
      />
    </>
  );
}

function Field({ label, value, mono }) {
  return (
    <div>
      <dt className="text-[0.66rem] font-bold tracking-[0.06em] text-mist-500 uppercase">{label}</dt>
      <dd className={`mt-0.5 text-mist-200 ${mono ? 'font-mono text-[0.75rem]' : ''}`}>{value ?? '—'}</dd>
    </div>
  );
}

export default function Alerts() {
  const { can } = useAuth();
  const toast = useToast();
  const { page, limit, goToPage, changeLimit, reset } = usePagination({ defaultLimit: 25 });

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [selected, setSelected] = useState([]);
  const [detail, setDetail] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  const debouncedSearch = useDebounced(search);

  useEffect(() => {
    reset();
    setSelected([]);
  }, [debouncedSearch, status, severity, type, reset]);

  const { data: stats } = useApi('/alerts/stats', { enabled: can('alerts:read') });

  const { data, error, loading, refreshing, reload } = useApi('/alerts', {
    enabled: can('alerts:read'),
    params: { page, limit, search: debouncedSearch, status, severity, type },
  });

  // A live alert should appear without a manual refresh.
  const { subscribe } = useEventStream({
    enabled: can('alerts:read'),
    onEvent: useCallback(
      (event) => {
        if (event === 'alert') reload({ silent: true });
      },
      [reload],
    ),
  });

  useEffect(() => {
    if (status !== 'OPEN') return undefined;
    return subscribe('alert', () => reload({ silent: true }));
  }, [subscribe, status, reload]);

  const alerts = data?.alerts ?? [];
  const meta = data?.meta;

  const allSelected = alerts.length > 0 && selected.length === alerts.length;
  const clearFilters = () => {
    setSearch('');
    setSeverity('');
    setType('');
  };

  const toggleAll = () => setSelected(allSelected ? [] : alerts.map((alert) => alert.id));
  const toggleOne = (id) =>
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  const clearAllOpen = async () => {
    setClearBusy(true);
    try {
      // Only the current page's IDs are known client-side, so clear in batches.
      const ids = alerts.map((alert) => alert.id);
      if (!ids.length) return;
      await api.post('/alerts/bulk/resolve', { ids, note: 'Cleared from the alerts console' });
      toast.success(`${ids.length} alerts cleared.`, { title: 'Done' });
      setClearOpen(false);
      setSelected([]);
      reload({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setClearBusy(false);
    }
  };

  const typeOptions = useMemo(
    () => (stats?.types ?? []).map((entry) => ({ value: entry.type ?? entry.key, label: entry.label ?? titleCase(entry.type ?? entry.key) })),
    [stats],
  );

  const columns = [
    {
      key: 'select',
      label: (
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer rounded border-[var(--border-subtle)] accent-sky-500"
          checked={allSelected}
          onChange={toggleAll}
          aria-label="Select all alerts on this page"
        />
      ),
      render: (row) =>
        can('alerts:resolve') ? (
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer rounded border-[var(--border-subtle)] accent-sky-500"
            checked={selected.includes(row.id)}
            onChange={() => toggleOne(row.id)}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Select alert ${row.id}`}
          />
        ) : null,
      width: '2.5rem',
    },
    {
      key: 'severity',
      label: 'Severity',
      nowrap: true,
      render: (row) => <SeverityBadge severity={row.severity} />,
    },
    {
      key: 'title',
      label: 'Alert',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-[0.82rem] font-semibold text-mist-100">{row.title}</p>
          <p className="truncate text-[0.7rem] text-mist-500">{row.message}</p>
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      nowrap: true,
      render: (row) => <AlertTypeTag tag={row.tag} label={row.typeLabel} />,
    },
    {
      key: 'subject',
      label: 'Subject',
      render: (row) =>
        row.studentId ? (
          <Link
            to={`/students/${row.studentId}`}
            className="block min-w-0 hover:text-sky-400"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="truncate text-[0.76rem] text-mist-200">{row.studentName}</p>
            <p className="tabular truncate text-[0.67rem] text-mist-500">{row.collegeId}</p>
          </Link>
        ) : (
          <span className="text-[0.74rem] text-mist-500">
            {row.busCode ? `${row.busCode}${row.routeCode ? ` · ${row.routeCode}` : ''}` : '—'}
          </span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      nowrap: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'createdAt',
      label: 'Raised',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <Tooltip label={formatDateTime(row.createdAt)} side="left">
          <span className="text-[0.72rem] text-mist-500">{formatRelative(row.createdAt)}</span>
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Unregistered card taps and operator notices"
        actions={
          can('alerts:resolve') ? (
            <>
              {selected.length ? (
                <button type="button" className="btn btn-primary" onClick={() => setBulkOpen(true)}>
                  <Icon name="check" className="h-3.5 w-3.5" />
                  Resolve {selected.length} selected
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost" onClick={() => setClearOpen(true)}>
                <Icon name="trash" className="h-3.5 w-3.5" />
                Clear this page
              </button>
            </>
          ) : null
        }
      />

      {stats ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Open alerts"
            value={stats.open ?? 0}
            sub={`${stats.last24h ?? 0} in the last 24h`}
            icon="alerts"
            tone={stats.open > 0 ? 'bad' : 'good'}
          />
          <StatCard
            label="Critical"
            value={stats.bySeverity?.CRITICAL ?? 0}
            icon="alert"
            tone={(stats.bySeverity?.CRITICAL ?? 0) > 0 ? 'bad' : 'good'}
          />
          <StatCard label="High" value={stats.bySeverity?.HIGH ?? 0} icon="alert" tone="warn" />
          <StatCard
            label="Total resolved"
            value={stats.byStatus?.RESOLVED ?? 0}
            icon="check"
            tone="good"
            sub={`${stats.openTotal ?? stats.open ?? 0} ever raised`}
          />
        </div>
      ) : null}

      <div className="card mb-4 p-3.5">
        <FilterBar onClear={clearFilters}>
          <Input
            wrapperClass="min-w-[13rem] flex-1"
            placeholder="Search alerts…"
            icon="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search alerts"
          />
          <Select
            wrapperClass="w-44"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            options={STATUSES.map((entry) => ({ value: entry, label: titleCase(entry) }))}
          />
          <Select
            wrapperClass="w-40"
            label="Severity"
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
            options={SEVERITIES}
            placeholder="Any severity"
          />
          {typeOptions.length ? (
            <Select
              wrapperClass="w-48"
              label="Type"
              value={type}
              onChange={(event) => setType(event.target.value)}
              options={typeOptions}
              placeholder="Any type"
            />
          ) : null}
          {refreshing ? <Spinner className="h-4 w-4 text-mist-500" /> : null}
        </FilterBar>
      </div>

      <div className="card overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : alerts.length === 0 && !loading ? (
          <EmptyState
            icon={status === 'OPEN' ? 'check' : 'search'}
            title={status === 'OPEN' ? 'No open alerts' : 'No alerts match these filters'}
            message={
              status === 'OPEN'
                ? 'Nothing needs attention right now. Alerts are raised only when a tapped card UID is not registered to any student.'
                : 'Try a different status or clear the filters.'
            }
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={alerts}
              loading={loading}
              onRowClick={(row) => setDetail(row)}
              rowClassName={() => 'cursor-pointer'}
              skeletonRows={10}
            />
            <Pagination meta={meta} limit={limit} onLimitChange={changeLimit} onPageChange={goToPage} />
          </>
        )}
      </div>

      <DetailModal
        alert={detail}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        onDone={() => reload({ silent: true })}
        canResolve={can('alerts:resolve')}
        canEditStudents={can('students:edit')}
      />

      <ResolveDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onDone={() => {
          setSelected([]);
          reload({ silent: true });
        }}
        alertIds={selected}
        bulk
      />

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={clearAllOpen}
        busy={clearBusy}
        title={`Clear ${alerts.length} alerts on this page?`}
        confirmLabel="Clear them"
        message="Every alert listed on the current page will be marked RESOLVED with a shared note. This cannot be undone."
      />

      {stats?.types?.length ? (
        <div className="mt-4">
          <Panel title="Alert mix" subtitle="By type, all time" icon="activity">
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {stats.types.map((entry) => (
                <li key={entry.type ?? entry} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-sunken)] px-3 py-2">
                  <span className="truncate text-[0.77rem] text-mist-300">{entry.label ?? titleCase(entry.type ?? entry)}</span>
                  <Badge tone="neutral">{formatNumber(entry.count ?? entry.n ?? 0)}</Badge>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}
    </>
  );
}

