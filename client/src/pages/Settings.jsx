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

export default function Settings() {
  const { can } = useAuth();
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

  const settings = data?.settings ?? EMPTY;
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
