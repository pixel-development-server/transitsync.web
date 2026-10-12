import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  Spinner,
  StatusBadge,
} from '../components/ui.jsx';
import {
  FilterBar,
  FormError,
  FormGrid,
  Input,
  SegmentedControl,
  Select,
} from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi, useDebounced, usePagination } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { CampusSelect, useCampusDirectory, usePlatformScope } from '../components/CampusScope.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CARD_STATUSES = ['UNASSIGNED', 'ISSUED', 'ACTIVE', 'REVOKED'];

const EMPTY_FORM = {
  fullName: '',
  collegeId: '',
  email: '',
  phone: '',
  faculty: '',
  program: '',
  semester: '',
  rfidSerial: '',
  cardStatus: 'UNASSIGNED',
  routeId: '',
  busId: '',
  pickupStop: '',
  status: 'ACTIVE',
  notes: '',
  tenantId: '',
};

/** Create / edit dialog. Numeric selects must send `null`, not `""`. */
function StudentDialog({ open, onClose, onSaved, student, buses, routes, faculties = [], isPlatform, tenantId, colleges = [] }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      student
        ? {
            ...EMPTY_FORM,
            ...Object.fromEntries(
              Object.keys(EMPTY_FORM).map((key) => [key, student[key] ?? EMPTY_FORM[key]]),
            ),
            semester: student.semester ?? '',
            routeId: student.routeId ?? '',
            busId: student.busId ?? '',
            tenantId: student.tenantId ?? '',
          }
        : { ...EMPTY_FORM, tenantId: isPlatform ? (tenantId ?? '') : '' },
    );
  }, [open, student, isPlatform, tenantId]);

  const set = useCallback((key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const fieldErrors = error?.fieldErrors ?? {};

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    // Strict email gate: an address that cannot contain `@` (or a bare `@`
    // without a real domain) is rejected inline. The server re-validates
    // authoritatively. Optional field — empty stays allowed.
    const emailValue = String(form.email ?? '').trim().toLowerCase();
    if (emailValue && !EMAIL_RE.test(emailValue)) {
      setError({
        message: 'Check the highlighted fields.',
        fieldErrors: { email: "Please enter a valid email address containing '@' (e.g., student@iic.edu.np)." },
      });
      return;
    }

    setSaving(true);

    // Empty strings would fail `emptyToNull` coercion for numbers; send null.
    const payload = Object.fromEntries(
      Object.entries(form).map(([key, value]) => {
        if (value === '') return [key, null];
        if (['routeId', 'busId', 'semester'].includes(key)) return [key, Number(value)];
        return [key, typeof value === 'string' ? value.trim() : value];
      }),
    );
    if (!student && isPlatform) {
      if (tenantId) payload.tenantId = tenantId;
      else delete payload.tenantId;
    } else {
      delete payload.tenantId;
    }

    try {
      if (student) {
        await api.patch(`/students/${student.id}`, payload);
        toast.success(`${form.fullName} updated.`);
      } else {
        await api.post('/students', payload);
        toast.success(`${form.fullName} added to the registry.`);
      }
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const busOptions = useMemo(
    () =>
      buses
        .filter((bus) => !bus.status || bus.status === 'ACTIVE')
        .map((bus) => ({ value: bus.id, label: `${bus.code} — ${bus.name}` })),
    [buses],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={student ? `Edit ${student.fullName}` : 'Register a student'}
      subtitle={
        student
          ? `College ID ${student.collegeId}`
          : 'Leave the card UID blank to register the student without a card.'
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" form="student-form" className="btn btn-primary" disabled={saving}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            {student ? 'Save changes' : 'Register student'}
          </button>
        </>
      }
    >
      <form id="student-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError error={error} onDismiss={() => setError(null)} />

        <section>
          <h3 className="mb-2 text-[0.7rem] font-bold tracking-[0.08em] text-mist-500 uppercase">
            Identity
          </h3>
          <FormGrid columns={3}>
            <Input
              label="Full name"
              value={form.fullName}
              onChange={set('fullName')}
              error={fieldErrors.fullName}
              placeholder="Asha Gurung"
              required
              disabled={saving}
            />
            <Input
              label="College ID"
              value={form.collegeId}
              onChange={set('collegeId')}
              error={fieldErrors.collegeId}
              placeholder="KMI2024123"
              required
              disabled={saving}
            />
            <Input
              label="Semester"
              type="number"
              min="1"
              max="12"
              value={form.semester}
              onChange={set('semester')}
              error={fieldErrors.semester}
              placeholder="1–12"
              disabled={saving}
            />
            <Input
              label="Email"
              type="email"
              value={form.email}
              onChange={set('email')}
              error={fieldErrors.email}
              placeholder="asha@kmi.edu.np"
              disabled={saving}
            />
            <Input
              label="Phone"
              value={form.phone}
              onChange={set('phone')}
              error={fieldErrors.phone}
              placeholder="+977 98XXXXXXXX"
              disabled={saving}
            />
            <Input
              label="Faculty / program"
              value={form.faculty}
              onChange={set('faculty')}
              error={fieldErrors.faculty}
              placeholder="Type one, e.g. B.Sc. Cybersecurity, BBA, BIT"
              list="student-faculty-options"
              disabled={saving}
            >
              <datalist id="student-faculty-options">
                {faculties.map((faculty) => (
                  <option key={faculty} value={faculty} />
                ))}
              </datalist>
              <p className="mt-1.5 flex items-start gap-1.5 text-[0.7rem] leading-relaxed text-mist-500">
                <Icon name="info" className="mt-px h-3 w-3 shrink-0" />
                Any faculty this campus runs is accepted — previously used ones appear as suggestions.
              </p>
            </Input>
          </FormGrid>
        </section>

        <section className="border-t border-[var(--border-subtle)] pt-4">
          <h3 className="mb-2 text-[0.7rem] font-bold tracking-[0.08em] text-mist-500 uppercase">
            Bus card
          </h3>
          <p className="mb-3 text-[0.72rem] leading-relaxed text-mist-500">
            Cards are issued by the college once the bus fee is paid and the registration form is
            submitted. A card stays active until the student cancels their bus service, at which
            point it is revoked and retrieved.
          </p>
          <FormGrid columns={3}>
            <Input
              label="Card UID / RFID serial"
              value={form.rfidSerial}
              onChange={set('rfidSerial')}
              error={fieldErrors.rfidSerial}
              placeholder="Tap or type the UID"
              disabled={saving}
              className="font-mono uppercase"
            />
            <Select
              label="Card status"
              value={form.cardStatus}
              onChange={set('cardStatus')}
              error={fieldErrors.cardStatus}
              options={CARD_STATUSES}
              disabled={saving}
            />
          </FormGrid>
        </section>

        <section className="border-t border-[var(--border-subtle)] pt-4">
          <h3 className="mb-2 text-[0.7rem] font-bold tracking-[0.08em] text-mist-500 uppercase">
            Allocation
          </h3>
          <FormGrid columns={3}>
            <Select
              label="Route"
              value={form.routeId}
              onChange={set('routeId')}
              error={fieldErrors.routeId}
              options={routes.map((route) => ({ value: route.id, label: `${route.code} — ${route.name}` }))}
              placeholder="No route"
              disabled={saving}
            />
            <Select
              label="Bus"
              value={form.busId}
              onChange={set('busId')}
              error={fieldErrors.busId}
              options={busOptions}
              placeholder="No bus"
              disabled={saving}
            />
            <Input
              label="Pickup stop"
              value={form.pickupStop}
              onChange={set('pickupStop')}
              error={fieldErrors.pickupStop}
              placeholder="Koteshwor gate"
              disabled={saving}
            />
            <SegmentedControl
              label="Registration status"
              value={form.status}
              onChange={set('status')}
              options={['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']}
              wrapperClass="sm:col-span-2"
            />
            <Input
              label="Notes"
              value={form.notes}
              onChange={set('notes')}
              error={fieldErrors.notes}
              placeholder="Internal remarks"
              disabled={saving}
            />
          </FormGrid>
        </section>
      </form>
    </Modal>
  );
}

export default function Students() {
  const { can, user } = useAuth();
  const toast = useToast();
  const { isPlatform } = usePlatformScope();
  const { colleges } = useCampusDirectory(isPlatform);

  const [tenantId, setTenantId] = useState('');

  const { page, limit, goToPage, changeLimit, reset } = usePagination({ defaultLimit: 25 });

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [cardStatus, setCardStatus] = useState('');
  const [busId, setBusId] = useState('');
  const [routeId, setRouteId] = useState('');
  const [onboard, setOnboard] = useState('');
  const [sort, setSort] = useState({ key: 'created', direction: 'desc' });

  const debouncedSearch = useDebounced(search);

  // Any filter change invalidates the current page number.
  useEffect(() => {
    reset();
  }, [debouncedSearch, status, cardStatus, busId, routeId, onboard, tenantId, reset]);

  const listParams = {
    page,
    limit,
    search: debouncedSearch,
    status,
    cardStatus,
    busId,
    routeId,
    onboard,
    sort: sort.key,
    order: sort.direction,
  };
  if (isPlatform && tenantId) listParams.tenantId = tenantId;

  const summaryParams = {};
  if (isPlatform && tenantId) summaryParams.tenantId = tenantId;

  const fleetParams = {};
  if (isPlatform && tenantId) fleetParams.tenantId = tenantId;

  const { data: summary } = useApi('/students/summary', { enabled: can('students:read'), params: summaryParams });
  const { data: busesData } = useApi('/buses', { enabled: can('students:read') && can('fleet:read'), params: fleetParams });
  const { data: routesData } = useApi('/routes', { enabled: can('students:read') && can('fleet:read'), params: fleetParams });

  const buses = busesData?.buses ?? [];
  const routes = routesData?.routes ?? [];

  const { data, error, loading, refreshing, reload } = useApi('/students', {
    enabled: can('students:read'),
    params: listParams,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const students = data?.students ?? [];
  const meta = data?.meta;

  // Faculties used anywhere on campus, fed into the creatable faculty box.
  const facultyOptions = useMemo(() => {
    const seen = new Set();
    for (const entry of summary?.byFaculty ?? []) {
      const name = String(entry?.faculty ?? '').trim();
      if (name && name !== 'Unassigned' && !seen.has(name)) seen.add(name);
    }
    if (editing?.faculty) seen.add(editing.faculty);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [summary, editing]);

  const clearFilters = () => {
    setSearch('');
    setStatus('');
    setCardStatus('');
    setBusId('');
    setRouteId('');
    setOnboard('');
    if (isPlatform) setTenantId('');
  };

  const filtersActive = Boolean(search || status || cardStatus || busId || routeId || onboard || (isPlatform && tenantId));

  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.del(`/students/${deleting.id}`);
      toast.success(`${deleting.fullName} removed from the registry.`);
      setDeleting(null);
      reload({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const columns = [
    {
      key: 'fullName',
      label: 'Student',
      sortKey: 'name',
      render: (row) => (
        <div className="min-w-0">
          <Link
            to={`/students/${row.id}`}
            className="block truncate text-[0.83rem] font-semibold text-mist-100 hover:text-sky-400"
            onClick={(event) => event.stopPropagation()}
          >
            {row.fullName}
          </Link>
          <p className="tabular truncate text-[0.7rem] text-mist-500">
            {row.collegeId}
            {row.faculty ? ` · ${row.faculty}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'card',
      label: 'Bus card',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-[0.75rem] text-mist-300">{row.rfidSerial || '—'}</p>
          <StatusBadge status={row.cardStatus} />
        </div>
      ),
    },
    {
      key: 'issued',
      label: 'Issued / revoked',
      render: (row) => (
        <div className="min-w-0">
          {row.cardIssuedAt ? (
            <p className="tabular truncate text-[0.72rem] text-mist-400">{formatDateTime(row.cardIssuedAt)}</p>
          ) : (
            <p className="text-[0.68rem] text-mist-500">Not issued</p>
          )}
          {row.cardStatus === 'REVOKED' && row.cardRevokedAt ? (
            <p className="tabular truncate text-[0.68rem] text-red-400">
              Revoked {formatRelative(row.cardRevokedAt)}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'allocation',
      label: 'Allocation',
      render: (row) =>
        row.routeCode || row.busCode ? (
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-[0.75rem] text-mist-200">
              {row.routeColor ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: row.routeColor }}
                  aria-hidden="true"
                />
              ) : null}
              {row.routeCode ?? '—'}
              {row.busCode ? ` · ${row.busCode}` : ''}
            </p>
            {row.pickupStop ? (
              <p className="truncate text-[0.68rem] text-mist-500">{row.pickupStop}</p>
            ) : null}
          </div>
        ) : (
          <Badge tone="warn">Unallocated</Badge>
        ),
    },
    {
      key: 'onboard',
      label: 'Onboard',
      align: 'center',
      sortKey: 'onboard',
      render: (row) =>
        row.onboard ? (
          <Badge tone="good" dot>
            {row.onboardBusCode ?? 'Yes'}
          </Badge>
        ) : (
          <span className="text-[0.72rem] text-mist-500">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          {can('students:edit') ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={(event) => {
                event.stopPropagation();
                setEditing(row);
                setDialogOpen(true);
              }}
              aria-label={`Edit ${row.fullName}`}
              title="Edit"
            >
              <Icon name="edit" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('students:delete') ? (
            <button
              type="button"
              className="btn btn-danger !p-1.5"
              onClick={(event) => {
                event.stopPropagation();
                setDeleting(row);
              }}
              aria-label={`Delete ${row.fullName}`}
              title="Delete"
            >
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Students"
        subtitle="Bus card registry, lifecycle and shuttle allocation"
        actions={
          can('students:create') ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Icon name="plus" className="h-3.5 w-3.5" />
              Register student
            </button>
          ) : null
        }
      />

      {/* Summary strip */}
      {summary ? (
        <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
          <SummaryTile label="Total" value={summary.totals.total} tone="info" />
          <SummaryTile label="Active" value={summary.totals.active} tone="good" />
          <SummaryTile label="Onboard" value={summary.totals.onboard} tone="accent" />
          <SummaryTile
            label="No card"
            value={summary.totals.unassigned}
            tone={summary.totals.unassigned > 0 ? 'warn' : 'good'}
          />
          <SummaryTile
            label="Active cards"
            value={summary.totals.active_cards}
            tone="good"
          />
          <SummaryTile
            label="Revoked"
            value={summary.totals.revoked}
            tone={summary.totals.revoked > 0 ? 'bad' : 'good'}
          />
          <SummaryTile
            label="Unallocated"
            value={summary.totals.unallocated}
            tone={summary.totals.unallocated > 0 ? 'warn' : 'good'}
          />
        </div>
      ) : null}

      {/* Filters */}
      <div className="card mb-4 p-3.5">
        <FilterBar onClear={filtersActive ? clearFilters : undefined}>
          <CampusSelect isPlatform={isPlatform} colleges={colleges} value={tenantId} onChange={setTenantId} wrapperClass="w-60" />
          <Input
            wrapperClass="min-w-[14rem] flex-1"
            placeholder="Search name, college ID or card…"
            icon="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search students"
          />
          <Select
            wrapperClass="w-40"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            options={['ACTIVE', 'SUSPENDED', 'GRADUATED', 'WITHDRAWN']}
            placeholder="Any status"
            aria-label="Filter by status"
          />
          <Select
            wrapperClass="w-40"
            value={cardStatus}
            onChange={(event) => setCardStatus(event.target.value)}
            options={CARD_STATUSES}
            placeholder="Any card state"
            aria-label="Filter by card status"
          />
          {buses?.buses ? (
            <Select
              wrapperClass="w-40"
              value={busId}
              onChange={(event) => setBusId(event.target.value)}
              options={buses.buses.map((bus) => ({ value: bus.id, label: bus.code }))}
              placeholder="Any bus"
              aria-label="Filter by bus"
            />
          ) : null}
          {routes?.routes ? (
            <Select
              wrapperClass="w-40"
              value={routeId}
              onChange={(event) => setRouteId(event.target.value)}
              options={routes.routes.map((route) => ({ value: route.id, label: route.code }))}
              placeholder="Any route"
              aria-label="Filter by route"
            />
          ) : null}
          <Select
            wrapperClass="w-36"
            value={onboard}
            onChange={(event) => setOnboard(event.target.value)}
            options={[
              { value: 'true', label: 'Onboard only' },
              { value: 'false', label: 'Not onboard' },
            ]}
            placeholder="Any rider"
            aria-label="Filter by onboard state"
          />
          {refreshing ? <Spinner className="h-4 w-4 text-mist-500" /> : null}
        </FilterBar>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : students.length === 0 && !loading ? (
          <EmptyState
            icon="students"
            title={filtersActive ? 'No students match these filters' : 'No students registered yet'}
            message={
              filtersActive
                ? 'Try clearing a filter or widening the search term.'
                : 'Register the first student to begin issuing RFID cards.'
            }
            action={
              filtersActive ? (
                <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              ) : can('students:create') ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setEditing(null);
                    setDialogOpen(true);
                  }}
                >
                  <Icon name="plus" className="h-3.5 w-3.5" />
                  Register student
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={students}
              loading={loading}
              sort={sort}
              onSort={setSort}
              skeletonRows={10}
            />
            <Pagination
              meta={meta}
              limit={limit}
              onLimitChange={changeLimit}
              onPageChange={goToPage}
            />
          </>
        )}
      </div>

      <StudentDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          reload({ silent: true });
        }}
        student={editing}
        buses={buses}
        routes={routes}
        faculties={facultyOptions}
        isPlatform={isPlatform}
        tenantId={tenantId}
        colleges={colleges}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Delete student"
        confirmLabel="Delete permanently"
        message={
          deleting
            ? `Delete ${deleting.fullName} (${deleting.collegeId})? Their attendance history is retained, but the card is released and the record is removed from the registry.`
            : ''
        }
      />
    </>
  );
}

function SummaryTile({ label, value, tone = 'neutral' }) {
  const tones = {
    good: 'text-emerald-400',
    warn: 'text-amber-400',
    bad: 'text-red-400',
    info: 'text-sky-400',
    accent: 'text-violet-400',
    neutral: 'text-mist-200',
  };

  return (
    <div className="card px-3 py-2.5">
      <p className="text-[0.65rem] font-semibold tracking-[0.05em] text-mist-500 uppercase">{label}</p>
      <p className={`tabular text-lg leading-tight font-bold ${tones[tone]}`}>{value ?? 0}</p>
    </div>
  );
}

export { formatDateTime, formatRelative };