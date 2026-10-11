/**
 * PLATFORM MASTER — Global System & Maintenance.
 *
 * Two jobs: a platform-wide health readout (campuses, accounts, fleet) and the
 * single maintenance switch that pauses every campus sign-in except the Level
 * 200 Super Administrator's own.
 */

import { useEffect, useMemo, useState } from 'react';

import { Icon } from '../../components/Icon.jsx';
import { Badge, ErrorState, LoadingBlock, PageHeader, Panel, Spinner, StatCard } from '../../components/ui.jsx';
import { Input, Toggle } from '../../components/form.jsx';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/hooks.js';
import { useToast } from '../../lib/toast.jsx';
import { formatNumber } from '../../lib/format.js';

export default function SystemPanel() {
  const toast = useToast();
  const overview = useApi('/super-admin/overview');
  const maintenance = useApi('/super-admin/maintenance');

  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Seed the form from the server once the maintenance settings arrive.
  useEffect(() => {
    if (!maintenance.data) return;
    setEnabled(Boolean(maintenance.data.isMaintenanceMode));
    setMessage(maintenance.data.message ?? '');
  }, [maintenance.data]);

  const stats = overview.data;

  const roleRows = useMemo(() => stats?.users?.byRole ?? [], [stats]);

  const dirty =
    Boolean(maintenance.data) &&
    (enabled !== Boolean(maintenance.data.isMaintenanceMode) ||
      message.trim() !== (maintenance.data.message ?? '').trim());

  const save = async (nextEnabled = enabled) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch('/super-admin/maintenance', {
        enabled: nextEnabled,
        ...(message.trim() ? { message: message.trim() } : {}),
      });
      toast.success(nextEnabled ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.');
      maintenance.reload({ silent: true });
      overview.reload({ silent: true });
    } catch (caught) {
      setError(caught);
      toast.error(caught.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Global System &amp; Maintenance"
        subtitle="Platform-wide health and the maintenance switch."
        breadcrumb="Platform Master"
        actions={
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              overview.reload();
              maintenance.reload();
            }}
            disabled={overview.loading || maintenance.loading}
          >
            <Icon name="refresh" className="h-4 w-4" />
            Refresh
          </button>
        }
      />

      {overview.error ? (
        <ErrorState error={overview.error} onRetry={() => overview.reload()} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard
              label="Colleges"
              value={stats?.colleges?.total ?? 0}
              sub={stats ? `${stats.colleges.active} active · ${stats.colleges.suspended} suspended` : undefined}
              icon="building"
              tone="info"
              loading={overview.loading}
            />
            <StatCard label="Users" value={stats?.users?.total ?? 0} icon="users" tone="accent" loading={overview.loading} />
            <StatCard label="Students" value={stats?.students ?? 0} icon="students" tone="good" loading={overview.loading} />
            <StatCard label="Buses" value={stats?.buses ?? 0} icon="bus" tone="warn" loading={overview.loading} />
            <StatCard label="Routes" value={stats?.routes ?? 0} icon="route" tone="info" loading={overview.loading} />
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
            <Panel
              title="Maintenance mode"
              subtitle="Pauses every campus sign-in platform-wide."
              icon="sliders"
              actions={
                maintenance.data ? (
                  <Badge tone={maintenance.data.isMaintenanceMode ? 'warn' : 'good'} dot>
                    {maintenance.data.isMaintenanceMode ? 'Under maintenance' : 'Operational'}
                  </Badge>
                ) : null
              }
            >
              {maintenance.error ? (
                <ErrorState error={maintenance.error} onRetry={() => maintenance.reload()} />
              ) : maintenance.loading && !maintenance.data ? (
                <LoadingBlock label="Loading system settings…" />
              ) : (
                <div className="space-y-4">
                  <div className="rounded-xl border border-[var(--border-subtle)] p-3.5">
                    <Toggle
                      checked={enabled}
                      onChange={(value) => setEnabled(value)}
                      label="Enable maintenance mode"
                      hint="Blocks sign-in for every role from Level 1 to 100. Only the Platform Super Administrator (Level 200) can still sign in."
                    />
                  </div>

                  <Input
                    label="Public maintenance message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Server is currently under maintenance. Please try again later."
                    hint="Shown to visitors on the sign-in screen while maintenance mode is on."
                  />

                  {error ? (
                    <p className="text-[0.78rem] text-red-400">{error.message}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || !dirty}
                      onClick={() => {
                        setEnabled(Boolean(maintenance.data?.isMaintenanceMode));
                        setMessage(maintenance.data?.message ?? '');
                        setError(null);
                      }}
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      className={`btn ${enabled ? 'btn-danger' : 'btn-primary'}`}
                      disabled={busy || !dirty}
                      onClick={() => save(enabled)}
                    >
                      {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="sliders" className="h-3.5 w-3.5" />}
                      {enabled ? 'Enable maintenance' : 'Save changes'}
                    </button>
                  </div>

                  {enabled && !maintenance.data?.isMaintenanceMode ? (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3.5 py-2.5 text-[0.78rem] text-amber-300">
                      <Icon name="alert" className="mr-1.5 inline h-3.5 w-3.5" />
                      Saving now will sign every campus user out of new sessions until maintenance is turned off.
                    </div>
                  ) : null}
                </div>
              )}
            </Panel>

            <Panel title="Accounts by role" subtitle="Live platform composition." icon="shield" bodyClass="p-0">
              {overview.loading && !stats ? (
                <LoadingBlock label="Loading accounts…" />
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {roleRows.map((role) => (
                    <li key={role.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-[0.82rem] font-semibold text-mist-100">{role.name}</p>
                        <p className="font-mono text-[0.68rem] text-mist-500">
                          {role.key} · L{role.level}
                        </p>
                      </div>
                      <span className="tabular text-[0.82rem] font-semibold text-mist-200">
                        {formatNumber(role.count)}
                      </span>
                    </li>
                  ))}
                  {!roleRows.length ? (
                    <li className="px-4 py-6 text-center text-[0.8rem] text-mist-500">No roles reported.</li>
                  ) : null}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
