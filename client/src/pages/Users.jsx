import { useCallback, useEffect, useState } from 'react';

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
  Panel,
  Spinner,
  StatusBadge,
} from '../components/ui.jsx';
import {
  Checkbox,
  FilterBar,
  FormError,
  FormGrid,
  Input,
  SegmentedControl,
  Select,
  Toggle,
} from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi, useDebounced, usePagination } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime, formatRelative, initials, titleCase } from '../lib/format.js';

const EMPTY_USER = {
  email: '',
  fullName: '',
  roleId: '',
  jobTitle: '',
  department: '',
  phone: '',
  temporaryPassword: '',
  permissionsMode: 'INHERIT',
  permissions: [],
  forcePasswordChange: true,
};

/**
 * Stable empty reference. A fresh `[]` literal on every render would make each
 * downstream useMemo re-evaluate on every render.
 */
const EMPTY = [];

/** Roles are keyed by key in the API but referenced by id in forms. */
function roleIdFor(roles, key) {
  return roles?.roles?.find((role) => role.key === key)?.id ?? roles?.roles?.[0]?.id ?? '';
}

/**
 * Per-user permission editor.
 *
 * `INHERIT` means "whatever the role grants" — the common case and the default.
 * `CUSTOM` replaces the role grants entirely with the ticks below, which is why
 * the role summary is shown as a reference rather than applied.
 */
function PermissionsDialog({ open, onClose, onSaved, user, roles, permissionMatrix }) {
  const toast = useToast();
  const [mode, setMode] = useState('INHERIT');
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !user) return;
    setError(null);
    setMode(user.permissionsMode === 'CUSTOM' ? 'CUSTOM' : 'INHERIT');
    setSelected(user.overrides?.length ? [...user.overrides] : [...(user.permissions ?? [])]);
  }, [open, user]);

  const modules = permissionMatrix?.modules ?? EMPTY;
  const role = roles?.roles?.find((entry) => entry.key === user?.role);

  const toggle = (permission) =>
    setSelected((current) =>
      current.includes(permission) ? current.filter((value) => value !== permission) : [...current, permission],
    );

  const toggleModule = (module) => {
    const keys = module.permissions ?? [];
    const allOn = keys.every((key) => selected.includes(key));
    setSelected((current) =>
      allOn
        ? current.filter((key) => !keys.includes(key))
        : [...new Set([...current, ...keys])],
    );
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/users/${user.id}/permissions`, {
        permissionsMode: mode,
        permissions: mode === 'CUSTOM' ? selected : [],
      });
      toast.success(`Permissions updated for ${user.fullName}.`);
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
      title={`Permissions — ${user?.fullName ?? ''}`}
      subtitle={user?.email}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            Save permissions
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError error={error} onDismiss={() => setError(null)} />

        <SegmentedControl
          label="Permission mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'INHERIT', label: `Inherit from ${user?.roleName ?? 'role'}` },
            { value: 'CUSTOM', label: 'Custom overrides' },
          ]}
        />

        {mode === 'INHERIT' ? (
          <div className="rounded-xl bg-[var(--surface-sunken)] px-3.5 py-3">
            <p className="mb-2 text-[0.74rem] leading-relaxed text-mist-400">
              This account uses its role's permissions. Any previously saved overrides are cleared when you save
              in this mode.
            </p>
            <div className="flex flex-wrap gap-1">
              {(role?.permissions ?? []).map((permission) => (
                <Badge key={permission} tone="info">
                  {permission}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <>
            <p className="text-[0.74rem] leading-relaxed text-mist-400">
              Custom mode <strong className="text-mist-200">replaces</strong> the role's permissions. Only what is
              ticked here will apply.
            </p>

            <div className="space-y-2">
              {modules.map((module) => {
                const keys = module.permissions ?? [];
                const count = keys.filter((key) => selected.includes(key)).length;
                const allOn = keys.length > 0 && count === keys.length;

                return (
                  <div key={module.key} className="rounded-xl border border-[var(--border-subtle)] p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[0.8rem] font-bold text-mist-100">{module.label}</p>
                        <p className="truncate text-[0.68rem] text-mist-500">{module.description}</p>
                      </div>
                      <Checkbox
                        label={`${count}/${keys.length}`}
                        checked={allOn}
                        onChange={() => toggleModule(module)}
                      />
                    </div>

                    <ul className="grid gap-1.5 sm:grid-cols-2">
                      {keys.map((permission) => (
                        <li key={permission}>
                          <Checkbox
                            label={permission.split(':')[1]}
                            hint={permission}
                            checked={selected.includes(permission)}
                            onChange={() => toggle(permission)}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            <p className="text-[0.72rem] text-mist-500">
              {selected.length} of {permissionMatrix?.permissions?.length ?? 0} permissions selected.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

function UserDialog({ open, onClose, onSaved, user, roles }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_USER);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setShowPassword(false);
    setForm(
      user
        ? {
            ...EMPTY_USER,
            email: user.email,
            fullName: user.fullName,
            roleId: String(roleIdFor(roles, user.role)),
            jobTitle: user.jobTitle ?? '',
            department: user.department ?? '',
            phone: user.phone ?? '',
          }
        : { ...EMPTY_USER, roleId: String(roles?.roles?.[0]?.id ?? '') },
    );
  }, [open, user, roles]);

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
    try {
      if (user) {
        await api.patch(`/users/${user.id}`, {
          fullName: form.fullName.trim(),
          roleId: Number(form.roleId),
          jobTitle: form.jobTitle.trim() || null,
          department: form.department.trim() || null,
          phone: form.phone.trim() || null,
        });
        toast.success(`${form.fullName} updated.`);
      } else {
        await api.post('/users', {
          email: form.email.trim().toLowerCase(),
          fullName: form.fullName.trim(),
          roleId: Number(form.roleId),
          jobTitle: form.jobTitle.trim() || null,
          department: form.department.trim() || null,
          phone: form.phone.trim() || null,
          temporaryPassword: form.temporaryPassword || undefined,
          permissionsMode: 'INHERIT',
          forcePasswordChange: true,
        });
        toast.success(`${form.fullName} added. They must change the password at first sign-in.`);
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
      title={user ? `Edit ${user.fullName}` : 'Create a staff account'}
      subtitle={user ? user.email : 'Accounts start with a temporary password that must be rotated on first sign-in.'}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" form="user-form" className="btn btn-primary" disabled={saving}>
            {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            {user ? 'Save changes' : 'Create account'}
          </button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} onDismiss={() => setError(null)} />

        <FormGrid columns={2}>
          <Input
            label="Full name"
            value={form.fullName}
            onChange={set('fullName')}
            error={fieldErrors.fullName}
            required
            disabled={saving}
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={set('email')}
            error={fieldErrors.email}
            required
            disabled={saving || Boolean(user)}
          />
          <Select
            label="Role"
            value={form.roleId}
            onChange={set('roleId')}
            error={fieldErrors.roleId}
            options={(roles?.roles ?? []).map((role) => ({
              value: role.id,
              label: `${role.name} (level ${role.level})`,
            }))}
            required
            disabled={saving}
          />
          <Input label="Job title" value={form.jobTitle} onChange={set('jobTitle')} error={fieldErrors.jobTitle} disabled={saving} />
          <Input label="Department" value={form.department} onChange={set('department')} error={fieldErrors.department} disabled={saving} />
          <Input label="Phone" value={form.phone} onChange={set('phone')} error={fieldErrors.phone} disabled={saving} />
        </FormGrid>

        {!user ? (
          <div className="rounded-xl bg-[var(--surface-sunken)] p-3.5">
            <Toggle
              checked={showPassword}
              onChange={setShowPassword}
              label="Set a temporary password"
              hint="Leave off to have one generated automatically."
            />
            {showPassword ? (
              <div className="mt-3">
                <Input
                  label="Temporary password"
                  value={form.temporaryPassword}
                  onChange={set('temporaryPassword')}
                  error={fieldErrors.temporaryPassword}
                  placeholder="At least 10 characters"
                  disabled={saving}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

export default function Users() {
  const { can, user: currentUser } = useAuth();
  const toast = useToast();
  const { page, limit, goToPage, changeLimit, reset } = usePagination({ defaultLimit: 25 });

  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState({ key: 'created', direction: 'desc' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [permUser, setPermUser] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [resetting, setResetting] = useState(null);

  const debouncedSearch = useDebounced(search);

  useEffect(() => {
    reset();
  }, [debouncedSearch, role, status, reset]);

  const { data, error, loading, reload } = useApi('/users', {
    enabled: can('users:read'),
    params: { page, limit, search: debouncedSearch, role, status, sort: sort.key, order: sort.direction },
  });
  const { data: roles } = useApi('/roles', { enabled: can('roles:read') || can('users:read') });
  const { data: matrix } = useApi('/users/matrix', {
    enabled: can('users:assign_permissions'),
  });

  const users = data?.users ?? EMPTY;
  const meta = data?.meta;

  const clearFilters = () => {
    setSearch('');
    setRole('');
    setStatus('');
  };

  const confirmDelete = async () => {
    setDeleteBusy(true);
    try {
      await api.del(`/users/${deleting.id}`);
      toast.success(`${deleting.fullName} removed.`);
      setDeleting(null);
      reload({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const forceReset = async () => {
    try {
      await api.post(`/users/${resetting.id}/force-password-reset`);
      toast.success(`${resetting.fullName} must change their password at next sign-in.`);
      setResetting(null);
      reload({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    }
  };

  const columns = [
    {
      key: 'fullName',
      label: 'User',
      sortKey: 'name',
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-sky-500 text-[0.65rem] font-bold text-white">
            {initials(row.fullName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.82rem] font-semibold text-mist-100">
              {row.fullName}
              {row.id === currentUser?.id ? (
                <span className="ml-1.5 text-[0.66rem] font-normal text-sky-400">you</span>
              ) : null}
            </p>
            <p className="truncate text-[0.7rem] text-mist-500">{row.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      nowrap: true,
      render: (row) => (
        <div className="flex flex-col gap-1">
          <Badge tone={row.roleLevel >= 100 ? 'accent' : row.roleLevel >= 50 ? 'info' : 'neutral'}>
            {row.roleName ?? row.role}
          </Badge>
          <StatusBadge
            status={row.permissionsMode}
            label={row.permissionsMode === 'CUSTOM' ? 'Custom' : 'Inherited'}
          />
        </div>
      ),
    },
    {
      key: 'permissions',
      label: 'Effective access',
      render: (row) => (
        <div className="min-w-0">
          <p className="tabular text-[0.75rem] text-mist-300">{row.permissions?.length ?? 0} permissions</p>
          <p className="truncate text-[0.67rem] text-mist-500">
            {(row.permissions ?? []).slice(0, 3).join(', ')}
            {(row.permissions?.length ?? 0) > 3 ? '…' : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'sessions',
      label: 'Sessions',
      align: 'center',
      nowrap: true,
      render: (row) =>
        row.activeSessions > 0 ? (
          <Badge tone="good" dot>
            {row.activeSessions}
          </Badge>
        ) : (
          <span className="text-[0.72rem] text-mist-500">0</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      nowrap: true,
      render: (row) => (
        <div className="flex flex-col gap-1">
          <StatusBadge status={row.status?.toUpperCase()} label={titleCase(row.status)} />
          {row.forcePasswordReset ? <Badge tone="warn">Must reset</Badge> : null}
          {row.isFirstLogin && !row.forcePasswordReset ? <Badge tone="warn">First login</Badge> : null}
        </div>
      ),
    },
    {
      key: 'lastLoginAt',
      label: 'Last sign-in',
      align: 'right',
      nowrap: true,
      sortKey: 'lastLogin',
      render: (row) => (
        <span className="text-[0.72rem] text-mist-500" title={formatDateTime(row.lastLoginAt)}>
          {row.lastLoginAt ? formatRelative(row.lastLoginAt) : 'Never'}
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
          {can('users:edit') && row.id !== currentUser?.id ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={() => {
                setEditing(row);
                setDialogOpen(true);
              }}
              aria-label={`Edit ${row.fullName}`}
              title="Edit"
            >
              <Icon name="edit" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('users:edit') ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={() => setResetting(row)}
              aria-label={`Force password reset for ${row.fullName}`}
              title="Force password reset"
            >
              <Icon name="key" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('users:assign_permissions') ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={() => setPermUser(row)}
              aria-label={`Edit permissions for ${row.fullName}`}
              title="Permissions"
            >
              <Icon name="shield" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('users:delete') && row.id !== currentUser?.id ? (
            <button
              type="button"
              className="btn btn-danger !p-1.5"
              onClick={() => setDeleting(row)}
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
        title="Users"
        subtitle="Staff accounts, roles and effective permissions"
        actions={
          can('users:create') ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Icon name="plus" className="h-3.5 w-3.5" />
              New user
            </button>
          ) : null
        }
      />

      <div className="card mb-4 p-3.5">
        <FilterBar onClear={search || role || status ? clearFilters : undefined}>
          <Input
            wrapperClass="min-w-[13rem] flex-1"
            placeholder="Search name or email…"
            icon="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search users"
          />
          <Select
            wrapperClass="w-52"
            label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            options={(roles?.roles ?? []).map((entry) => ({ value: entry.key, label: entry.name }))}
            placeholder="Any role"
          />
          <Select
            wrapperClass="w-40"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'suspended', label: 'Suspended' },
              { value: 'invited', label: 'Invited' },
            ]}
            placeholder="Any status"
          />
        </FilterBar>
      </div>

      <div className="card overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : users.length === 0 && !loading ? (
          <EmptyState icon="users" title="No users found" message="Adjust the filters or create a staff account." />
        ) : (
          <>
            <DataTable columns={columns} rows={users} loading={loading} sort={sort} onSort={setSort} skeletonRows={6} />
            <Pagination meta={meta} limit={limit} onLimitChange={changeLimit} onPageChange={goToPage} />
          </>
        )}
      </div>

      <UserDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => reload({ silent: true })}
        user={editing}
        roles={roles}
      />

      <PermissionsDialog
        open={Boolean(permUser)}
        onClose={() => setPermUser(null)}
        onSaved={() => reload({ silent: true })}
        user={permUser}
        roles={roles}
        permissionMatrix={matrix}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
        title="Delete user"
        confirmLabel="Delete"
        message={deleting ? `Delete ${deleting.fullName} (${deleting.email})? Their audit history is retained.` : ''}
      />

      <ConfirmDialog
        open={Boolean(resetting)}
        onClose={() => setResetting(null)}
        onConfirm={forceReset}
        title="Force password reset"
        confirmLabel="Force reset"
        tone="danger"
        message={
          resetting
            ? `${resetting.fullName} will be required to change their password at the next sign-in, and all other active sessions will be revoked.`
            : ''
        }
      />
    </>
  );
}

export { Panel };