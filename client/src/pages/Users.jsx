import { useCallback, useEffect, useMemo, useState } from 'react';

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
} from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { copyText, useApi, useDebounced, usePagination } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime, formatRelative, initials, titleCase } from '../lib/format.js';
import { modulePermissionKeys } from '../lib/permissions.js';
import { useCampusDirectory } from '../components/CampusScope.jsx';

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
  tenantId: '',
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
    setMode(user?.permissionsMode === 'CUSTOM' ? 'CUSTOM' : 'INHERIT');
    setSelected(user?.overrides?.length ? [...user?.overrides] : [...(user?.permissions ?? [])]);
  }, [open, user]);

  const modules = permissionMatrix?.modules ?? EMPTY;
  const role = roles?.roles?.find((entry) => entry.key === user?.role);

  const toggle = (permission) =>
    setSelected((current) =>
      current.includes(permission) ? current.filter((value) => value !== permission) : [...current, permission],
    );

  const toggleModule = (module) => {
    const keys = modulePermissionKeys(module);
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
      await api.put(`/users/${user?.id}/permissions`, {
        permissionsMode: mode,
        permissions: mode === 'CUSTOM' ? selected : [],
      });
      toast.success(`Permissions updated for ${user?.fullName}.`);
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

function UserDialog({ open, onClose, onSaved, onCreated, user, roles, currentUser, colleges = [] }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_USER);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Seniority rule on the client too: an actor can only hand out roles that
  // sit strictly below their own level — including at Level 200, which must
  // never mint a peer Super Administrator (the server rejects it regardless).
  const assignableRoles = useMemo(() => {
    const list = roles?.roles ?? [];
    const level = Number(currentUser?.roleLevel ?? 200);
    if (level >= 200) return list;
    return list.filter((role) => Number(role.level) < level);
  }, [roles, currentUser]);

  const isPlatformActor = Number(currentUser?.roleLevel ?? 0) >= 200;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      user
        ? {
            ...EMPTY_USER,
            email: user?.email,
            fullName: user?.fullName,
            roleId: String(roleIdFor(roles, user?.role)),
            jobTitle: user?.jobTitle ?? '',
            department: user?.department ?? '',
            phone: user?.phone ?? '',
            tenantId: user?.tenantId ?? '',
          }
        : { ...EMPTY_USER, roleId: String(assignableRoles[0]?.id ?? ''), tenantId: '' },
    );
  }, [open, user, roles, assignableRoles, currentUser]);

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

    const email = form.email.trim().toLowerCase();
    // Client-side gate for the two hard requirements before anything touches
    // the network. The server validates authoritatively on top of this.
    if (!email.includes('@')) {
      setError({
        message: 'Check the highlighted fields.',
        fieldErrors: {
          email: "Please enter a valid email address containing '@' (e.g., admin@iic.edu.np).",
        },
      });
      return;
    }
    if (!user && !form.temporaryPassword.trim()) {
      setError({
        message: 'Check the highlighted fields.',
        fieldErrors: { temporaryPassword: 'A temporary password is required.' },
      });
      return;
    }

    setSaving(true);
    try {
      if (user) {
        await api.patch(`/users/${user?.id}`, {
          fullName: form.fullName.trim(),
          roleId: Number(form.roleId),
          jobTitle: form.jobTitle.trim() || null,
          department: form.department.trim() || null,
          phone: form.phone.trim() || null,
        });
        toast.success(`${form.fullName} updated.`);
      } else {
        const payload = {
          email,
          fullName: form.fullName.trim(),
          roleId: Number(form.roleId),
          jobTitle: form.jobTitle.trim() || null,
          department: form.department.trim() || null,
          phone: form.phone.trim() || null,
          temporaryPassword: form.temporaryPassword.trim() || undefined,
          permissionsMode: 'INHERIT',
          forcePasswordChange: true,
        };
        if (isPlatformActor) {
          const role = roles?.roles?.find((r) => String(r.id) === String(form.roleId));
          const isPlatformRole = Number(role.level) >= 200;
          if (isPlatformRole) {
            // Platform Super Administrator is not bound to a campus tenant.
          } else if (form.tenantId) {
            payload.tenantId = form.tenantId;
          }
        }
        const response = await api.post('/users', payload);
        // Either a one-time temporary password comes back (hand it to the
        // parent so it can be shown before it is gone forever), or the account
        // was created passwordless and its owner sets one at first sign-in.
        onCreated?.({
          fullName: form.fullName.trim(),
          email,
          temporaryPassword: response?.data?.temporaryPassword ?? '',
          mustSetPassword: Boolean(response?.data?.mustSetPassword),
        });
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
      title={user ? `Edit ${user?.fullName}` : 'Create a staff account'}
      subtitle={user ? user?.email : 'Name the account, pick a role and set a temporary password to hand over.'}
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
            options={assignableRoles.map((role) => ({
              value: role.id,
              label: `${role.name} (level ${role.level})`,
            }))}
            required
            disabled={saving}
          />
          {isPlatformActor && !user ? (() => {
            const selectedRole = roles?.roles?.find((r) => String(r.id) === String(form.roleId));
            const isPlatformRole = selectedRole ? Number(selectedRole.level) >= 200 : false;
            if (isPlatformRole) return null;
            return (
              <Select
                label="Campus"
                value={form.tenantId}
                onChange={set('tenantId')}
                error={fieldErrors.tenantId}
                options={colleges.map((college) => ({
                  value: college.id,
                  label: college.name,
                }))}
                placeholder="Select a campus"
                required
                disabled={saving}
              />
            );
          })() : null}
          <Input label="Job title" value={form.jobTitle} onChange={set('jobTitle')} error={fieldErrors.jobTitle} disabled={saving} />
          <Input label="Department" value={form.department} onChange={set('department')} error={fieldErrors.department} disabled={saving} />
          <Input label="Phone" value={form.phone} onChange={set('phone')} error={fieldErrors.phone} disabled={saving} />
        </FormGrid>

        {!user ? (
          <div className="rounded-xl bg-[var(--surface-sunken)] p-3.5">
            <Input
              label="Temporary password"
              value={form.temporaryPassword}
              onChange={set('temporaryPassword')}
              error={fieldErrors.temporaryPassword}
              placeholder="Share this once — the holder rotates it at first sign-in"
              required
              disabled={saving}
            >
              <p className="mt-1.5 text-[0.72rem] leading-relaxed text-mist-500">
                Single-use handover credential. The complexity policy does not apply to it — the
                holder is forced to set their own password at first sign-in.
              </p>
            </Input>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/**
 * One-time credential handover.
 *
 * The server returns the temporary password only at creation time, so this is
 * the admin's single chance to capture it. `copyText` copies both fields in one
 * click; the dialog states plainly that the value cannot be retrieved again.
 */
function CredentialDialog({ credential, onClose }) {
  const toast = useToast();

  const copy = async () => {
    const ok = await copyText(
      `TransitSync sign-in\nEmail: ${credential.email}\nTemporary password: ${credential.temporaryPassword}`,
    );
    if (ok) toast.success('Credentials copied to the clipboard.');
    else toast.error('Could not copy automatically — select the password and copy it manually.');
  };

  return (
    <Modal
      open={Boolean(credential)}
      onClose={onClose}
      size="sm"
      title="Temporary password"
      subtitle={`Shown once — give it to ${credential?.fullName || 'the new user'} to sign in.`}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={copy}>
            <Icon name="copy" className="h-3.5 w-3.5" />
            Copy
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-xl bg-[var(--surface-sunken)] p-3">
          <p className="text-[0.65rem] font-semibold tracking-[0.08em] text-mist-500 uppercase">Email</p>
          <p className="mt-0.5 truncate text-[0.85rem] font-medium text-mist-100">{credential?.email}</p>
        </div>
        <div className="rounded-xl bg-[var(--surface-sunken)] p-3">
          <p className="text-[0.65rem] font-semibold tracking-[0.08em] text-mist-500 uppercase">
            Temporary password
          </p>
          <p className="mt-0.5 font-mono text-[1.05rem] font-semibold tracking-wide text-mist-100 select-all">
            {credential?.temporaryPassword}
          </p>
        </div>
        <p className="text-[0.78rem] leading-relaxed text-mist-400">
          {credential?.fullName || 'The new user'} must set their own password the first time they sign in.
          This temporary password cannot be shown again.
        </p>
      </div>
    </Modal>
  );
}

export default function Users() {
  const { can, user: currentUser } = useAuth();
  const toast = useToast();
  const { page, limit, goToPage, changeLimit, reset } = usePagination({ defaultLimit: 25 });
  // Campus directory for the platform principal's "Campus" picker in UserDialog.
  const { isPlatform, colleges } = useCampusDirectory();

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
  const [issued, setIssued] = useState(null);

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

  // Total-stealth client guard: Level 200 rows must never render for a campus
  // principal, even if a stale cache or proxy already delivered them. The API
  // already refuses to send them; this keeps the render honest regardless.
  const users = (data?.users ?? EMPTY).filter(
    (row) => Number(currentUser?.roleLevel ?? 200) >= 200 || Number(row.roleLevel ?? 0) < 200,
  );
  const meta = data?.meta;

  const clearFilters = () => {
    setSearch('');
    setRole('');
    setStatus('');
  };

  // Deleting a live account disables it (soft delete, email freed for reuse).
  // Deleting an account that is already suspended removes it for good, since
  // there is nothing left to disable and soft-deleting again only stacks
  // `.deleted.<id>` suffixes on the address.
  const confirmDelete = async () => {
    setDeleteBusy(true);
    const purging = deleting?.status === 'suspended';
    try {
      await api.del(purging ? `/users/${deleting.id}/purge` : `/users/${deleting.id}`);
      toast.success(
        purging ? `${deleting.fullName} permanently deleted.` : `${deleting.fullName} removed.`,
      );
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

  // A create either yields a one-time temporary password (show it once) or a
  // passwordless invite whose owner sets their own password at first sign-in.
  const handleCreated = (credential) => {
    if (credential?.temporaryPassword) {
      setIssued(credential);
      return;
    }
    toast.info(
      `${credential?.fullName ?? 'The new staff member'} was invited and will choose their own password on first sign-in.`,
      { title: 'Invitation created' },
    );
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
      key: 'campus',
      label: 'Campus',
      render: (row) =>
        Number(row.roleLevel ?? 0) >= 200 ? (
          <Badge tone="accent">Platform</Badge>
        ) : (
          <span className="text-[0.76rem] text-mist-300">{row.institutionName ?? '—'}</span>
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
              aria-label={`Edit user ${row.fullName}`}
              title="Edit user"
            >
              <Icon name="edit" className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {can('users:edit') ? (
            <button
              type="button"
              className="btn btn-ghost !p-1.5"
              onClick={() => setResetting(row)}
              aria-label={`Reset password for ${row.fullName}`}
              title="Reset password"
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
              aria-label={
                row.status === 'suspended'
                  ? `Delete account ${row.fullName} permanently`
                  : `Delete account ${row.fullName}`
              }
              title={row.status === 'suspended' ? 'Delete account permanently' : 'Delete account'}
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
        onCreated={handleCreated}
        user={editing}
        roles={roles}
        currentUser={currentUser}
        colleges={colleges}
        isPlatformActor={isPlatform}
      />

      <CredentialDialog credential={issued} onClose={() => setIssued(null)} />

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
        tone={deleting?.status === 'suspended' ? 'danger' : undefined}
        title={deleting?.status === 'suspended' ? 'Delete user permanently' : 'Delete user'}
        confirmLabel={deleting?.status === 'suspended' ? 'Delete permanently' : 'Delete'}
        message={
          deleting
            ? deleting.status === 'suspended'
              ? `Permanently delete ${deleting.fullName} (${deleting.email})? This account is already suspended and cannot sign in. Its audit history is retained, but the account cannot be undone.`
              : `Delete ${deleting.fullName} (${deleting.email})? Their audit history is retained.`
            : ''
        }
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
