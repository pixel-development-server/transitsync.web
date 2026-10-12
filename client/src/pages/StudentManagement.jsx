/**
 * Student Accounts Management (Administration)
 *
 * Dedicated panel for campus admins to manage student login credentials,
 * account status, password resets, and account lifecycle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import CampusScope from '../components/CampusScope.jsx';
import { EmptyState, Spinner, DataTable, Button } from '../components/ui.jsx';

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

const Table = DataTable;
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
      const res = await get('/admin/student-users', query);
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
    setBusy(`reset-${user.id}`);
    try {
      const res = await post(`/admin/student-users/${user.id}/reset-password`);
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
      await del(`/admin/student-users/${confirm.id}`);
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
          <h1 className="text-xl font-semibold text-[var(--text)]">Student Accounts</h1>
          <p className="text-sm text-[var(--muted)]">
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

      <CampusScope
        value={searchParams.get('tenantId')}
        onChange={(tenantId) => updateParam('tenantId', tenantId)}
      />

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] p-4">
          <div className="flex flex-1 flex-wrap items-center gap-3">
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
            <p className="text-sm text-[var(--muted)]">Loading student accounts…</p>
          </div>
        ) : data.users.length === 0 ? (
          <EmptyState
            icon="users"
            title="No student accounts found"
            message="Add students to the roster and they will appear here when linked."
          />
        ) : (
          <Table className="min-w-full">
            <thead>
              <tr>
                <th className="min-w-[220px]">Student</th>
                <th className="hidden md:table-cell">Email</th>
                <th>Status</th>
                <th className="hidden lg:table-cell">Institution</th>
                <th className="hidden xl:table-cell">Last login</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="font-medium text-[var(--text)]">{u.fullName}</div>
                    <div className="text-xs text-[var(--muted)] md:hidden">{u.email}</div>
                  </td>
                  <td className="hidden md:table-cell text-[var(--muted)]">{u.email}</td>
                  <td>
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
                  <td className="hidden lg:table-cell text-[var(--muted)]">
                    {u.institutionName || '-'}
                  </td>
                  <td className="hidden xl:table-cell text-[var(--muted)]">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '-'}
                  </td>
                  <td className="text-right">
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
          </Table>
        )}

        {confirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl">
              <div className="border-b border-[var(--border)] p-4">
                <h3 className="text-lg font-semibold text-[var(--text)]">Delete student account</h3>
                <p className="mt-1 text-sm text-[var(--muted)]">
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