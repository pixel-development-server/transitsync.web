import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../components/Icon.jsx';
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Spinner,
} from '../components/ui.jsx';
import { FormError, Input, Select, Toggle } from '../components/form.jsx';
import { api, download } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';
import { formatBytes, formatDateTime } from '../lib/format.js';

/** Stable empty reference so `data?.x ?? EMPTY` stays memo-stable. */
const EMPTY = [];

const GROUPS = [
  { key: 'general', label: 'General', icon: 'settings', description: 'Institution identity and locale' },
  { key: 'operations', label: 'Operations', icon: 'sliders', description: 'Rules that shape live decisions' },
  { key: 'security', label: 'Security', icon: 'shield', description: 'Retention and data lifecycle' },
];

/** Maps the API's camelCase patch body onto the snake_case setting keys. */
const FIELD_TO_BODY = {
  institution_name: 'institutionName',
  academic_year: 'academicYear',
  timezone: 'timezone',
  capacity_warning_pct: 'capacityWarningPct',
  alert_retention_days: 'alertRetentionDays',
  allow_self_service_rfid: 'allowSelfServiceRfid',
  maintenance_mode: 'maintenanceMode',
};

function SettingsGroup({ group, items, values, dirty, onChange, disabled }) {
  const fieldErrors = {};
  const groupIsDirty = items.some((item) => dirty.has(item.key));

  return (
    <Panel title={group.label} subtitle={group.description} icon={group.icon}>
      {groupIsDirty ? (
        <div className="mb-3.5 flex items-center justify-between gap-2 rounded-xl bg-amber-500/[0.08] px-3 py-2 ring-1 ring-amber-500/25">
          <span className="flex items-center gap-1.5 text-[0.72rem] font-medium text-amber-300">
            <Icon name="alert" className="h-3.5 w-3.5" />
            Unsaved changes in this group
          </span>
          <button
            type="button"
            className="btn btn-ghost !py-1 text-[0.72rem]"
            onClick={() => items.forEach((item) => onChange(item.key, item.value))}
            disabled={disabled}
          >
            Reset
          </button>
        </div>
      ) : null}

      <div className="space-y-3.5">
        {items.map((item) => {
          if (item.valueType === 'boolean') {
            return (
              <div key={item.key} className="rounded-xl bg-[var(--surface-sunken)] px-3.5 py-3">
                <Toggle
                  checked={Boolean(values[item.key])}
                  onChange={(next) => onChange(item.key, next)}
                  label={item.label}
                  hint={item.default !== undefined ? `Default: ${String(item.default)}` : undefined}
                  disabled={disabled}
                />
              </div>
            );
          }

          if (item.key === 'timezone') {
            return (
              <Select
                key={item.key}
                label={item.label}
                value={values[item.key] ?? ''}
                onChange={(event) => onChange(item.key, event.target.value)}
                options={TIMEZONES.map((zone) => ({ value: zone, label: zone }))}
                error={fieldErrors[item.key]}
                disabled={disabled}
              />
            );
          }

          return (
            <Input
              key={item.key}
              label={item.label}
              type={item.valueType === 'number' ? 'number' : 'text'}
              value={values[item.key] ?? ''}
              onChange={(event) =>
                onChange(item.key, item.valueType === 'number' ? Number(event.target.value) : event.target.value)
              }
              hint={item.updatedAt ? `Last changed ${formatDateTime(item.updatedAt)}` : 'Using default value'}
              error={fieldErrors[item.key]}
              disabled={disabled}
              min={item.valueType === 'number' ? 1 : undefined}
            />
          );
        })}
      </div>
    </Panel>
  );
}

const TIMEZONES = [
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Karachi',
  'Asia/Dubai',
  'Europe/London',
  'UTC',
];

function BackupsPanel() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const { data, error, loading, reload } = useApi('/settings/backups');
  const backups = data?.backups ?? [];

  const createBackup = useCallback(async () => {
    setBusy(true);
    try {
      const response = await api.post('/settings/backups', { label: 'Manual backup' });
      toast.success(`Backup ${response.data?.backup?.filename ?? 'created'}.`);
      reload({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  }, [reload, toast]);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await api.del(`/settings/backups/${encodeURIComponent(removing.filename)}`);
      toast.success(`${removing.filename} deleted.`);
      setRemoving(null);
      reload({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setDeleting(false);
    }
  }, [removing, reload, toast]);

  const downloadBackup = useCallback(async (file) => {
    try {
      await download(`/settings/backups/${encodeURIComponent(file.filename)}`, undefined, file.filename);
    } catch (caught) {
      toast.error(caught.message);
    }
  }, [toast]);

  const columns = [
    {
      key: 'filename',
      label: 'File',
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="database" className="h-3.5 w-3.5 shrink-0 text-mist-500" />
          <span className="truncate font-mono text-[0.72rem] text-mist-200">{row.filename}</span>
        </div>
      ),
    },
    {
      key: 'sizeBytes',
      label: 'Size',
      align: 'right',
      nowrap: true,
      render: (row) => <span className="tabular text-[0.74rem] text-mist-400">{formatBytes(row.sizeBytes)}</span>,
    },
    {
      key: 'createdAt',
      label: 'Created',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <span className="text-[0.72rem] text-mist-500" title={formatDateTime(row.createdAt)}>
          {formatDateTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            className="btn btn-ghost !p-1.5"
            onClick={() => downloadBackup(row)}
            aria-label={`Download ${row.filename}`}
            title="Download"
          >
            <Icon name="download" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="btn btn-danger !p-1.5"
            onClick={() => setRemoving(row)}
            aria-label={`Delete ${row.filename}`}
            title="Delete"
          >
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <Panel
      title="Database backups"
      subtitle="Point-in-time SQLite snapshots of every table"
      icon="database"
      actions={
        <button type="button" className="btn btn-primary" onClick={createBackup} disabled={busy || loading}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="database" className="h-3.5 w-3.5" />}
          Create backup
        </button>
      }
      bodyClass="p-0"
    >
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : backups.length === 0 && !loading ? (
        <EmptyState icon="database" title="No backups yet" message="Create a snapshot before making bulk changes." />
      ) : (
        <DataTable columns={columns} rows={backups} loading={loading} skeletonRows={3} />
      )}

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={confirmDelete}
        busy={deleting}
        title="Delete backup"
        confirmLabel="Delete"
        message={removing ? `${removing.filename} will be removed from disk permanently.` : ''}
      />
    </Panel>
  );
}

/**
 * System Control — master facilities that exist for the Level 100 System
 * Administrator only. The server enforces this with `requireSystemAdmin` on
 * every /api/admin route; the UI simply only renders for that role.
 */
function SystemControlPanel() {
  const { user } = useAuth();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [message, setMessage] = useState('');
  const [olderThanDays, setOlderThanDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // Tenant-scoped maintenance — THIS campus only. Other institutions are never
  // affected, and this System Administrator stays exempt so the switch can
  // always be turned back off.
  const [campusMaintenance, setCampusMaintenance] = useState(null);
  const [maintenanceNotice, setMaintenanceNotice] = useState('');
  const [busyMaintenance, setBusyMaintenance] = useState(false);

  const reload = useCallback(async () => {
    try {
      const response = await api.get('/admin/lockdown');
      setState(response.data);
    } catch {
      // Panel only renders for system admins; a transient failure is not fatal.
    }
  }, []);

  const reloadCampusMaintenance = useCallback(async () => {
    const tenantId = user?.tenantId;
    if (!tenantId) return;
    try {
      const response = await api.get(`/system/status?tenant_id=${encodeURIComponent(tenantId)}`);
      setCampusMaintenance(response.data ?? null);
    } catch {
      // Panel only renders for system admins; a transient failure is not fatal.
    }
  }, [user]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    reloadCampusMaintenance();
  }, [reloadCampusMaintenance]);

  const toggleLockdown = useCallback(async () => {
    setBusy(true);
    try {
      await api.post('/admin/lockdown', {
        locked: !(state?.locked ?? false),
        message: message.trim() || undefined,
      });
      toast.success(state?.locked ? 'Emergency lockout cleared.' : 'Global emergency lockout engaged.');
      setMessage('');
      await reload();
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  }, [state, message, reload, toast]);

  const toggleCampusMaintenance = useCallback(async () => {
    setBusyMaintenance(true);
    const nextEnabled = !(campusMaintenance?.isMaintenanceMode ?? false);
    try {
      const response = await api.put('/institution/maintenance', {
        enabled: nextEnabled,
        message: maintenanceNotice.trim() || undefined,
      });
      setCampusMaintenance(response.data ?? null);
      setMaintenanceNotice('');
      toast.success(
        nextEnabled
          ? 'Campus maintenance engaged — only this campus is affected.'
          : 'Campus maintenance cleared.',
      );
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusyMaintenance(false);
    }
  }, [campusMaintenance, maintenanceNotice, toast]);

  const archiveAudit = useCallback(async () => {
    setBusy(true);
    try {
      const filename = await download('/admin/audit/export', undefined, 'audit-archive.csv');
      toast.success(`${filename ?? 'Audit archive'} downloaded.`);
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const purgeAudit = useCallback(async () => {
    setConfirmPurge(false);
    setBusy(true);
    try {
      const days = Number(olderThanDays) || 0;
      const response = await api.post('/admin/audit/purge', { olderThanDays: days });
      toast.success(response.data.message);
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  }, [olderThanDays, toast]);

  const revokeAll = useCallback(async () => {
    setConfirmRevoke(false);
    setBusy(true);
    try {
      const response = await api.post('/admin/sessions/revoke', { all: true });
      toast.success(response.data.message);
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  }, [toast]);

  return (
    <Panel
      title="System Control"
      subtitle="Master facilities — System Administrator only"
      icon="shield"
      className="mt-4"
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <section className="rounded-xl bg-[var(--surface-sunken)] px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-[0.82rem] font-semibold text-mist-100">Global emergency lockout</h4>
              <p className="mt-0.5 text-[0.72rem] leading-relaxed text-mist-500">
                {state?.locked
                  ? `Engaged by ${state.by ?? 'System Administrator'}${state.at ? ` · ${formatDateTime(state.at)}` : ''}. Every non-admin session is frozen.`
                  : 'Freeze every non-System-Administrator session during maintenance.'}
              </p>
            </div>
            <button
              type="button"
              className={`btn ${state?.locked ? 'btn-danger' : 'btn-ghost'} shrink-0`}
              onClick={toggleLockdown}
              disabled={busy}
            >
              {state?.locked ? 'Clear lockout' : 'Engage lockout'}
            </button>
          </div>
          <label className="mt-3 block">
            <span className="text-[0.68rem] tracking-[0.05em] text-mist-500 uppercase">
              Notice shown to blocked staff (optional)
            </span>
            <Input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="e.g. Scheduled maintenance until 18:00"
              disabled={busy}
              className="mt-1"
            />
          </label>
        </section>

        <section className="rounded-xl bg-[var(--surface-sunken)] px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-[0.82rem] font-semibold text-mist-100">Campus maintenance mode</h4>
              <p className="mt-0.5 text-[0.72rem] leading-relaxed text-mist-500">
                {user?.institutionName ? (
                  <>
                    Put <span className="font-semibold text-mist-300">{user?.institutionName}</span> into
                    maintenance. Only that campus's users are blocked from sign-in and live sessions —
                    every other institution keeps working. You stay signed in so maintenance can be
                    turned back off.
                  </>
                ) : (
                  'Put this campus into maintenance. Only its users are blocked from sign-in and live sessions — every other institution keeps working.'
                )}
              </p>
            </div>
            <button
              type="button"
              className={`btn shrink-0 ${campusMaintenance?.isMaintenanceMode ? 'btn-danger' : 'btn-ghost'}`}
              onClick={toggleCampusMaintenance}
              disabled={busyMaintenance}
            >
              {campusMaintenance?.isMaintenanceMode ? 'End maintenance' : 'Start maintenance'}
            </button>
          </div>
          <label className="mt-3 block">
            <span className="text-[0.68rem] tracking-[0.05em] text-mist-500 uppercase">
              Notice shown to this campus (optional)
            </span>
            <Input
              value={maintenanceNotice}
              onChange={(event) => setMaintenanceNotice(event.target.value)}
              placeholder="This campus transport system is currently under maintenance."
              disabled={busyMaintenance}
              className="mt-1"
            />
          </label>
        </section>

        <section className="rounded-xl bg-[var(--surface-sunken)] px-4 py-3.5">
          <h4 className="text-[0.82rem] font-semibold text-mist-100">Audit trail archive &amp; purge</h4>
          <p className="mt-0.5 text-[0.72rem] leading-relaxed text-mist-500">
            Download the full trail as a CSV, then flush entries older than the cut-off below.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-ghost" onClick={archiveAudit} disabled={busy}>
              <Icon name="download" className="h-3.5 w-3.5" />
              Archive CSV
            </button>
            <div className="ml-auto flex items-center gap-2">
              <Input
                value={olderThanDays}
                onChange={(event) => setOlderThanDays(event.target.value.replace(/[^\d]/g, ''))}
                aria-label="Purge entries older than (days)"
                className="!w-16 text-center"
                disabled={busy}
              />
              <span className="cursor-default text-[0.68rem] text-mist-500">days</span>
              <button
                type="button"
                className="btn btn-ghost !text-rose-300"
                onClick={() => setConfirmPurge(true)}
                disabled={busy}
              >
                Purge
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-xl bg-[var(--surface-sunken)] px-4 py-3.5 sm:col-span-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h4 className="text-[0.82rem] font-semibold text-mist-100">Session &amp; password override</h4>
              <p className="mt-0.5 text-[0.72rem] leading-relaxed text-mist-500">
                Force a password reset on any staff member — including peers and other System Administrators — without
                seniority limits (use the reset action on a user row), or sign everyone out at once.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost !text-rose-300 shrink-0"
              onClick={() => setConfirmRevoke(true)}
              disabled={busy}
            >
              Revoke all sessions
            </button>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmPurge}
        onClose={() => setConfirmPurge(false)}
        onConfirm={purgeAudit}
        busy={busy}
        title="Purge audit log"
        confirmLabel="Purge entries"
        message={`Delete every audit entry older than ${Number(olderThanDays) || 0} days? This cannot be undone — download a CSV archive first if you need the record.`}
      />
      <ConfirmDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={revokeAll}
        busy={busy}
        title="Revoke all sessions"
        confirmLabel="Revoke all"
        message="Every active session across every role is signed out, including other System Administrators. Your own session is kept."
      />
    </Panel>
  );
}

export default function Settings() {
  const { can, user } = useAuth();
  const toast = useToast();
  const canEdit = can('settings:edit');

  const [values, setValues] = useState({});
  const [dirty, setDirty] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const hydrated = useRef(false);

  const { data, error: loadError, reload } = useApi('/settings', {
    enabled: can('settings:read'),
  });

  // The platform-wide maintenance switch is the Super Administrator's facility
  // (super-admin console), and campus-level maintenance is managed from the
  // System Control panel below — exposing the raw `settings` rows here invites a
  // campus admin to take the WHOLE platform down with one toggle.
  const settings = (data?.settings ?? EMPTY).filter(
    (item) => item.key !== 'maintenance_mode' && item.key !== 'maintenance_message',
  );
  const system = data?.system;

  // Seed the form once, then let local edits win.
  useEffect(() => {
    if (hydrated.current || !settings.length) return;
    setValues(Object.fromEntries(settings.map((item) => [item.key, item.value])));
    hydrated.current = true;
  }, [settings]);

  const change = useCallback((key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  const grouped = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: settings.filter((item) => item.group === group.key),
      })).filter((group) => group.items.length),
    [settings],
  );

  const ungrouped = useMemo(
    () => settings.filter((item) => !GROUPS.some((group) => group.key === item.group)),
    [settings],
  );

  const patch = useMemo(() => {
    const body = {};
    for (const key of dirty) {
      const field = FIELD_TO_BODY[key];
      if (field) body[field] = values[key];
    }
    return body;
  }, [dirty, values]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch('/settings', patch);
      toast.success('Settings saved.');
      setDirty(new Set());
      reload({ silent: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
      setConfirmSave(false);
    }
  }, [patch, reload, toast]);

  const discard = useCallback(() => {
    setValues(Object.fromEntries(settings.map((item) => [item.key, item.value])));
    setDirty(new Set());
    setError(null);
  }, [settings]);

  if (!can('settings:read')) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Institution configuration" />
        <div className="card">
          <EmptyState icon="lock" title="Not permitted" message="You do not have settings:read access." />
        </div>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <PageHeader title="Settings" subtitle="Institution configuration" />
        <div className="card">
          <ErrorState error={loadError} onRetry={reload} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Institution configuration applied across the console"
        actions={
          <>
            {dirty.size > 0 ? (
              <button type="button" className="btn btn-ghost" onClick={discard} disabled={saving}>
                Discard {dirty.size} change{dirty.size === 1 ? '' : 's'}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setConfirmSave(true)}
              disabled={!canEdit || dirty.size === 0 || saving}
            >
              {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
              Save changes
            </button>
          </>
        }
      />

      {!canEdit ? (
        <p className="card mb-4 flex items-center gap-2 px-3.5 py-2.5 text-[0.76rem] text-mist-400">
          <Badge tone="warn">Read only</Badge>
          You can review configuration but need settings:edit to change it.
        </p>
      ) : null}

      <div className="mb-4">
        <FormError error={error} onDismiss={() => setError(null)} />
      </div>

      {system ? (
        <Panel title="System" subtitle="Build and database counters" icon="info" className="mb-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              { label: 'Version', value: system.version },
              { label: 'Environment', value: system.nodeEnv },
              { label: 'Database size', value: formatBytes(system.databaseSizeBytes) },
              { label: 'Permissions', value: system.permissions },
              { label: 'Roles', value: system.roles },
            ].map((entry) => (
              <div key={entry.label} className="rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5">
                <dt className="text-[0.64rem] tracking-[0.06em] text-mist-500 uppercase">{entry.label}</dt>
                <dd className="mt-0.5 truncate text-[0.86rem] font-bold text-mist-100">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {grouped.map((group) => (
          <SettingsGroup
            key={group.key}
            group={group}
            items={group.items}
            values={values}
            dirty={dirty}
            onChange={change}
            disabled={!canEdit || saving}
          />
        ))}

        {ungrouped.length ? (
          <SettingsGroup
            group={{ key: 'other', label: 'Other', icon: 'sliders', description: 'Additional configuration' }}
            items={ungrouped}
            values={values}
            dirty={dirty}
            onChange={change}
            disabled={!canEdit || saving}
          />
        ) : null}
      </div>

      {can('settings:export') ? (
        <div className="mt-4">
          <BackupsPanel />
        </div>
      ) : null}

      {user?.role === 'system_admin' ? <SystemControlPanel /> : null}

      <ConfirmDialog
        open={confirmSave}
        onClose={() => setConfirmSave(false)}
        onConfirm={save}
        busy={saving}
        title="Apply settings"
        confirmLabel="Save changes"
        message={`Apply ${dirty.size} change${dirty.size === 1 ? '' : 's'}? These values affect live decision rules immediately.`}
      />
    </>
  );
}

