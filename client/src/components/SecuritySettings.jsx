import { useEffect, useState } from 'react';

import { Icon } from './Icon.jsx';
import { Badge, Panel, Spinner } from './ui.jsx';
import { FormError, Input } from './form.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

/**
 * Platform-owner account security: change the sign-in email, and manage the
 * second factor (authenticator app or emailed one-time codes).
 *
 * Rendered only for the Level 200 Super Administrator, which is the only role
 * the server will enrol. Everything here is a convenience wrapper over
 * `/auth/change-email` and `/auth/2fa/*`; the server re-validates every step
 * (password re-proof, single-use codes, attempt limits).
 */

/** Group a base32 secret into 4-character blocks so it is easier to retype. */
function groupSecret(secret = '') {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

function CopyButton({ value, label, onCopied, onError }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost !py-1"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          onCopied?.();
          setTimeout(() => setCopied(false), 1800);
        } catch {
          onError?.();
        }
      }}
    >
      <Icon name={copied ? 'copyCheck' : 'copy'} className="h-3.5 w-3.5" />
      {copied ? 'Copied' : label}
    </button>
  );
}

export default function SecuritySettings() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const { data: status, reload: reloadStatus, loading } = useApi('/auth/2fa/status');

  // Change-email form.
  const [emailForm, setEmailForm] = useState({ newEmail: '', currentPassword: '' });
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState(null);

  // Enrolment: null, or the pending factor returned by /auth/2fa/setup.
  const [enroll, setEnroll] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState(null);
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  // Password-confirmed actions: 'disable' | 'regenerate'.
  const [passwordAction, setPasswordAction] = useState(null);
  const [password, setPassword] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    setEnroll(null);
    setCode('');
    setRecoveryCodes(null);
    setPanelError(null);
    setPasswordAction(null);
    setPassword('');
  }, [user?.id]);

  const changeEmail = async (event) => {
    event.preventDefault();
    setEmailError(null);
    setEmailBusy(true);
    try {
      await api.post('/auth/change-email', {
        newEmail: emailForm.newEmail.trim().toLowerCase(),
        currentPassword: emailForm.currentPassword,
      });
      setEmailForm({ newEmail: '', currentPassword: '' });
      toast.success('Email updated. Other devices were signed out.');
      await refresh();
    } catch (caught) {
      setEmailError(caught);
    } finally {
      setEmailBusy(false);
    }
  };

  const startEnroll = async (method) => {
    setPanelError(null);
    setBusy(true);
    try {
      const response = await api.post('/auth/2fa/setup', { method });
      setCode('');
      setEnroll({ method, ...response.data });
      if (method === 'EMAIL') {
        toast.info(
          response.data?.delivered
            ? `We emailed a code to ${response.data.email}.`
            : 'A code was generated — check the server console.',
          { title: 'Code sent' },
        );
      }
    } catch (caught) {
      setPanelError(caught);
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async (event) => {
    event.preventDefault();
    setPanelError(null);
    setBusy(true);
    try {
      const response = await api.post('/auth/2fa/enable', {
        method: enroll.method,
        code: code.trim(),
      });
      setRecoveryCodes(response.data?.recoveryCodes ?? []);
      setEnroll(null);
      setCode('');
      toast.success('Two-factor authentication is on.');
      reloadStatus({ silent: true });
      await refresh();
    } catch (caught) {
      setPanelError(caught);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const runPasswordAction = async (event) => {
    event.preventDefault();
    setPanelError(null);
    setActionBusy(true);
    try {
      if (passwordAction === 'disable') {
        await api.post('/auth/2fa/disable', { password });
        toast.success('Two-factor authentication disabled.');
      } else {
        const response = await api.post('/auth/2fa/recovery-codes', { password });
        setRecoveryCodes(response.data?.recoveryCodes ?? []);
        toast.success('New recovery codes generated.');
      }
      setPasswordAction(null);
      setPassword('');
      reloadStatus({ silent: true });
      await refresh();
    } catch (caught) {
      setPanelError(caught);
    } finally {
      setActionBusy(false);
    }
  };

  if (!user) return null;

  const enabled = Boolean(status?.enabled);
  const emailAvailable = Boolean(status?.available?.email);
  const methodLabel = status?.method === 'EMAIL' ? 'Email one-time codes' : 'Authenticator app';

  const renderRecoveryCodes = () => (
    <div className="space-y-3">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3">
        <p className="flex items-center gap-2 text-[0.8rem] font-semibold text-amber-300">
          <Icon name="alert" className="h-4 w-4 shrink-0" />
          Save these recovery codes now
        </p>
        <p className="mt-1 text-[0.72rem] leading-relaxed text-amber-200/80">
          Each code works once if you lose your device. They are shown only this once.
        </p>
        <div className="mt-2.5 grid grid-cols-2 gap-1.5 font-mono text-[0.82rem] text-mist-100 sm:grid-cols-2">
          {recoveryCodes.map((entry) => (
            <span key={entry} className="rounded bg-black/25 px-2 py-1 text-center">
              {entry}
            </span>
          ))}
        </div>
        <div className="mt-2.5">
          <CopyButton
            value={recoveryCodes.join('\n')}
            label="Copy all"
            onCopied={() => toast.success('Recovery codes copied.')}
            onError={() => toast.error('Could not copy — select the codes manually.')}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <button type="button" className="btn btn-primary" onClick={() => setRecoveryCodes(null)}>
          <Icon name="check" className="h-3.5 w-3.5" />
          I have saved them
        </button>
      </div>
    </div>
  );

  const renderEnroll = () =>
    enroll.method === 'TOTP' ? (
      <div className="space-y-3">
        <p className="text-[0.78rem] leading-relaxed text-mist-400">
          <span className="font-semibold text-mist-200">1.</span> In your authenticator app
          (Google Authenticator, Authy, 1Password, Bitwarden…), add an account manually and paste
          this setup key — or import the link.
        </p>
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--glass-fill)] px-3.5 py-3">
          <div className="flex items-center gap-2 text-[0.68rem] font-semibold tracking-wider text-mist-500 uppercase">
            <Icon name="qr" className="h-3.5 w-3.5" />
            Setup key
          </div>
          <p className="mt-1.5 font-mono text-[0.92rem] font-semibold tracking-[0.18em] break-all text-mist-100">
            {groupSecret(enroll.secret)}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <CopyButton
              value={enroll.secret}
              label="Copy key"
              onCopied={() => toast.success('Setup key copied.')}
              onError={() => toast.error('Could not copy the key.')}
            />
            <CopyButton
              value={enroll.otpauthUrl}
              label="Copy setup link"
              onCopied={() => toast.success('Setup link copied.')}
              onError={() => toast.error('Could not copy the link.')}
            />
          </div>
        </div>
        <p className="text-[0.78rem] leading-relaxed text-mist-400">
          <span className="font-semibold text-mist-200">2.</span> Enter the 6-digit code the app
          shows to switch it on.
        </p>
        <form onSubmit={confirmEnroll} className="space-y-3" noValidate>
          <Input
            label="Verification code"
            name="code"
            icon="shield"
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
            autoComplete="one-time-code"
            required
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setEnroll(null);
                setCode('');
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
              Enable
            </button>
          </div>
        </form>
      </div>
    ) : (
      <div className="space-y-3">
        <p className="text-[0.78rem] leading-relaxed text-mist-400">
          We sent a 6-digit code to <span className="text-mist-200">{enroll.email}</span>
          {enroll.delivered ? '.' : ' (delivered to the server console — SMTP is not configured).'}
        </p>
        <form onSubmit={confirmEnroll} className="space-y-3" noValidate>
          <Input
            label="Emailed code"
            name="code"
            icon="mail"
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
            autoComplete="one-time-code"
            required
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => startEnroll('EMAIL')}
              disabled={busy}
            >
              <Icon name="refresh" className="h-3.5 w-3.5" />
              Resend
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
              Enable
            </button>
          </div>
        </form>
      </div>
    );

  const renderEnabled = () => (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="good" dot>
          On
        </Badge>
        <span className="text-[0.8rem] font-semibold text-mist-200">{methodLabel}</span>
        <span className="text-[0.72rem] text-mist-500">
          · {status?.recoveryCodesRemaining ?? 0} recovery code
          {(status?.recoveryCodesRemaining ?? 0) === 1 ? '' : 's'} left
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setPanelError(null);
            setPasswordAction('regenerate');
          }}
          disabled={actionBusy}
        >
          <Icon name="key" className="h-3.5 w-3.5" />
          New recovery codes
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setPanelError(null);
            setPasswordAction('disable');
          }}
          disabled={actionBusy}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
          Disable
        </button>
      </div>

      {passwordAction ? (
        <form
          onSubmit={runPasswordAction}
          className="space-y-3 border-t border-[var(--border-subtle)] pt-3.5"
          noValidate
        >
          <p className="text-[0.75rem] leading-relaxed text-mist-400">
            {passwordAction === 'disable'
              ? 'Enter your password to turn two-factor authentication off.'
              : 'Enter your password to replace every recovery code.'}
          </p>
          <Input
            label="Password"
            name="password"
            type="password"
            icon="lock"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={actionBusy}
            required
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPasswordAction(null);
                setPassword('');
              }}
              disabled={actionBusy}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={actionBusy || !password}>
              {actionBusy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
              {passwordAction === 'disable' ? 'Disable 2FA' : 'Generate codes'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );

  const renderDisabled = () => (
    <div className="space-y-3">
      <p className="text-[0.78rem] leading-relaxed text-mist-500">
        Add a second step to sign-in. Once enabled, signing in needs your password{' '}
        <span className="text-mist-300">and</span> a code.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => startEnroll('TOTP')}
          disabled={busy}
        >
          <Icon name="shield" className="h-3.5 w-3.5" />
          Authenticator app
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => startEnroll('EMAIL')}
          disabled={busy || !emailAvailable}
          title={emailAvailable ? undefined : 'Email codes need an SMTP server (set SMTP_HOST)'}
        >
          <Icon name="mail" className="h-3.5 w-3.5" />
          Email codes
        </button>
      </div>
      {!emailAvailable ? (
        <p className="flex items-start gap-2 text-[0.7rem] leading-relaxed text-mist-500">
          <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0" />
          Email codes need an SMTP server (set <code className="text-mist-400">SMTP_HOST</code>). The
          authenticator app works entirely offline.
        </p>
      ) : null}
    </div>
  );

  return (
    <>
      <Panel title="Email address" subtitle="Used to sign in and receive codes" icon="mail">
        <form onSubmit={changeEmail} className="space-y-4" noValidate>
          <FormError error={emailError} onDismiss={() => setEmailError(null)} />

          <div className="flex items-center gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--glass-fill)] px-3.5 py-2.5">
            <Icon name="mail" className="h-4 w-4 shrink-0 text-mist-500" />
            <span className="truncate text-[0.82rem] font-semibold text-mist-200">{user?.email}</span>
          </div>

          <Input
            label="New email address"
            name="newEmail"
            type="email"
            icon="mail"
            autoComplete="email"
            placeholder="you@transitsync.me"
            value={emailForm.newEmail}
            onChange={(event) => setEmailForm((current) => ({ ...current, newEmail: event.target.value }))}
            disabled={emailBusy}
            required
          />
          <Input
            label="Current password"
            name="currentPassword"
            type="password"
            icon="lock"
            autoComplete="current-password"
            placeholder="Confirm it's you"
            value={emailForm.currentPassword}
            onChange={(event) =>
              setEmailForm((current) => ({ ...current, currentPassword: event.target.value }))
            }
            disabled={emailBusy}
            required
          />

          <div className="flex justify-end">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={emailBusy || !emailForm.newEmail || !emailForm.currentPassword}
            >
              {emailBusy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
              Update email
            </button>
          </div>
        </form>
      </Panel>

      <Panel
        title="Two-factor authentication"
        subtitle="Recommended for the Platform Super Administrator"
        icon="shield"
      >
        <FormError error={panelError} onDismiss={() => setPanelError(null)} />

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-[0.78rem] text-mist-500">
            <Spinner className="h-3.5 w-3.5" />
            Checking status…
          </div>
        ) : recoveryCodes ? (
          renderRecoveryCodes()
        ) : enroll ? (
          renderEnroll()
        ) : enabled ? (
          renderEnabled()
        ) : (
          renderDisabled()
        )}
      </Panel>
    </>
  );
}

