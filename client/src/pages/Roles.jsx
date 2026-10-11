import { useEffect, useMemo, useState } from 'react';

import { Icon } from '../components/Icon.jsx';
import { Badge, DataTable, EmptyState, ErrorState, Modal, PageHeader, Panel, Spinner } from '../components/ui.jsx';
import { Checkbox, FormError } from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { modulePermissionKeys } from '../lib/permissions.js';

/**
 * Role-level permission editing.
 *
 * Role grants are the baseline for every account using `INHERIT` mode, so a change
 * here affects many people at once. The UI therefore shows headcount and warns
 * about the blast radius before saving.
 */
function RolePermissionsDialog({ open, onClose, onSaved, role, modules, allPermissions }) {
  const toast = useToast();
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !role) return;
    setError(null);
    setSelected([...role.permissions]);
  }, [open, role]);

  const locked = role ? role.editable === false : true;

  const lockNote =
    role?.key === 'system_admin'
      ? 'The System Administrator role always holds every permission and cannot be edited.'
      : 'This role sits at or above your own level. Roles can only be edited from a strictly higher seniority level.';

  const toggle = (permission) =>
    setSelected((current) =>
      current.includes(permission) ? current.filter((value) => value !== permission) : [...current, permission],
    );

  const toggleModule = (module) => {
    const keys = modulePermissionKeys(module);
    const allOn = keys.length > 0 && keys.every((key) => selected.includes(key));
    setSelected((current) =>
      allOn ? current.filter((key) => !keys.includes(key)) : [...new Set([...current, ...keys])],
    );
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/roles/${role.key}/permissions`, { permissions: selected });
      toast.success(`${role.name} permissions updated. Inherited sessions were re-authorised.`);
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
      title={`Role permissions — ${role?.name ?? ''}`}
      subtitle={
        role
          ? `${role.headcount} active ${role.headcount === 1 ? 'account' : 'accounts'} currently inherit this role`
          : ''
      }
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || locked}
            title={locked ? 'System Administrator always holds every permission' : undefined}
          >
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            Save role
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError error={error} onDismiss={() => setError(null)} />

        {locked ? (
          <div className="rounded-xl bg-amber-500/[0.08] px-3.5 py-3 text-[0.76rem] leading-relaxed text-amber-300 ring-1 ring-amber-500/25">
            {lockNote}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[0.76rem] text-mist-400">
            <strong className="tabular text-mist-200">{selected.length}</strong> of {allPermissions.length} granted
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost !py-1 text-[0.72rem]" onClick={() => setSelected([...allPermissions])}>
              Select all
            </button>
            <button type="button" className="btn btn-ghost !py-1 text-[0.72rem]" onClick={() => setSelected([])}>
              Clear
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {modules.map((module) => {
            const keys = modulePermissionKeys(module);
            const count = keys.filter((key) => selected.includes(key)).length;
            const allOn = keys.length > 0 && count === keys.length;

            return (
              <div key={module.key} className="rounded-xl border border-[var(--border-subtle)] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[0.8rem] font-bold text-mist-100">{module.label}</p>
                    <p className="truncate text-[0.68rem] text-mist-500">{module.description}</p>
                  </div>
                  <Checkbox label={`${count}/${keys.length}`} checked={allOn} onChange={() => toggleModule(module)} disabled={locked} />
                </div>

                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {keys.map((permission) => (
                    <li key={permission}>
                      <Checkbox
                        label={permission.split(':')[1]}
                        hint={permission}
                        checked={selected.includes(permission)}
                        onChange={() => toggle(permission)}
                        disabled={locked}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/** Stable empty reference so `data?.x ?? EMPTY` stays memo-stable. */
const EMPTY = [];

export default function Roles() {
  const { user: currentUser } = useAuth();
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');

  const { data, error, loading, reload } = useApi('/roles');
  const rolesList = data?.roles ?? EMPTY;
  const modulesList = data?.modules ?? EMPTY;
  const allPermsList = data?.permissions ?? EMPTY;

  // Total-stealth client guard: the Level 200 role definition is never rendered
  // to a campus principal (`SUPER_ADMIN`-only unless role_level === 200), even
  // if a stale cache or proxy already delivered it.
  const roles = useMemo(
    () =>
      (rolesList ?? EMPTY).filter(
        (role) => Number(currentUser?.roleLevel ?? 200) >= 200 || Number(role.level ?? 0) < 200,
      ),
    [rolesList, currentUser],
  );
  const modules = modulesList;
  const allPermissions = allPermsList;
  const needle = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return roles;
    return roles.filter((role) =>
      [role.name, role.key, role.description].some((value) => (value ?? '').toLowerCase().includes(needle)),
    );
  }, [roles, needle]);

  const byModule = useMemo(() => {
    const summary = new Map();
    for (const role of roles) {
      for (const permission of role.permissions) {
        summary.set(permission, (summary.get(permission) ?? 0) + 1);
      }
    }
    return summary;
  }, [roles]);

  const columns = useMemo(
    () => [
      {
        key: 'name',
        label: 'Role',
        render: (row) => (
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-[0.82rem] font-semibold text-mist-100">
              {row.name}
              {row.key === 'system_admin' ? <Icon name="shield" className="h-3.5 w-3.5 text-amber-400" /> : null}
            </p>
            <p className="truncate font-mono text-[0.68rem] text-mist-500">{row.key}</p>
          </div>
        ),
      },
      {
        key: 'level',
        label: 'Level',
        align: 'center',
        nowrap: true,
        render: (row) => <span className="tabular text-[0.75rem] text-mist-300">{row.level}</span>,
      },
      {
        key: 'headcount',
        label: 'Accounts',
        align: 'center',
        nowrap: true,
        render: (row) =>
          row.headcount > 0 ? (
            <Badge tone="info">{row.headcount}</Badge>
          ) : (
            <span className="text-[0.72rem] text-mist-500">0</span>
          ),
      },
      {
        key: 'permissions',
        label: 'Permissions',
        render: (row) => (
          <div className="min-w-0">
            <p className="tabular text-[0.75rem] text-mist-300">{row.permissions.length} granted</p>
            <p className="truncate text-[0.67rem] text-mist-500">
              {row.permissions
                .slice()
                .sort()
                .slice(0, 4)
                .join(', ')}
              {row.permissions.length > 4 ? '…' : ''}
            </p>
          </div>
        ),
      },
      {
        key: 'actions',
        label: '',
        align: 'right',
        nowrap: true,
        render: (row) => (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setEditing(row)}
            disabled={!row.editable}
            title={row.editable ? 'Edit permissions' : 'At or above your own level — locked by seniority'}
          >
            <Icon name="shield" className="h-3.5 w-3.5" />
            Edit
          </button>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Roles"
        subtitle="What each role can see and do — the baseline every account inherits"
      />

      {error ? (
        <div className="card">
          <ErrorState error={error} onRetry={reload} />
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <div className="card overflow-hidden">
            <div className="border-b border-[var(--border-subtle)] p-3.5">
              <div className="relative">
                <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-mist-500" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter roles…"
                  aria-label="Filter roles"
                  className="input pl-9"
                />
              </div>
            </div>

            {filtered.length === 0 && !loading ? (
              <EmptyState icon="shield" title="No roles match" message="Try a different search term." />
            ) : (
              <DataTable columns={columns} rows={filtered} loading={loading} skeletonRows={4} />
            )}
          </div>

          <Panel title="Permission coverage" subtitle="How many roles hold each permission" icon="shield" bodyClass="p-0">
            <div className="max-h-[32rem] overflow-y-auto">
              {modules.map((module) => (
                <section key={module.key} className="border-b border-[var(--border-subtle)]/60 px-3.5 py-3 last:border-b-0">
                  <h3 className="mb-2 text-[0.68rem] font-bold tracking-[0.06em] text-mist-400 uppercase">
                    {module.label}
                  </h3>
                  <ul className="space-y-1.5">
                    {modulePermissionKeys(module).map((permission) => {
                      const count = byModule.get(permission) ?? 0;
                      return (
                        <li key={permission} className="flex items-center justify-between gap-3">
                          <span className="truncate font-mono text-[0.7rem] text-mist-400">{permission}</span>
                          <span
                            className={`tabular shrink-0 text-[0.7rem] font-semibold ${
                              count === 0 ? 'text-mist-500' : 'text-sky-400'
                            }`}
                          >
                            {count}/{roles.length}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </Panel>
        </div>
      )}

      <RolePermissionsDialog
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        onSaved={() => reload({ silent: true })}
        role={editing}
        modules={modules}
        allPermissions={allPermissions}
      />
    </>
  );
}
