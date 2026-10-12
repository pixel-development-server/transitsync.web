/**
 * PLATFORM MASTER — College Management.
 *
 * Lists every campus (institution) with its administrator and headcounts, and
 * provisions a new campus together with its Level 100 System Administrator.
 *
 * Reserved for the Level 200 Super Administrator: the API behind it is gated by
 * `requireSuperAdmin`, so this page is the matching affordance, not the control.
 */

import { useEffect, useMemo, useState } from 'react';

import { Icon } from '../../components/Icon.jsx';
import {
  DataTable,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  StatCard,
  StatusBadge,
} from '../../components/ui.jsx';
import { FormError, Input } from '../../components/form.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/hooks.js';
import { useToast } from '../../lib/toast.jsx';
import { formatDateTime, formatNumber } from '../../lib/format.js';

const EMPTY = [];
const BLANK = { name: '', code: '', adminEmail: '', adminName: '' };

function RegisterCollegeModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        code: form.code.trim().toLowerCase(),
        adminEmail: form.adminEmail.trim().toLowerCase(),
      };
      if (form.adminName.trim()) body.adminName = form.adminName.trim();

      const response = await api.post('/super-admin/colleges', body);
      toast.success(`${response.data.college.name} registered.`);
      onCreated(response.data);
      setForm(BLANK);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Register new college"
      subtitle="Creates the campus and its Level 100 System Administrator."
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="register-college" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="plus" className="h-3.5 w-3.5" />}
            Create college
          </button>
        </>
      }
    >
      <form id="register-college" className="space-y-3.5" onSubmit={submit}>
        <FormError error={error} onDismiss={() => setError(null)} />
        <Input
          label="College name"
          required
          value={form.name}
          onChange={set('name')}
          placeholder="Itahari International College"
          error={error?.fieldErrors?.name}
        />
        <Input
          label="College code (slug)"
          required
          value={form.code}
          onChange={set('code')}
          placeholder="iic"
          hint="Lowercase letters, digits and hyphens. Used as the tenant key."
          error={error?.fieldErrors?.code}
        />
        <Input
          label="Administrator email"
          type="email"
          required
          value={form.adminEmail}
          onChange={set('adminEmail')}
          placeholder="admin@campus.edu.np"
          error={error?.fieldErrors?.adminEmail}
        />
        <Input
          label="Administrator name"
          value={form.adminName}
          onChange={set('adminName')}
          placeholder="Optional"
          error={error?.fieldErrors?.adminName}
        />
      </form>
    </Modal>
  );
}

function CredentialsModal({ result, onClose }) {
  const toast = useToast();
  if (!result) return null;

  const { college, credentials } = result;
  const lines = [
    `TransitSync • ${college.name} (${college.code})`,
    `Sign in: ${window.location.origin}/login`,
    `Email: ${credentials.email}`,
    `Temporary password: ${credentials.temporaryPassword}`,
    'The password must be changed at first sign-in.',
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success('Credentials copied to the clipboard.');
    } catch {
      toast.error('Could not access the clipboard. Copy the values manually.');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Campus administrator credentials"
      subtitle="Shown once — this deployment has no mail server."
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
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3.5 py-2.5 text-[0.78rem] text-amber-300">
          <Icon name="alert" className="mr-1.5 inline h-3.5 w-3.5" />
          Hand these to the campus administrator over a secure channel. They cannot be retrieved again.
        </div>
        <dl className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
          {[
            ['College', `${college.name} · ${college.code}`],
            ['Email', credentials.email],
            ['Temporary password', credentials.temporaryPassword],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <dt className="text-[0.75rem] text-mist-500">{label}</dt>
              <dd className="font-mono text-[0.82rem] font-semibold text-mist-100">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}

function EditCollegeModal({ college, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!college) return;
    setError(null);
    setForm({
      name: college.name ?? '',
      code: college.code ?? '',
      adminEmail: college.adminEmail ?? '',
    });
  }, [college]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put(`/super-admin/colleges/${college.id}`, {
        name: form.name.trim(),
        code: form.code.trim().toLowerCase(),
        adminEmail: form.adminEmail.trim().toLowerCase(),
      });
      toast.success(`${form.name.trim()} updated.`);
      onSaved?.();
      onClose?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(college)}
      onClose={onClose}
      title="Edit college"
      subtitle={college ? `Rename, re-slug or re-point the administrator for ${college.name}.` : ''}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="edit-college" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
            Save changes
          </button>
        </>
      }
    >
      <form id="edit-college" className="space-y-3.5" onSubmit={submit}>
        <FormError error={error} onDismiss={() => setError(null)} />
        <Input
          label="College name"
          required
          value={form.name}
          onChange={set('name')}
          error={error?.fieldErrors?.name}
          disabled={busy}
        />
        <Input
          label="College code (slug)"
          required
          value={form.code}
          onChange={set('code')}
          hint="Lowercase letters, digits and hyphens. Used as the tenant key."
          error={error?.fieldErrors?.code}
          disabled={busy}
        />
        <Input
          label="Administrator email"
          type="email"
          required
          value={form.adminEmail}
          onChange={set('adminEmail')}
          error={error?.fieldErrors?.adminEmail}
          disabled={busy}
        />
      </form>
    </Modal>
  );
}

function DeleteCollegeModal({ college, onClose, onDeleted }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const [purge, setPurge] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!college) return;
    setError(null);
    setConfirm('');
    setPurge(false);
  }, [college]);

  const matches = confirm.trim() === (college?.code ?? '');

  const confirmDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.del(`/super-admin/colleges/${college.id}`, purge ? { body: { purge: true } } : undefined);
      toast.success(purge ? `${college.name} permanently deleted.` : `${college.name} removed.`);
      onDeleted?.();
      onClose?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(college)}
      onClose={onClose}
      size="sm"
      title={`Delete ${college?.name ?? 'college'}?`}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!matches || busy}
            onClick={confirmDelete}
          >
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="trash" className="h-3.5 w-3.5" />}
            {purge ? 'Purge permanently' : 'Delete college'}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3.5 py-2.5 text-[0.78rem] leading-relaxed text-red-300">
          <Icon name="alert" className="mr-1.5 inline h-3.5 w-3.5" />
          {purge ? (
            <>
              This permanently destroys the campus, its staff accounts, students, buses and routes.
              Scan and alert history is detached but retained. This cannot be undone.
            </>
          ) : (
            <>
              This removes the campus from the platform, suspends its administrator and staff,
              revokes every session and withdraws its students. Fleet and scan history is retained.
            </>
          )}
        </div>

        <label className="block">
          <span className="label">
            Type the college code <span className="font-mono text-red-400">{college?.code}</span> to confirm
          </span>
          <input
            type="text"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            disabled={busy}
            placeholder={college?.code}
            autoComplete="off"
            spellCheck="false"
            className="field"
          />
        </label>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={purge}
            onChange={(event) => setPurge(event.target.checked)}
            disabled={busy}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-[var(--border-subtle)] bg-[var(--surface-sunken)] accent-red-500"
          />
          <span className="text-[0.8rem] font-medium text-mist-200">
            Also purge students and fleet records permanently
          </span>
        </label>

        <FormError error={error} onDismiss={() => setError(null)} />
      </div>
    </Modal>
  );
}

export default function Colleges() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/super-admin/colleges');
  const colleges = data?.colleges ?? EMPTY;

  const [registerOpen, setRegisterOpen] = useState(false);
  const [createdResult, setCreatedResult] = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);

  const stats = useMemo(
    () => ({
      total: colleges.length,
      active: colleges.filter((college) => college.status === 'ACTIVE').length,
      suspended: colleges.filter((college) => college.status === 'SUSPENDED').length,
      students: colleges.reduce((sum, college) => sum + (college.studentCount ?? 0), 0),
    }),
    [colleges],
  );

  const toggleStatus = async () => {
    if (!pending) return;
    setBusy(true);
    const next = pending.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    try {
      await api.patch(`/super-admin/colleges/${pending.id}`, { status: next });
      toast.success(`${pending.name} ${next === 'ACTIVE' ? 'restored' : 'suspended'}.`);
      setPending(null);
      reload({ silent: true });
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'College',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-mist-100">{row.name}</p>
          <p className="mt-0.5 font-mono text-[0.7rem] text-mist-500">{row.code}</p>
        </div>
      ),
    },
    {
      key: 'adminEmail',
      label: 'Administrator',
      render: (row) =>
        row.adminEmail ? (
          <span className="text-mist-300">{row.adminEmail}</span>
        ) : (
          <span className="text-mist-500">—</span>
        ),
    },
    {
      key: 'studentCount',
      label: 'Students',
      align: 'right',
      render: (row) => <span className="tabular">{formatNumber(row.studentCount ?? 0)}</span>,
    },
    {
      key: 'fleet',
      label: 'Buses / Routes',
      align: 'right',
      render: (row) => (
        <span className="tabular text-mist-400">
          {formatNumber(row.busCount ?? 0)} / {formatNumber(row.routeCount ?? 0)}
        </span>
      ),
    },
    {
      key: 'createdAt',
      label: 'Registered',
      render: (row) => <span className="text-[0.75rem] text-mist-500">{formatDateTime(row.createdAt)}</span>,
    },
    { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            className="btn btn-ghost !p-1.5"
            onClick={() => setEditing(row)}
            aria-label={`Edit college ${row.name}`}
            title="Edit college"
          >
            <Icon name="edit" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="btn btn-ghost !p-1.5 !text-red-300 hover:!text-red-200"
            onClick={() => setDeleting(row)}
            aria-label={`Delete college ${row.name}`}
            title="Delete college"
          >
            <Icon name="trash" className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={`btn btn-ghost !py-1 text-[0.72rem] ${row.status === 'ACTIVE' ? '!text-amber-400' : '!text-emerald-400'}`}
            onClick={() => setPending(row)}
          >
            {row.status === 'ACTIVE' ? 'Suspend' : 'Restore'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="College Management"
        subtitle="Provision and oversee every campus on the platform."
        breadcrumb="Platform Master"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setRegisterOpen(true)}>
            <Icon name="plus" className="h-4 w-4" />
            Register New College
          </button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Colleges" value={stats.total} icon="building" tone="info" loading={loading} />
        <StatCard label="Active" value={stats.active} icon="check" tone="good" loading={loading} />
        <StatCard label="Suspended" value={stats.suspended} icon="lock" tone="warn" loading={loading} />
        <StatCard label="Students" value={stats.students} icon="students" tone="accent" loading={loading} />
      </div>

      <Panel title="Campus directory" subtitle="Every institution provisioned on this platform." icon="building" bodyClass="p-0">
        {error ? (
          <ErrorState error={error} onRetry={() => reload()} />
        ) : (
          <DataTable
            columns={columns}
            rows={colleges}
            loading={loading}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                icon="building"
                title="No campuses yet"
                message="Register the first college to provision a campus administrator."
              />
            }
          />
        )}
      </Panel>

      <RegisterCollegeModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onCreated={(result) => {
          setRegisterOpen(false);
          setCreatedResult(result);
          reload({ silent: true });
        }}
      />
      <CredentialsModal result={createdResult} onClose={() => setCreatedResult(null)} />

      <EditCollegeModal
        college={editing}
        onClose={() => setEditing(null)}
        onSaved={() => reload({ silent: true })}
      />
      <DeleteCollegeModal
        college={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => reload({ silent: true })}
      />

      <Modal
        open={Boolean(pending)}
        onClose={() => (busy ? null : setPending(null))}
        title={pending?.status === 'ACTIVE' ? 'Suspend college' : 'Restore college'}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${pending?.status === 'ACTIVE' ? 'btn-danger' : 'btn-primary'}`}
              onClick={toggleStatus}
              disabled={busy}
            >
              {busy ? <Spinner className="h-3.5 w-3.5" /> : null}
              {pending?.status === 'ACTIVE' ? 'Suspend' : 'Restore'}
            </button>
          </>
        }
      >
        <p className="text-[0.85rem] leading-relaxed text-mist-300">
          {pending?.status === 'ACTIVE'
            ? `Suspend ${pending?.name}? Its administrator's sign-ins will be marked suspended.`
            : `Restore ${pending?.name} to active service?`}
        </p>
      </Modal>
    </div>
  );
}
