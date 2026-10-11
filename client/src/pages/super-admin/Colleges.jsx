/**
 * PLATFORM MASTER — College Management.
 *
 * Lists every campus (institution) with its administrator and headcounts, and
 * provisions a new campus together with its Level 100 System Administrator.
 *
 * Reserved for the Level 200 Super Administrator: the API behind it is gated by
 * `requireSuperAdmin`, so this page is the matching affordance, not the control.
 */

import { useMemo, useState } from 'react';

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
    `TransitSync — ${college.name} (${college.code})`,
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

export default function Colleges() {
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/super-admin/colleges');
  const colleges = data?.colleges ?? EMPTY;

  const [registerOpen, setRegisterOpen] = useState(false);
  const [createdResult, setCreatedResult] = useState(null);
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
        <button
          type="button"
          className={`btn btn-ghost !py-1 text-[0.72rem] ${row.status === 'ACTIVE' ? '!text-amber-400' : '!text-emerald-400'}`}
          onClick={() => setPending(row)}
        >
          {row.status === 'ACTIVE' ? 'Suspend' : 'Restore'}
        </button>
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
