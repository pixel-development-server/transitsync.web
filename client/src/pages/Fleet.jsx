import { useCallback, useEffect, useMemo, useState } from 'react';

import { Icon } from '../components/Icon.jsx';
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  OccupancyBar,
  PageHeader,
  Spinner,
  StatCard,
  StatusBadge,
} from '../components/ui.jsx';
import { FilterBar, FormError, FormGrid, Input, SegmentedControl, Select, Textarea } from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi, useDebounced } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';
import { titleCase } from '../lib/format.js';
import { CampusSelect, useCampusDirectory, usePlatformScope } from '../components/CampusScope.jsx';

const TABS = [
  { key: 'buses', label: 'Buses', permission: 'fleet:read' },
  { key: 'routes', label: 'Routes & stops', permission: 'fleet:read' },
];

const EMPTY_BUS = {
  code: '', registrationNo: '', name: '', makeModel: '', seatCapacity: 40,
  driverName: '', driverPhone: '', driverLicense: '', status: 'ACTIVE',
  currentRouteId: '', odometerKm: 0, lastServiceAt: '', tenantId: '',
};

const EMPTY_ROUTE = {
  code: '', name: '', description: '', startPoint: '', endPoint: '',
  shift: 'MORNING', departureTime: '07:00', arrivalTime: '09:00', color: '#38BDF8', isActive: true, tenantId: '',
};

function BusDialog({ open, onClose, onSaved, bus, routes, isPlatform, tenantId, colleges = [] }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_BUS);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      bus
        ? {
            ...EMPTY_BUS,
            ...Object.fromEntries(Object.keys(EMPTY_BUS).map((key) => [key, bus[key] ?? EMPTY_BUS[key]])),
            currentRouteId: bus.currentRouteId ?? bus.route?.id ?? '',
            lastServiceAt: bus.lastServiceAt ? String(bus.lastServiceAt).slice(0, 10) : '',
            tenantId: bus.tenantId ?? '',
          }
        : { ...EMPTY_BUS, tenantId: isPlatform ? (tenantId ?? '') : '' },
    );
  }, [open, bus, isPlatform, tenantId]);

  const set = useCallback(
    (key) => (event) => {
      const value = event?.target ? event.target.value : event;
      setForm((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const fieldErrors = error?.fieldErrors ?? {};

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setSaving(true);

    const payload = Object.fromEntries(
      Object.entries(form).map(([key, value]) => {
        if (value === '') return [key, null];
        if (['currentRouteId', 'seatCapacity', 'odometerKm'].includes(key)) return [key, Number(value)];
        return [key, typeof value === 'string' ? value.trim() : value];
      }),
    );
    if (!bus && isPlatform) {
      if (tenantId) payload.tenantId = tenantId;
      else delete payload.tenantId;
    } else {
      delete payload.tenantId;
    }

    try {
      if (bus) {
        await api.patch(`/buses/${bus.id}`, payload);
        toast.success(`${form.code} updated.`);
      } else {
        await api.post('/buses', payload);
        toast.success(`${form.code} added to the fleet.`);
      }
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bus ? `Edit ${bus.code}` : 'Add a bus'}
      size="lg"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" form="bus-form" className="btn btn-primary" disabled={saving}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            {bus ? 'Save changes' : 'Add bus'}
          </button>
        </>
      }
    >
      <form id="bus-form" onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} onDismiss={() => setError(null)} />

        <FormGrid columns={3}>
          <Input label="Bus code" value={form.code} onChange={set('code')} error={fieldErrors.code} placeholder="TS-06" required disabled={saving} className="font-mono uppercase" />
          <Input label="Registration" value={form.registrationNo} onChange={set('registrationNo')} error={fieldErrors.registrationNo} placeholder="BA 2 KHA 4471" required disabled={saving} className="uppercase" />
          <Input label="Name" value={form.name} onChange={set('name')} error={fieldErrors.name} placeholder="Annapurna" required disabled={saving} />
          <Input label="Make / model" value={form.makeModel} onChange={set('makeModel')} error={fieldErrors.makeModel} placeholder="Tata Starbus" disabled={saving} />
          <Input label="Seat capacity" type="number" min="1" max="200" value={form.seatCapacity} onChange={set('seatCapacity')} error={fieldErrors.seatCapacity} required disabled={saving} />
          <Select
            label="Status"
            value={form.status}
            onChange={set('status')}
            error={fieldErrors.status}
            options={['ACTIVE', 'MAINTENANCE', 'RETIRED']}
            disabled={saving}
          />
        </FormGrid>

        <section className="border-t border-[var(--border-subtle)] pt-4">
          <h3 className="mb-2 text-[0.7rem] font-bold tracking-[0.08em] text-mist-500 uppercase">Driver</h3>
          <FormGrid columns={3}>
            <Input label="Driver name" value={form.driverName} onChange={set('driverName')} error={fieldErrors.driverName} disabled={saving} />
            <Input label="Phone" value={form.driverPhone} onChange={set('driverPhone')} error={fieldErrors.driverPhone} disabled={saving} />
            <Input label="Licence" value={form.driverLicense} onChange={set('driverLicense')} error={fieldErrors.driverLicense} disabled={saving} />
          </FormGrid>
        </section>

        <section className="border-t border-[var(--border-subtle)] pt-4">
          <h3 className="mb-2 text-[0.7rem] font-bold tracking-[0.08em] text-mist-500 uppercase">Assignment</h3>
          <FormGrid columns={3}>
            <Select
              label="Current route"
              value={form.currentRouteId}
              onChange={set('currentRouteId')}
              error={fieldErrors.currentRouteId}
              options={(routes ?? []).map((route) => ({ value: route.id, label: `${route.code} — ${route.name}` }))}
              placeholder="No route"
              disabled={saving}
            />
            <Input label="Odometer (km)" type="number" min="0" value={form.odometerKm} onChange={set('odometerKm')} error={fieldErrors.odometerKm} disabled={saving} />
            <Input label="Last serviced" type="date" value={form.lastServiceAt} onChange={set('lastServiceAt')} error={fieldErrors.lastServiceAt} disabled={saving} />
          </FormGrid>
        </section>
      </form>
    </Modal>
  );
}

/** Stops are edited as an ordered list; the API replaces the whole set on PUT. */
function StopsDialog({ open, onClose, onSaved, route }) {
  const toast = useToast();
  const [stops, setStops] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // The list endpoint returns only a stop *count*, so pull the full route (with
  // its ordered stops) when the editor opens.
  const { data: detail, loading: loadingStops } = useApi(
    route ? `/routes/${route.id}` : null,
    { enabled: Boolean(open && route?.id) },
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    const source = detail?.route?.id === route?.id ? detail.stops ?? [] : null;
    setStops(
      (source ?? []).map((stop) => ({
        sequence: stop.sequence ?? 1,
        name: stop.name ?? '',
        scheduledTime: stop.scheduledTime ?? '',
        latitude: stop.latitude ?? '',
        longitude: stop.longitude ?? '',
      })),
    );
  }, [open, route, detail]);

  const update = (index, key, value) =>
    setStops((current) => current.map((stop, position) => (position === index ? { ...stop, [key]: value } : stop)));

  const add = () =>
    setStops((current) => [
      ...current,
      { sequence: current.length + 1, name: '', scheduledTime: '', latitude: '', longitude: '' },
    ]);

  const remove = (index) =>
    setStops((current) => current.filter((_, position) => position !== index));

  const move = (index, delta) =>
    setStops((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((stop, position) => ({ ...stop, sequence: position + 1 }));
    });

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      await api.put(`/routes/${route.id}/stops`, {
        stops: stops.map((stop, index) => ({
          sequence: index + 1,
          name: stop.name.trim(),
          scheduledTime: stop.scheduledTime || null,
          latitude: stop.latitude === '' ? null : Number(stop.latitude),
          longitude: stop.longitude === '' ? null : Number(stop.longitude),
        })),
      });
      toast.success(`Stops updated for ${route.code}.`);
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={`Stops on ${route?.code ?? ''}`}
      subtitle={route?.name}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || !stops.length}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            Save stops
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormError error={error} onDismiss={() => setError(null)} />

        {stops.length ? (
          <ul className="space-y-2">
            {stops.map((stop, index) => (
              <li key={index} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5">
                <div className="flex items-center gap-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-sky-500/12 text-[0.7rem] font-bold text-sky-400">
                    {index + 1}
                  </span>
                  <Input
                    wrapperClass="flex-1"
                    placeholder="Stop name"
                    value={stop.name}
                    onChange={(event) => update(index, 'name', event.target.value)}
                    disabled={saving}
                  />
                  <Input
                    wrapperClass="w-28"
                    type="time"
                    value={stop.scheduledTime ?? ''}
                    onChange={(event) => update(index, 'scheduledTime', event.target.value)}
                    disabled={saving}
                  />
                  <div className="flex shrink-0 gap-0.5">
                    <button type="button" className="btn btn-ghost !p-1" onClick={() => move(index, -1)} disabled={index === 0 || saving} aria-label="Move up">
                      <Icon name="chevronUp" className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="btn btn-ghost !p-1" onClick={() => move(index, 1)} disabled={index === stops.length - 1 || saving} aria-label="Move down">
                      <Icon name="chevronDown" className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="btn btn-danger !p-1" onClick={() => remove(index)} disabled={saving} aria-label="Remove stop">
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 pl-8">
                  <Input
                    type="number"
                    step="any"
                    placeholder="Latitude"
                    value={stop.latitude ?? ''}
                    onChange={(event) => update(index, 'latitude', event.target.value)}
                    disabled={saving}
                  />
                  <Input
                    type="number"
                    step="any"
                    placeholder="Longitude"
                    value={stop.longitude ?? ''}
                    onChange={(event) => update(index, 'longitude', event.target.value)}
                    disabled={saving}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : loadingStops ? (
          <div className="grid place-items-center py-6">
            <Spinner className="h-5 w-5 text-sky-400" />
          </div>
        ) : (
          <EmptyState icon="mapPin" title="No stops yet" message="Add the stops this route serves, in order." />
        )}

        <button type="button" className="btn btn-ghost w-full" onClick={add} disabled={saving}>
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add stop
        </button>
      </div>
    </Modal>
  );
}

function RouteDialog({ open, onClose, onSaved, route, isPlatform = false, tenantId = '', colleges = [] }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_ROUTE);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      route
        ? { ...EMPTY_ROUTE, ...route }
        : { ...EMPTY_ROUTE, tenantId: isPlatform ? (tenantId ?? '') : '' },
    );
  }, [open, route, isPlatform, tenantId]);

  const set = useCallback((key) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const fieldErrors = error?.fieldErrors ?? {};
  const invalidRange = form.departureTime && form.arrivalTime && form.departureTime >= form.arrivalTime;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload = { ...form };
      if (!route && isPlatform) {
        if (tenantId) payload.tenantId = tenantId;
        else delete payload.tenantId;
      } else {
        delete payload.tenantId;
      }
      if (route) {
        await api.patch(`/routes/${route.id}`, payload);
        toast.success(`${form.code} updated.`);
      } else {
        await api.post('/routes', payload);
        toast.success(`${form.code} route created.`);
      }
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={route ? `Edit ${route.code}` : 'Add a route'}
      size="lg"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" form="route-form" className="btn btn-primary" disabled={saving || invalidRange}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            {route ? 'Save changes' : 'Create route'}
          </button>
        </>
      }
    >
      <form id="route-form" onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} onDismiss={() => setError(null)} />

        <FormGrid columns={2}>
          <Input label="Route code" value={form.code} onChange={set('code')} error={fieldErrors.code} placeholder="R-05" required disabled={saving} className="font-mono uppercase" />
          <Input label="Name" value={form.name} onChange={set('name')} error={fieldErrors.name} placeholder="Balkhu – Ring Road" required disabled={saving} />
          <Input label="Start point" value={form.startPoint} onChange={set('startPoint')} error={fieldErrors.startPoint} placeholder="Balkhu Chowk" required disabled={saving} />
          <Input label="End point" value={form.endPoint} onChange={set('endPoint')} error={fieldErrors.endPoint} placeholder="Kalimati" required disabled={saving} />
          <SegmentedControl
            label="Shift"
            value={form.shift}
            onChange={set('shift')}
            options={['MORNING', 'EVENING', 'BOTH']}
            wrapperClass="sm:col-span-2"
          />
          <Input
            label="Departure"
            type="time"
            value={form.departureTime}
            onChange={set('departureTime')}
            error={fieldErrors.departureTime}
            disabled={saving}
          />
          <Input
            label="Arrival"
            type="time"
            value={form.arrivalTime}
            onChange={set('arrivalTime')}
            error={invalidRange ? 'Arrival must be after departure' : fieldErrors.arrivalTime}
            disabled={saving}
          />
          <Input label="Colour" type="color" value={form.color} onChange={set('color')} error={fieldErrors.color} disabled={saving} className="h-9 cursor-pointer" />
          <div className="flex items-end pb-1.5">
            <SegmentedControl
              label="Availability"
              value={form.isActive ? 'active' : 'inactive'}
              onChange={(value) => set('isActive')(value === 'active')}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
            />
          </div>
          <Textarea
            label="Description"
            value={form.description ?? ''}
            onChange={set('description')}
            error={fieldErrors.description}
            rows={2}
            className="sm:col-span-2"
            disabled={saving}
          />
        </FormGrid>
      </form>
    </Modal>
  );
}

function BusesTab({ onEdit, tenantId, isPlatform }) {
  const { can } = useAuth();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const debouncedSearch = useDebounced(search);

  const params = { search: debouncedSearch, status };
  if (isPlatform && tenantId) params.tenantId = tenantId;

  const { data, error, loading, reload } = useApi('/buses', {
    enabled: can('fleet:read'),
    params,
  });

  const buses = data?.buses ?? [];
  const summary = data?.summary;

  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.del(`/buses/${deleting.id}`);
      toast.success(`${deleting.code} removed from the fleet.`);
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
      key: 'code',
      label: 'Bus',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-mono text-[0.8rem] font-bold text-mist-100">{row.code}</p>
          <p className="truncate text-[0.7rem] text-mist-500">
            {row.name}
            {row.registrationNo ? ` · ${row.registrationNo}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'route',
      label: 'Route',
      render: (row) =>
        row.routeCode ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.routeColor }} aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-[0.76rem] text-mist-200">{row.routeCode} · {row.routeName}</p>
              <p className="tabular truncate text-[0.66rem] text-mist-500">
                {row.departureTime}–{row.arrivalTime} · {titleCase(row.routeShift)}
              </p>
            </div>
          </div>
        ) : (
          <Badge tone="warn">Unassigned</Badge>
        ),
    },
    {
      key: 'driver',
      label: 'Driver',
      render: (row) =>
        row.driverName ? (
          <div className="min-w-0">
            <p className="truncate text-[0.76rem] text-mist-200">{row.driverName}</p>
            <p className="truncate text-[0.66rem] text-mist-500">{row.driverPhone ?? ''}</p>
          </div>
        ) : (
          <span className="text-[0.72rem] text-mist-500">—</span>
        ),
    },
    {
      key: 'occupancy',
      label: 'Occupancy',
      width: '11rem',
      render: (row) => <OccupancyBar occupancy={row.occupancy ?? 0} capacity={row.seatCapacity ?? 0} />,
    },
    {
      key: 'allocated',
      label: 'Allocated',
      align: 'center',
      nowrap: true,
      render: (row) => <span className="tabular text-[0.78rem] text-mist-300">{row.assignedStudents ?? 0}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      nowrap: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          {can('fleet:edit') ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={() => onEdit(row)}
              aria-label={`Edit ${row.code}`}
            >
              <Icon name="edit" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('fleet:delete') ? (
            <button
              type="button"
              className="btn btn-danger !p-1.5"
              onClick={() => setDeleting(row)}
              aria-label={`Delete ${row.code}`}
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
      {summary ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Total buses" value={summary.total} icon="bus" tone="info" />
          <StatCard label="In service" value={summary.active} icon="check" tone="good" />
          <StatCard
            label="In maintenance"
            value={summary.maintenance}
            icon="settings"
            tone={summary.maintenance > 0 ? 'warn' : 'good'}
          />
          <StatCard label="Total seats" value={summary.capacity} icon="users" tone="accent" />
          <StatCard
            label="Fleet utilisation"
            value={summary.utilization}
            icon="activity"
            tone={summary.utilization > 75 ? 'warn' : 'good'}
          />
        </div>
      ) : null}

      <div className="card mb-4 p-3.5">
        <FilterBar onClear={search || status ? () => { setSearch(''); setStatus(''); } : undefined}>
          <Input
            wrapperClass="min-w-[13rem] flex-1"
            placeholder="Search by code, name or registration…"
            icon="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search buses"
          />
          <Select
            wrapperClass="w-44"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            options={['ACTIVE', 'MAINTENANCE', 'RETIRED']}
            placeholder="Any status"
          />
        </FilterBar>
      </div>

      <div className="card overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : buses.length === 0 && !loading ? (
          <EmptyState icon="bus" title="No buses found" message="Register a bus to assign it to a route." />
        ) : (
          <DataTable columns={columns} rows={buses} loading={loading} skeletonRows={6} />
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Remove bus"
        confirmLabel="Remove"
        message={deleting ? `Remove ${deleting.code} from the fleet? Students allocated to it will need reassigning.` : ''}
      />
    </>
  );
}

function RoutesTab({ onEdit, tenantId, isPlatform }) {
  const { can } = useAuth();
  const toast = useToast();

  const [stopsRoute, setStopsRoute] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const params = {};
  if (isPlatform && tenantId) params.tenantId = tenantId;

  const { data, error, loading, reload } = useApi('/routes', {
    enabled: can('fleet:read'),
    params,
  });

  const routes = data?.routes ?? [];

  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.del(`/routes/${deleting.id}`);
      toast.success(`${deleting.code} deleted.`);
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
      key: 'code',
      label: 'Route',
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: row.color }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-mono text-[0.8rem] font-bold text-mist-100">{row.code}</p>
            <p className="truncate text-[0.7rem] text-mist-500">{row.name}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'path',
      label: 'Path',
      render: (row) => (
        <p className="max-w-xs truncate text-[0.76rem] text-mist-300" title={`${row.startPoint} → ${row.endPoint}`}>
          {row.startPoint} <Icon name="arrowRight" className="mx-1 inline h-3 w-3 text-mist-500" />
          {row.endPoint}
        </p>
      ),
    },
    {
      key: 'schedule',
      label: 'Schedule',
      nowrap: true,
      render: (row) => (
        <div>
          <p className="tabular text-[0.76rem] text-mist-200">
            {row.departureTime} – {row.arrivalTime}
          </p>
          <p className="text-[0.66rem] text-mist-500">{titleCase(row.shift)}</p>
        </div>
      ),
    },
    {
      key: 'stops',
      label: 'Stops',
      align: 'center',
      nowrap: true,
      render: (row) => <span className="tabular text-[0.78rem] text-mist-300">{row.stopCount ?? row.stops?.length ?? 0}</span>,
    },
    {
      key: 'buses',
      label: 'Buses',
      align: 'center',
      nowrap: true,
      render: (row) => <span className="tabular text-[0.78rem] text-mist-300">{row.busCount ?? 0}</span>,
    },
    {
      key: 'isActive',
      label: 'Status',
      nowrap: true,
      render: (row) => (
        <StatusBadge status={row.isActive ? 'ACTIVE' : 'RETIRED'} label={row.isActive ? 'Active' : 'Inactive'} />
      ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          {can('fleet:edit') ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={() => setStopsRoute(row)}
              aria-label={`Edit stops on ${row.code}`}
              title="Stops"
            >
              <Icon name="mapPin" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('fleet:edit') ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={() => onEdit(row)}
              aria-label={`Edit ${row.code}`}
            >
              <Icon name="edit" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('fleet:delete') ? (
            <button
              type="button"
              className="btn btn-danger !p-1.5"
              onClick={() => setDeleting(row)}
              aria-label={`Delete ${row.code}`}
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
      <div className="card overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : routes.length === 0 && !loading ? (
          <EmptyState icon="route" title="No routes defined" message="Create a route to organise stops and shift timings." />
        ) : (
          <DataTable columns={columns} rows={routes} loading={loading} skeletonRows={5} />
        )}
      </div>

      <StopsDialog
        open={Boolean(stopsRoute)}
        onClose={() => setStopsRoute(null)}
        onSaved={() => reload({ silent: true })}
        route={stopsRoute}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Delete route"
        confirmLabel="Delete"
        message={deleting ? `Delete ${deleting.code} and all of its stops? Buses assigned to it will be unassigned.` : ''}
      />
    </>
  );
}


export default function Fleet() {
  const { can } = useAuth();
  const { isPlatform } = usePlatformScope();
  const { colleges } = useCampusDirectory(isPlatform);

  const [tenantId, setTenantId] = useState('');

  const [tab, setTab] = useState('buses');
  const [busDialog, setBusDialog] = useState({ open: false, bus: null });
  const [routeDialog, setRouteDialog] = useState({ open: false, route: null });

  const fleetParams = {};
  if (isPlatform && tenantId) fleetParams.tenantId = tenantId;

  // One shared reload keeps every tab's data consistent after a write.
  const { data: routeList, reload: reloadRoutes } = useApi('/routes', { enabled: can('fleet:read'), params: fleetParams });
  const { reload: reloadBuses } = useApi('/buses', { enabled: can('fleet:read'), params: fleetParams });

  const refreshAll = useCallback(() => {
    reloadBuses({ silent: true });
    reloadRoutes({ silent: true });
  }, [reloadBuses, reloadRoutes]);

  const availableTabs = useMemo(() => TABS.filter((entry) => can(entry.permission)), [can]);

  const createBus = () => setBusDialog({ open: true, bus: null });
  const editBus = (bus) => setBusDialog({ open: true, bus });
  const createRoute = () => setRouteDialog({ open: true, route: null });
  const editRoute = (route) => setRouteDialog({ open: true, route });

  return (
    <>
      <PageHeader
        title="Buses & Routes"
        subtitle="Fleet inventory, assignments and stop sequences"
        actions={
          can('fleet:create') ? (
            <button type="button" className="btn btn-primary" onClick={tab === 'buses' ? createBus : createRoute}>
              <Icon name="plus" className="h-3.5 w-3.5" />
              {tab === 'buses' ? 'Add bus' : 'Add route'}
            </button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex gap-1 border-b border-[var(--border-subtle)]">
          {availableTabs.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={`-mb-px border-b-2 px-3.5 py-2 text-[0.82rem] font-semibold transition ${
                tab === entry.key ? 'border-sky-500 text-sky-300' : 'border-transparent text-mist-500 hover:text-mist-300'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <CampusSelect isPlatform={isPlatform} colleges={colleges} value={tenantId} onChange={setTenantId} wrapperClass="w-60" />
      </div>

      {tab === 'buses' ? (
        <BusesTab onEdit={editBus} tenantId={tenantId} isPlatform={isPlatform} />
      ) : (
        <RoutesTab onEdit={editRoute} tenantId={tenantId} isPlatform={isPlatform} />
      )}

      <BusDialog
        open={busDialog.open}
        onClose={() => setBusDialog({ open: false, bus: null })}
        onSaved={refreshAll}
        bus={busDialog.bus}
        routes={routeList?.routes ?? []}
        isPlatform={isPlatform}
        tenantId={tenantId}
        colleges={colleges}
      />

      <RouteDialog
        open={routeDialog.open}
        onClose={() => setRouteDialog({ open: false, route: null })}
        onSaved={refreshAll}
        route={routeDialog.route}
        isPlatform={isPlatform}
        tenantId={tenantId}
        colleges={colleges}
      />
    </>
  );
}
