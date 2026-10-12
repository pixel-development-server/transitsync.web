/**
 * Student Accounts Management (Administration)
 *
 * Dedicated panel for campus admins to manage student login credentials,
 * account status, password resets, and account lifecycle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import { CampusSelect, useCampusDirectory, usePlatformScope } from '../components/CampusScope.jsx';
import { EmptyState, Spinner, Button } from '../components/ui.jsx';

function Input({ className = '', ...props }) {
  return <input className={`field ${className}`} {...props} />;
}

function Select({ className = '', children, ...props }) {
  return (
    <select className={`field ${className}`} {...props}>
      {children}
    </select>
  );
}

import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { toCsv } from '../lib/csv.js';

function downloadCsv(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = toCsv(headers.map((key) => ({ key })), rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function StudentManagement() {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('search') ?? '';
  const status = searchParams.get('status') ?? 'all';
  const { isPlatform } = usePlatformScope();
  const { colleges } = useCampusDirectory(isPlatform);

  const { can, user } = useAuth();
  const { get, post, del } = useApi();
  const { push } = useToast();

  const canManage = can('users:edit') || can('users:delete');

  const [data, setData] = useState({ users: [], meta: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const query = useMemo(
    () => ({
      search: search || undefined,
      status: status === 'all' ? undefined : status,
      limit: 50,
    }),
    [search, status],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get('/admin/student-accounts', query);
      if (res?.success) {
        setData({ users: res.data.users, meta: res.data.meta });
      }
    } catch (error) {
      push({ title: 'Failed to load student accounts', message: error.message, tone: 'error' });
    } finally {
      setLoading(false);
    }
  }, [get, query, push]);

  useEffect(() => {
    load();
  }, [load]);

  const handleReset = async (user) => {
    if (!can('users:edit')) return;
    setBusy(`reset-${user?.id}`);
    try {
      const res = await post(`/admin/student-accounts/${user?.id}/reset-password`);
      if (res?.success) {
        push({
          title: 'Password reset',
          message: `Temporary password: ${res.data.temporaryPassword}`,
          tone: 'success',
        });
      }
    } catch (error) {
      push({ title: 'Reset failed', message: error.message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!confirm) return;
    if (!can('users:delete')) return;
    setBusy(`delete-${confirm.id}`);
    try {
      await del(`/admin/student-accounts/${confirm.id}`);
      push({ title: 'Student account removed', tone: 'success' });
      setConfirm(null);
      load();
    } catch (error) {
      push({ title: 'Delete failed', message: error.message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const updateParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  const exportCsv = () => {
    downloadCsv(
      'student-accounts.csv',
      data.users.map((u) => ({
        Email: u.email,
        'Full name': u.fullName,
        Status: u.status,
        Role: u.roleName,
        'Institution': u.institutionName || '',
        'Last login': u.lastLoginAt || '',
        'Created at': u.createdAt,
      })),
    );
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-mist-100">Student Accounts</h1>
          <p className="text-sm text-mist-500">
            Manage student login credentials, account status, and password resets.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" onClick={load} disabled={loading}>
            <Icon name="refresh" className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button type="button" variant="ghost" onClick={exportCsv} disabled={data.users.length === 0}>
            <Icon name="download" className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </header>

      <CampusSelect
        isPlatform={isPlatform}
        colleges={colleges}
        value={searchParams.get('tenantId')}
        onChange={(tenantId) => updateParam('tenantId', tenantId)}
        wrapperClass="w-60"
      />

      <section className="card overflow-hidden">
        <div className="flex flex-col items-stretch gap-3 border-b border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center">
          <div className="flex flex-1 flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <Input
              className="w-full sm:max-w-xs"
              placeholder="Search by name or email..."
              value={search}
              onChange={(e) => updateParam('search', e.target.value)}
            />
            <Select value={status} onChange={(e) => updateParam('status', e.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="suspended">Suspended</option>
            </Select>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <Spinner className="h-6 w-6" />
            <p className="text-sm text-mist-500">Loading student accounts…</p>
          </div>
        ) : data.users.length === 0 ? (
          <EmptyState
            icon="users"
            title="No student accounts found"
            message="Add students to the roster and they will appear here when linked."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-[var(--surface-raised)]">
                <tr className="border-b border-[var(--border-subtle)]">
                  <th className="th min-w-[220px]">Student</th>
                  <th className="th hidden md:table-cell">Email</th>
                  <th className="th">Status</th>
                  <th className="th hidden lg:table-cell">Institution</th>
                  <th className="th hidden xl:table-cell">Last login</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-[var(--border-subtle)]/60 transition last:border-0 hover:bg-brand-500/[0.06]"
                  >
                    <td className="td">
                      <div className="font-medium text-mist-100">{u.fullName}</div>
                      <div className="text-xs text-mist-500 md:hidden">{u.email}</div>
                    </td>
                    <td className="td hidden md:table-cell text-mist-500">{u.email}</td>
                    <td className="td">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          u.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : u.status === 'invited'
                            ? 'bg-amber-500/10 text-amber-600'
                            : 'bg-slate-500/10 text-slate-600'
                        }`}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td className="td hidden lg:table-cell text-mist-500">
                      {u.institutionName || '-'}
                    </td>
                    <td className="td hidden xl:table-cell text-mist-500">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '-'}
                    </td>
                    <td className="td text-right">
                      <div className="flex justify-end gap-2">
                        {can('users:edit') && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleReset(u)}
                            disabled={busy === `reset-${u.id}`}
                          >
                            Reset password
                          </Button>
                        )}
                        {can('users:delete') && (
                          <Button
                            type="button"
                            variant="danger-ghost"
                            size="sm"
                            onClick={() => setConfirm(u)}
                            disabled={busy === `delete-${u.id}`}
                          >
                            Delete account
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {confirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-xl">
              <div className="border-b border-[var(--border-subtle)] p-4">
                <h3 className="text-lg font-semibold text-mist-100">Delete student account</h3>
                <p className="mt-1 text-sm text-mist-500">
                  Remove {confirm.fullName} ({confirm.email})? This action cannot be undone.
                </p>
              </div>
              <div className="flex justify-end gap-2 p-4">
                <Button type="button" variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={handleDelete}
                  disabled={busy === `delete-${confirm.id}`}
                >
                  {busy === `delete-${confirm.id}` ? 'Deleting…' : 'Delete'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
