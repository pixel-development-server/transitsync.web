import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
} from '../components/ui.jsx';
import { FormError, FormGrid, Input } from '../components/form.jsx';
import SecuritySettings from '../components/SecuritySettings.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime, formatRelative, initials } from '../lib/format.js';

const EMPTY_PROFILE = { fullName: '', phone: '', department: '', jobTitle: '' };

/** Rough device label so the session list is readable at a glance. */
function deviceLabel(session) {
  const agent = session.device ?? session.user_agent ?? 'Unknown device';
  if (/android/i.test(agent)) return 'Android device';
  if (/iphone|ipad|ios/i.test(agent)) return 'iOS device';
  if (/windows/i.test(agent)) return 'Windows device';
  if (/mac os|macintosh/i.test(agent)) return 'Mac';
  if (/linux/i.test(agent)) return 'Linux device';
  return agent;
}

export default function Profile() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
  const [othersBusy, setOthersBusy] = useState(false);

  const { data: sessionData, reload: reloadSessions } = useApi('/auth/sessions');
  const sessions = sessionData?.sessions ?? [];

  useEffect(() => {
    if (!user) return;
    setForm({
      fullName: user.fullName ?? '',
      phone: user.phone ?? '',
      department: user.department ?? '',
      jobTitle: user.jobTitle ?? '',
    });
  }, [user]);

  const set = useCallback(
    (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value })),
    [],
  );

  const fieldErrors = error?.fieldErrors ?? {};
  const isDirty =
    form.fullName !== (user?.fullName ?? '') ||
    form.phone !== (user?.phone ?? '') ||
    form.department !== (user?.department ?? '') ||
    form.jobTitle !== (user?.jobTitle ?? '');

  const save = useCallback(
    async (event) => {
      event.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await api.patch('/auth/profile', {
          fullName: form.fullName.trim(),
          phone: form.phone.trim() || null,
          department: form.department.trim() || null,
          jobTitle: form.jobTitle.trim() || null,
        });
        toast.success('Profile updated.');
        refresh();
      } catch (caught) {
        setError(caught);
      } finally {
        setSaving(false);
      }
    },
    [form, refresh, toast],
  );

  const revoke = useCallback(async () => {
    setRevokeBusy(true);
    try {
      await api.del(`/auth/sessions/${revoking.id}`);
      toast.success('Session revoked.');
      setRevoking(null);
      reloadSessions({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setRevokeBusy(false);
    }
  }, [revoking, reloadSessions, toast]);

  const revokeOthers = useCallback(async () => {
    setOthersBusy(true);
    try {
      const response = await api.post('/auth/sessions/revoke-others');
      toast.success(response.data?.message ?? 'Other sessions revoked.');
      reloadSessions({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setOthersBusy(false);
      setConfirmRevokeOthers(false);
    }
  }, [reloadSessions, toast]);

  const otherCount = sessions.filter((session) => !session.is_current).length;

  const columns = [
    {
      key: 'device',
      label: 'Device',
      render: (row) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-[0.82rem] font-semibold text-mist-100">
            {deviceLabel(row)}
            {row.is_current ? (
              <Badge tone="good" dot>
                Current
              </Badge>
            ) : null}
          </p>
          <p className="truncate text-[0.7rem] text-mist-500" title={row.user_agent ?? row.device}>
            {row.ip ?? 'unknown IP'}
          </p>
        </div>
      ),
    },
    {
      key: 'created_at',
      label: 'Signed in',
      nowrap: true,
      render: (row) => (
        <span className="text-[0.74rem] text-mist-400" title={formatDateTime(row.created_at)}>
          {formatRelative(row.created_at)}
        </span>
      ),
    },
    {
      key: 'last_seen_at',
      label: 'Last seen',
      nowrap: true,
      render: (row) => (
        <span className="text-[0.74rem] text-mist-400">{formatRelative(row.last_seen_at)}</span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      nowrap: true,
      render: (row) =>
        row.revoked_at ? (
          <StatusBadge status="DISMISSED" label="Revoked" />
        ) : (
          <StatusBadge status="OPEN" label="Active" />
        ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      nowrap: true,
      render: (row) =>
        row.is_current || row.revoked_at ? null : (
          <button
            type="button"
            className="btn btn-danger !p-1.5"
            onClick={() => setRevoking(row)}
            aria-label={`Revoke session on ${deviceLabel(row)}`}
            title="Revoke session"
          >
            <Icon name="logout" className="h-3.5 w-3.5" />
          </button>
        ),
    },
  ];

  if (!user) return null;

  return (
    <>
      <PageHeader title="Profile" subtitle="Your account details and active sessions" />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
        <div className="space-y-4">
          <Panel title="Account" icon="user">
            <div className="mb-4 flex items-center gap-3">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-sky-500 text-lg font-bold text-white">
                {initials(user.fullName)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[0.95rem] font-bold text-mist-100">{user.fullName}</p>
                <p className="truncate text-[0.76rem] text-mist-500">{user.email}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge tone={user.roleLevel >= 100 ? 'accent' : 'info'}>{user.roleName ?? user.role}</Badge>
                  <StatusBadge status={user.status} label={user.status} />
                </div>
              </div>
            </div>

            <dl className="space-y-2 text-[0.76rem]">
              <div className="flex justify-between gap-3">
                <dt className="text-mist-500">Permissions</dt>
                <dd className="tabular font-semibold text-mist-200">{user.permissions?.length ?? 0}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-mist-500">Mode</dt>
                <dd>
                  <StatusBadge status={user.permissionsMode} label={user.permissionsMode} />
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-mist-500">Last sign-in</dt>
                <dd className="text-mist-300">{formatRelative(user.lastLoginAt)}</dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-[var(--border-subtle)] pt-3.5">
              {(user.permissions ?? []).slice(0, 12).map((permission) => (
                <Badge key={permission} tone="neutral">
                  {permission}
                </Badge>
              ))}
              {(user.permissions?.length ?? 0) > 12 ? (
                <Badge tone="neutral">+{(user.permissions.length ?? 0) - 12} more</Badge>
              ) : null}
            </div>
          </Panel>

          <Panel title="Security" icon="shield">
            <ul className="space-y-2.5">
              <li className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[0.8rem] font-semibold text-mist-200">Password</p>
                  <p className="text-[0.72rem] text-mist-500">
                    {user.mustChangePassword ? 'A rotation is required now.' : 'Last rotated on schedule.'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost shrink-0"
                  onClick={() => navigate('/change-password')}
                >
                  <Icon name="key" className="h-3.5 w-3.5" />
                  Change
                </button>
              </li>

              {user.mustChangePassword ? (
                <li>
                  <button
                    type="button"
                    className="btn btn-primary w-full"
                    onClick={() => navigate('/change-password')}
                  >
                    <Icon name="alert" className="h-3.5 w-3.5" />
                    Change password now
                  </button>
                </li>
              ) : null}
            </ul>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Edit details" subtitle="Your name is shown on audit entries" icon="edit">
            <form onSubmit={save} className="space-y-4" noValidate>
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
                  label="Phone"
                  value={form.phone}
                  onChange={set('phone')}
                  error={fieldErrors.phone}
                  disabled={saving}
                />
                <Input
                  label="Department"
                  value={form.department}
                  onChange={set('department')}
                  error={fieldErrors.department}
                  disabled={saving}
                />
                <Input
                  label="Job title"
                  value={form.jobTitle}
                  onChange={set('jobTitle')}
                  error={fieldErrors.jobTitle}
                  disabled={saving}
                />
              </FormGrid>

              <div className="flex items-center justify-end gap-2">
                {isDirty ? <span className="mr-auto text-[0.72rem] text-amber-300">Unsaved changes</span> : null}
                <button type="submit" className="btn btn-primary" disabled={saving || !isDirty}>
                  {saving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
                  Save profile
                </button>
              </div>
            </form>
          </Panel>

          {user.roleLevel >= 200 ? <SecuritySettings /> : null}

          <Panel
            title="Active sessions"
            subtitle={otherCount ? `${otherCount} other device${otherCount === 1 ? '' : 's'} signed in` : 'This is the only session'}
            icon="shield"
            actions={
              otherCount ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setConfirmRevokeOthers(true)}
                  disabled={othersBusy}
                >
                  {othersBusy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="logout" className="h-3.5 w-3.5" />}
                  Revoke others
                </button>
              ) : null
            }
            bodyClass="p-0"
          >
            {sessions.length === 0 ? (
              <EmptyState icon="shield" title="No session data" />
            ) : (
              <DataTable columns={columns} rows={sessions} rowKey={(row) => row.id} skeletonRows={3} stickyHeader={false} />
            )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        busy={revokeBusy}
        title="Revoke session"
        confirmLabel="Revoke"
        message={
          revoking ? `Sign out ${deviceLabel(revoking)} (${revoking.ip ?? 'unknown IP'})? That device must sign in again.` : ''
        }
      />

      <ConfirmDialog
        open={confirmRevokeOthers}
        onClose={() => setConfirmRevokeOthers(false)}
        onConfirm={revokeOthers}
        busy={othersBusy}
        title="Revoke other sessions"
        confirmLabel="Revoke all"
        message={`Sign out ${otherCount} other device${otherCount === 1 ? '' : 's'}? This session stays active.`}
      />
    </>
  );
}