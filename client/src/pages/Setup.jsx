/**
 * First-run System Administrator wizard.
 *
 * Shown only while the deployment has no `system_admin` account. The gate that
 * routes here lives in App.jsx (`<SetupGate>`); this component assumes it is
 * reachable because `/auth/setup-status` reported `bootstrapped: false`.
 *
 * The form submits to `POST /api/auth/setup`, which is deliberately one-shot:
 * the server refuses once any system administrator exists, so this screen cannot
 * be used to add a second master account or to hijack an installed system.
 *
 * The server also opens a session on success. That session is dropped again
 * before handing over to /login — via a full page reload, so the first-run
 * gate re-reads the bootstrapped state instead of bouncing back to the wizard
 * — and the administrator proves they can authenticate with the password they
 * just chose instead of being dropped straight into the dashboard.
 */

import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import { Spinner } from '../components/ui.jsx';
import { FormError, Input } from '../components/form.jsx';
import { api } from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';

const SETUP_PATH = '/system-setup';

/** Fallback policy; /auth/setup-status supplies the real numbers. */
const DEFAULT_POLICY = { minLength: 10 };

/**
 * Local strength model.
 *
 * This mirrors the server policy purely for instant feedback as the user types —
 * a network round-trip per keystroke would make the meter lag. The server stays
 * the authority and re-checks everything on submit; its "commonly used
 * password" rule is deliberately not duplicated here.
 */
function measure(password, policy) {
  const minLength = policy?.minLength ?? DEFAULT_POLICY.minLength;
  const checks = [
    { id: 'length', label: `At least ${minLength} characters`, ok: password.length >= minLength },
    { id: 'upper', label: 'One uppercase letter', ok: /[A-Z]/.test(password) },
    { id: 'lower', label: 'One lowercase letter', ok: /[a-z]/.test(password) },
    { id: 'number', label: 'One number', ok: /\d/.test(password) },
    { id: 'symbol', label: 'One symbol', ok: /[^A-Za-z0-9\s]/.test(password) },
  ];

  const met = checks.filter((check) => check.ok).length;
  return { checks, met, satisfied: met === checks.length };
}

/** Segment colours run red -> amber -> sky -> emerald as the score climbs. */
const STRENGTH = [
  { label: 'Too short', text: 'text-[var(--color-mist-500)]', bar: 'bg-[var(--color-bad-500)]' },
  { label: 'Weak', text: 'text-[var(--color-bad-400)]', bar: 'bg-[var(--color-bad-500)]' },
  { label: 'Fair', text: 'text-[var(--color-warn-400)]', bar: 'bg-[var(--color-warn-500)]' },
  { label: 'Good', text: 'text-[var(--color-info-400)]', bar: 'bg-[var(--color-info-400)]' },
  { label: 'Strong', text: 'text-[var(--color-good-400)]', bar: 'bg-[var(--color-good-500)]' },
  { label: 'Excellent', text: 'text-[var(--color-good-400)]', bar: 'bg-[var(--color-good-500)]' },
];

export default function Setup() {
  const toast = useToast();
  const { signOut } = useAuth();

  const { data: setup, loading } = useApi('/auth/setup-status');

  const [form, setForm] = useState({
    role: 'super_admin',
    institution: '',
    fullName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const policy = setup?.passwordPolicy;
  const institutionName = setup?.institutionName || 'TransitSync';

  // Folds the server's institution name into the form once it arrives, without
  // overwriting anything already typed. This is React's "adjust state during
  // render" pattern rather than an effect: `seededFrom` remembers which server
  // value has been applied, so the adjustment happens exactly once per value and
  // never cascades.
  const [seededFrom, setSeededFrom] = useState(null);
  if (setup?.institutionName && seededFrom !== setup.institutionName) {
    setSeededFrom(setup.institutionName);
    if (!form.institution) setForm((current) => ({ ...current, institution: setup.institutionName }));
  }

  useEffect(() => {
    document.title = `System Setup · ${institutionName}`;
  }, [institutionName]);

  const update = (field) => (event) => {
    const { value } = event.target;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const strength = useMemo(() => measure(form.password, policy), [form.password, policy]);
  const meter = STRENGTH[form.password ? Math.max(1, strength.met) : 0];

  const confirmProblem =
    form.confirmPassword.length > 0 && form.confirmPassword !== form.password
      ? 'Passwords do not match'
      : undefined;

  // Another tab completed setup, or the deployment was initialised meanwhile.
  if (!loading && setup?.bootstrapped === true) return <Navigate to="/login" replace />;

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    const institution = form.institution.trim();
    const fullName = form.fullName.trim();
    const email = form.email.trim().toLowerCase();

    if (institution.length < 2) return setError({ message: 'Enter the institution name.' });
    if (fullName.length < 2) return setError({ message: 'Enter the administrator full name.' });
    if (!email) return setError({ message: 'Enter the administrator email address.' });
    if (!strength.satisfied) return setError({ message: 'Password does not meet the policy yet.' });
    if (form.password !== form.confirmPassword) return setError({ message: 'Passwords do not match.' });

    setSubmitting(true);
    try {
      await api.post('/auth/setup', {
        role: form.role,
        institution,
        fullName,
        email,
        password: form.password,
        confirmPassword: form.confirmPassword,
      });

      setDone(true);
      toast.success('Master Admin Created Successfully!', {
        title: 'TransitSync is ready',
        duration: 6000,
      });

      // Drop the session the server opened during setup so /login is a real
      // sign-in. Best-effort: a failure here must not strand the user.
      await signOut({ notifyServer: true });

      // Hand the chosen email over to the login screen, then hard-navigate.
      // A full reload is deliberate: it forces the first-run gate to re-read
      // /auth/setup-status (now bootstrapped), so /login is not bounced back
      // to the wizard in a redirect loop.
      try {
        sessionStorage.setItem('transitsync.prefillEmail', email);
      } catch {
        // Private browsing — prefill is a nicety, not a requirement.
      }
      setTimeout(() => window.location.replace('/login'), 900);
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-[var(--surface)]">
        <Spinner className="h-7 w-7 text-sky-400" />
      </div>
    );
  }

  const disabled = submitting || done;

  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden bg-[var(--surface)] px-4 py-10">
      <div className="aurora" aria-hidden="true" />

      <div className="relative w-full max-w-[36rem]">
        <div className="card glass-strong overflow-hidden">
          {/* Header */}
          <div className="border-b border-[var(--border-subtle)] px-6 py-6 sm:px-8">
            <div className="flex items-start gap-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-violet-500 text-white shadow-lg shadow-sky-500/25">
                <Icon name="shield" className="h-6 w-6" strokeWidth={2} />
              </span>
              <div>
                <span className="chip">
                  <Icon name="zap" className="h-3 w-3" />
                  First-run initialisation
                </span>
                <h1 className="mt-2.5 text-lg leading-snug font-bold tracking-tight text-[var(--color-mist-100)]">
                  TransitSync System Setup
                  <span className="block text-[var(--color-mist-500)]">
                    Master Administrator Creation
                  </span>
                </h1>
              </div>
            </div>

            <p className="mt-4 text-[0.83rem] leading-relaxed text-[var(--color-mist-500)]">
              This runs once, before any account exists. The administrator you create here holds
              every permission in the system and is the only account that can create further
              staff, so this screen closes permanently as soon as you finish.
            </p>
          </div>

          {/* Success state */}
          {done ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center sm:px-8">
              <span className="grid h-16 w-16 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/12 text-emerald-300">
                <Icon name="check" className="h-8 w-8" strokeWidth={2.5} />
              </span>
              <h2 className="text-lg font-bold text-emerald-300">Master Admin Created Successfully!</h2>
              <p className="max-w-sm text-[0.83rem] text-[var(--color-mist-500)]">
                Taking you to the sign-in screen with{' '}
                <span className="text-[var(--color-mist-200)]">{form.email.trim().toLowerCase()}</span>{' '}
                pre-filled. Use the password you just set to enter the console.
              </p>
              <Spinner className="mt-2 h-5 w-5 text-sky-400" />
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4 px-6 py-6 sm:px-8" noValidate>
              <FormError error={error} onDismiss={() => setError(null)} />

              <div>
                <span className="label">Account type</span>
                <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Account type">
                  {[
                    {
                      key: 'super_admin',
                      title: 'Platform Super Administrator',
                      hint: 'Multi-campus owner. Provisions colleges and their administrators, and manages the whole platform.',
                    },
                    {
                      key: 'system_admin',
                      title: 'Campus System Administrator',
                      hint: 'Single-campus master. Manages one institution directly, with no platform-wide controls.',
                    },
                  ].map((option) => {
                    const selected = form.role === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setForm((current) => ({ ...current, role: option.key }))}
                        disabled={disabled}
                        className={`rounded-xl border px-3.5 py-3 text-left transition ${
                          selected
                            ? 'border-sky-400/60 bg-sky-500/10'
                            : 'border-[var(--border-subtle)] bg-[var(--glass-fill)] hover:border-sky-400/40'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                              selected ? 'border-sky-400' : 'border-[var(--color-mist-500)]'
                            }`}
                          >
                            {selected ? <span className="h-2 w-2 rounded-full bg-sky-400" /> : null}
                          </span>
                          <span
                            className={`text-[0.82rem] font-semibold ${
                              selected ? 'text-sky-300' : 'text-[var(--color-mist-200)]'
                            }`}
                          >
                            {option.title}
                          </span>
                        </span>
                        <span className="mt-1 block pl-6 text-[0.72rem] leading-relaxed text-[var(--color-mist-500)]">
                          {option.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Input
                label="Institution name"
                name="institution"
                icon="database"
                placeholder="Department of Transport & Resource Management"
                value={form.institution}
                onChange={update('institution')}
                disabled={disabled}
                required
              />

              <Input
                label="Full name"
                name="fullName"
                icon="user"
                autoComplete="name"
                placeholder="e.g. Anisha Gurung"
                value={form.fullName}
                onChange={update('fullName')}
                disabled={disabled}
                required
              />

              <Input
                label="Administrator email"
                name="email"
                type="email"
                icon="mail"
                autoComplete="username"
                placeholder="admin@transitsync.edu.np"
                value={form.email}
                onChange={update('email')}
                disabled={disabled}
                required
              />

              <div>
                <Input
                  label="Password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  icon="lock"
                  autoComplete="new-password"
                  placeholder="••••••••••••"
                  value={form.password}
                  onChange={update('password')}
                  disabled={disabled}
                  required
                  suffix={
                    <button
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      className="text-[var(--color-mist-500)] transition hover:text-[var(--color-mist-200)]"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      tabIndex={-1}
                    >
                      <Icon name={showPassword ? 'eyeOff' : 'eye'} className="h-4 w-4" />
                    </button>
                  }
                />

                {/* Strength meter — 5 segments, one per policy rule. */}
                {form.password ? (
                  <div className="mt-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="label">Password strength</span>
                      <span className={`text-[0.72rem] font-semibold ${meter.text}`}>{meter.label}</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-5 gap-1.5" aria-hidden="true">
                      {strength.checks.map((check) => (
                        <span
                          key={check.id}
                          className={`h-1.5 rounded-full transition-colors duration-200 ${
                            check.ok ? meter.bar : 'bg-[var(--color-ink-700)]'
                          }`}
                        />
                      ))}
                    </div>
                    <p className="sr-only" aria-live="polite">
                      Password strength: {meter.label}. {strength.met} of {strength.checks.length}{' '}
                      requirements met.
                    </p>
                  </div>
                ) : null}
              </div>

              <Input
                label="Confirm password"
                name="confirmPassword"
                type={showPassword ? 'text' : 'password'}
                icon="lock"
                autoComplete="new-password"
                placeholder="Re-enter the password"
                value={form.confirmPassword}
                onChange={update('confirmPassword')}
                disabled={disabled}
                error={confirmProblem}
                required
              />

              {/* Live policy checklist */}
              <ul className="space-y-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--glass-fill)] px-3.5 py-3">
                {strength.checks.map((check) => (
                  <li
                    key={check.id}
                    className={`flex items-center gap-2 text-[0.78rem] transition-colors ${
                      check.ok ? 'text-[var(--color-good-400)]' : 'text-[var(--color-mist-500)]'
                    }`}
                  >
                    <Icon
                      name={check.ok ? 'check' : 'close'}
                      className="h-3.5 w-3.5 shrink-0"
                      strokeWidth={2.5}
                    />
                    {check.label}
                  </li>
                ))}
              </ul>

              <button type="submit" className="btn btn-primary w-full" disabled={disabled}>
                {submitting ? (
                  <>
                    <Spinner className="h-4 w-4" />
                    Creating administrator…
                  </>
                ) : (
                  <>
                    <Icon name="shield" className="h-4 w-4" />
                    {form.role === 'system_admin'
                      ? 'Create Campus Administrator'
                      : 'Create Platform Owner'}
                  </>
                )}
              </button>

              <p className="flex items-start gap-2 text-[0.72rem] leading-relaxed text-[var(--color-mist-500)]">
                <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0" />
                This account is created with a bcrypt hash at cost 10 and full system permissions.
                If you lose the credentials before signing in, you will need to reset the database.
              </p>
            </form>
          )}
        </div>

        <p className="mt-5 text-center text-[0.72rem] text-[var(--color-mist-500)]">
          TransitSync · RFID campus shuttle fleet, RBAC and operations platform
        </p>
      </div>
    </div>
  );
}

export { SETUP_PATH };