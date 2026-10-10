import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import {
  Badge,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
} from '../components/ui.jsx';
import { Input, Select } from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';
import { useEventStream } from '../lib/stream.js';
import { useToast } from '../lib/toast.jsx';
import { formatDateTime, formatNumber, formatTime, titleCase } from '../lib/format.js';

/** Stable empty reference. */
const EMPTY = [];

const CARD_STATUSES = ['ISSUED', 'ACTIVE'];
const REVOKE_REASONS = ['cancelled', 'lost', 'blocked', 'damaged', 'graduated', 'other'];

function DetailRow({ label, value, mono = false }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)]/60 py-2 last:border-b-0">
      <dt className="shrink-0 text-[0.74rem] text-mist-500">{label}</dt>
      <dd className={`min-w-0 text-right text-[0.8rem] text-mist-200 ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</dd>
    </div>
  );
}

export default function StudentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cardDialog, setCardDialog] = useState(null); // 'issue' | 'revoke'
  const [cardForm, setCardForm] = useState({ rfidSerial: '', cardStatus: 'ACTIVE', reason: 'cancelled' });
  const [cardError, setCardError] = useState(null);
  const [cardSaving, setCardSaving] = useState(false);

  const { data, error, loading, reload } = useApi(`/students/${id}`, { enabled: Boolean(id) });

  // A tap for this student anywhere on the fleet should surface immediately.
  useEventStream({
    onEvent: useCallback(
      (event) => {
        if (event === 'scan') reload({ silent: true });
      },
      [reload],
    ),
  });

  const student = data?.student;
  const scans = data?.scans ?? EMPTY;

  const stats = useMemo(() => {
    const boards = scans.filter((scan) => scan.direction === 'BOARD').length;
    const debords = scans.filter((scan) => scan.direction === 'DEBOARD').length;
    const rejected = scans.filter((scan) => scan.outcome && scan.outcome !== 'VALID').length;
    return { boards, debords, rejected, total: scans.length };
  }, [scans]);

  const run = useCallback(
    async (action) => {
      setBusy(true);
      try {
        if (action === 'purge') {
          await api.del(`/students/${id}/purge`);
          toast.success(`${student.fullName} and all associated records were removed.`);
          navigate('/students', { replace: true });
          return;
        }

        await api.del(`/students/${id}`);
        toast.success(`${student.fullName} removed from the registry.`);
        navigate('/students', { replace: true });
      } catch (caught) {
        toast.error(caught.message);
      } finally {
        setBusy(false);
        setConfirming(null);
      }
    },
    [id, navigate, student, toast],
  );

  const openCardDialog = useCallback(
    (mode) => {
      setCardError(null);
      setCardForm({
        rfidSerial: student?.rfidSerial ?? '',
        cardStatus: 'ACTIVE',
        reason: 'cancelled',
      });
      setCardDialog(mode);
    },
    [student],
  );

  const submitCard = async (event) => {
    event.preventDefault();
    setCardError(null);
    setCardSaving(true);
    try {
      if (cardDialog === 'issue') {
        await api.post(`/students/${id}/card`, {
          rfidSerial: cardForm.rfidSerial.trim(),
          cardStatus: cardForm.cardStatus,
        });
        toast.success('Card issued.');
      } else {
        await api.post(`/students/${id}/card/revoke`, { reason: cardForm.reason });
        toast.success('Card revoked.');
      }
      setCardDialog(null);
      reload({ silent: true });
    } catch (caught) {
      setCardError(caught);
    } finally {
      setCardSaving(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        key: 'scanTime',
        label: 'When',
        nowrap: true,
        render: (row) => (
          <span className="tabular text-[0.74rem] text-mist-300" title={formatDateTime(row.scan_time)}>
            {formatDateTime(row.scan_time)}
          </span>
        ),
      },
      {
        key: 'outcome',
        label: 'Outcome',
        nowrap: true,
        render: (row) => <StatusBadge status={row.outcome} label={titleCase(row.outcome)} />,
      },
      {
        key: 'direction',
        label: 'Direction',
        nowrap: true,
        render: (row) =>
          row.direction ? (
            <StatusBadge status={row.direction} label={titleCase(row.direction)} dot={false} />
          ) : (
            <span className="text-[0.72rem] text-mist-500">—</span>
          ),
      },
      {
        key: 'bus',
        label: 'Bus / Route',
        render: (row) => (
          <span className="font-mono text-[0.72rem] text-mist-400">
            {row.bus_code ?? '—'}
            {row.route_code ? <span className="ml-1.5 text-mist-500">{row.route_code}</span> : null}
          </span>
        ),
      },
      {
        key: 'gate',
        label: 'Gate',
        render: (row) => <span className="text-[0.74rem] text-mist-400">{row.gate ?? '—'}</span>,
      },
      {
        key: 'occupancy',
        label: 'On board',
        align: 'right',
        nowrap: true,
        render: (row) => (
          <span className="tabular text-[0.74rem] text-mist-400">
            {row.occupancy ?? '—'}/{row.capacity ?? '—'}
          </span>
        ),
      },
    ],
    [],
  );

  if (loading && !student) {
    return (
      <>
        <PageHeader title="Student" breadcrumb="Students" />
        <div className="card">
          <LoadingBlock label="Loading student record…" />
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title="Student" breadcrumb="Students" />
        <div className="card">
          <ErrorState error={error} onRetry={reload} />
        </div>
      </>
    );
  }

  if (!student) return null;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link to="/students" className="inline-flex items-center gap-1 hover:text-mist-300">
            <Icon name="arrowLeft" className="h-3 w-3" />
            Students
          </Link>
        }
        title={student.fullName}
        subtitle={`${student.collegeId}${student.program ? ` · ${student.program}` : ''}`}
        actions={
          <>
            <StatusBadge status={student.status} label={titleCase(student.status)} />
            {student.onboard ? (
              <Badge tone="good" dot>
                On {student.onboardBusCode}
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                Not on a bus
              </Badge>
            )}
            {can('students:edit') ? (
              <Link to={`/students?edit=${student.id}`} className="btn btn-primary">
                <Icon name="edit" className="h-3.5 w-3.5" />
                Edit
              </Link>
            ) : null}
            {can('students:delete') ? (
              <button type="button" className="btn btn-danger" onClick={() => setConfirming('delete')}>
                <Icon name="trash" className="h-3.5 w-3.5" />
                Remove
              </button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.6fr]">
        {/* ------------------------------------------------------------- */}
        {/* Identity + allocation                                          */}
        {/* ------------------------------------------------------------- */}
        <div className="space-y-4">
          <Panel title="Identity" icon="user">
            <div className="mb-3.5 flex items-center gap-3">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-sky-500 to-violet-500 text-[0.9rem] font-bold text-white">
                {student.fullName
                  .split(' ')
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join('')
                  .toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[0.95rem] font-bold text-mist-100">{student.fullName}</p>
                <p className="truncate text-[0.76rem] text-mist-500">{student.email ?? 'No email on file'}</p>
              </div>
            </div>

            <dl>
              <DetailRow label="College ID" value={student.collegeId} mono />
              <DetailRow label="Faculty" value={student.faculty} />
              <DetailRow label="Program" value={student.program} />
              <DetailRow label="Semester" value={student.semester} />
              <DetailRow label="Phone" value={student.phone} />
              <DetailRow label="Registered" value={formatDateTime(student.createdAt)} />
            </dl>
          </Panel>

          <Panel
            title="Bus card"
            icon="card"
            actions={
              can('students:edit') ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="btn btn-ghost !px-2 !py-1 text-[0.72rem]"
                    onClick={() => openCardDialog('issue')}
                  >
                    <Icon name="plus" className="h-3 w-3" />
                    {student.rfidSerial ? 'Replace' : 'Issue'}
                  </button>
                  {student.rfidSerial && student.cardStatus !== 'REVOKED' ? (
                    <button
                      type="button"
                      className="btn btn-danger !px-2 !py-1 text-[0.72rem]"
                      onClick={() => openCardDialog('revoke')}
                    >
                      <Icon name="close" className="h-3 w-3" />
                      Revoke
                    </button>
                  ) : null}
                </div>
              ) : null
            }
          >
            <dl>
              <DetailRow
                label="Card UID"
                value={student.rfidSerial ? student.rfidSerial.toUpperCase() : null}
                mono
              />
              <DetailRow label="Status" value={<StatusBadge status={student.cardStatus} />} />
              <DetailRow
                label="Issued"
                value={student.cardIssuedAt ? formatDateTime(student.cardIssuedAt) : null}
              />
              {student.cardStatus === 'REVOKED' ? (
                <DetailRow
                  label="Revoked"
                  value={
                    <span className="text-red-400">
                      {student.cardRevokedAt ? formatDateTime(student.cardRevokedAt) : '—'}
                      {student.cardRevokedReason ? ` · ${titleCase(student.cardRevokedReason)}` : ''}
                    </span>
                  }
                />
              ) : null}
            </dl>

            <p className="mt-3 text-[0.72rem] leading-relaxed text-mist-500">
              Cards are issued once the bus fee is paid and stay active until the student cancels
              their bus service, at which point the card is revoked and retrieved.
            </p>
          </Panel>

          <Panel title="Allocation" icon="route">
            <dl>
              <DetailRow label="Route" value={student.routeCode ? `${student.routeCode} — ${student.routeName}` : null} />
              <DetailRow label="Bus" value={student.busCode ? `${student.busCode} — ${student.busName}` : null} />
              <DetailRow label="Pickup stop" value={student.pickupStop} />
              <DetailRow label="Boarded at" value={student.onboardAt ? formatTime(student.onboardAt) : null} />
            </dl>

            {student.notes ? (
              <p className="mt-3 rounded-xl bg-[var(--surface-sunken)] px-3 py-2.5 text-[0.76rem] leading-relaxed text-mist-400">
                {student.notes}
              </p>
            ) : null}
          </Panel>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* Scan history                                                   */}
        {/* ------------------------------------------------------------- */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Recent taps', value: stats.total, icon: 'activity', tone: 'info' },
              { label: 'Boarded', value: stats.boards, icon: 'arrowRight', tone: 'good' },
              { label: 'Alighted', value: stats.deboards, icon: 'arrowLeft', tone: 'accent' },
              { label: 'Rejected', value: stats.rejected, icon: 'alert', tone: stats.rejected ? 'bad' : 'neutral' },
            ].map((entry) => (
              <div key={entry.label} className="card p-3">
                <p className="text-[0.66rem] font-semibold tracking-[0.06em] text-mist-500 uppercase">
                  {entry.label}
                </p>
                <p className="tabular mt-1 text-xl font-bold text-mist-100">{formatNumber(entry.value)}</p>
              </div>
            ))}
          </div>

          <Panel
            title="Scan history"
            subtitle="Most recent 25 taps across every bus"
            icon="history"
            bodyClass="p-0"
          >
            {scans.length === 0 ? (
              <EmptyState
                icon="history"
                title="No taps recorded"
                message="This student has not been scanned by any reader yet."
              />
            ) : (
              <DataTable
                columns={columns}
                rows={scans}
                rowKey={(row) => row.id}
                stickyHeader={false}
                empty={<EmptyState icon="history" title="No taps recorded" />}
              />
            )}
          </Panel>

          {can('students:delete') ? (
            <Panel title="Danger zone" subtitle="Irreversible operations" icon="alert">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[0.8rem] font-semibold text-mist-200">Permanently purge record</p>
                  <p className="text-[0.72rem] text-mist-500">
                    Deletes the student plus every scan and alert. Use only for data-protection requests.
                  </p>
                </div>
                <button type="button" className="btn btn-danger" onClick={() => setConfirming('purge')} disabled={busy}>
                  <Icon name="trash" className="h-3.5 w-3.5" />
                  Purge
                </button>
              </div>
            </Panel>
          ) : null}
        </div>
      </div>

      <Modal
        open={Boolean(cardDialog)}
        onClose={() => setCardDialog(null)}
        title={cardDialog === 'issue' ? 'Issue bus card' : 'Revoke bus card'}
        subtitle={
          cardDialog === 'issue'
            ? `Assign a physical card to ${student.fullName}.`
            : `${student.fullName}'s card will be revoked and can no longer be used to board.`
        }
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setCardDialog(null)}
              disabled={cardSaving}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="card-form"
              className={cardDialog === 'issue' ? 'btn btn-primary' : 'btn btn-danger'}
              disabled={cardSaving}
            >
              {cardSaving ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
              {cardDialog === 'issue' ? 'Issue card' : 'Revoke card'}
            </button>
          </>
        }
      >
        <form id="card-form" onSubmit={submitCard} className="space-y-4" noValidate>
          {cardError ? (
            <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[0.78rem] text-red-300">
              {cardError.message}
            </p>
          ) : null}
          {cardDialog === 'issue' ? (
            <>
              <Input
                label="Card UID / RFID serial"
                value={cardForm.rfidSerial}
                onChange={(event) => setCardForm((current) => ({ ...current, rfidSerial: event.target.value }))}
                placeholder="Tap or type the UID"
                className="font-mono uppercase"
                required
                disabled={cardSaving}
              />
              <Select
                label="Status"
                value={cardForm.cardStatus}
                onChange={(event) => setCardForm((current) => ({ ...current, cardStatus: event.target.value }))}
                options={CARD_STATUSES}
                disabled={cardSaving}
              />
            </>
          ) : (
            <Select
              label="Reason"
              value={cardForm.reason}
              onChange={(event) => setCardForm((current) => ({ ...current, reason: event.target.value }))}
              options={REVOKE_REASONS}
              disabled={cardSaving}
            />
          )}
        </form>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirming)}
        onClose={() => setConfirming(null)}
        onConfirm={() => run(confirming)}
        busy={busy}
        title={confirming === 'purge' ? 'Purge student permanently' : 'Remove student'}
        confirmLabel={confirming === 'purge' ? 'Purge everything' : 'Remove'}
        message={
          confirming === 'purge'
            ? `${student.fullName} and all associated scan history and alerts will be permanently deleted. This cannot be undone.`
            : `${student.fullName} will be removed from the registry. Their scan history is retained.`
        }
      />
    </>
  );
}