import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import { Spinner } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

/** Value props shown on the branded side panel. */
const FEATURES = [
  { icon: 'wifi', label: 'Live Boarding' },
  { icon: 'trendingUp', label: 'Real-time Analytics (NPT)' },
  { icon: 'shield', label: 'Granular RBAC Control' },
];

/**
 * Path for the curved "Login" cut-out tab (viewBox 0 0 100 72).
 * The blue panel curves inward into the white form with matching
 * concave fillets (radius 14) at the top and bottom of the tab.
 */
const TAB_PATH =
  'M100 0 A14 14 0 0 1 86 14 L34 14 A22 22 0 0 0 12 36 A22 22 0 0 0 34 58 L86 58 A14 14 0 0 1 100 72 Z';

/** Deliberately loose, client-side format gate; the server validates authoritatively. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Redaction rules mirroring the server's password policy endpoint. */
function PasswordRules({ value, minLength = 10 }) {
  const rules = [
    { label: `At least ${minLength} characters`, ok: value.length >= minLength },
    { label: 'An uppercase letter', ok: /[A-Z]/.test(value) },
    { label: 'A lowercase letter', ok: /[a-z]/.test(value) },
    { label: 'A number', ok: /\d/.test(value) },
    { label: 'A symbol', ok: /[^\w\s]/.test(value) },
  ];
  const passed = rules.filter((rule) => rule.ok).length;

  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        {[0, 1, 2, 3, 4].map((index) => (
          <span
            key={index}
            className={`h-1 flex-1 rounded-full transition-colors ${index < passed ? 'bg-emerald-500' : 'bg-ink-600'
              }`}
          />
        ))}
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
        {rules.map((rule) => (
          <li
            key={rule.label}
            className={`flex items-center gap-1 text-[0.68rem] ${rule.ok ? 'text-emerald-400' : 'text-mist-500'}`}
          >
            <Icon name={rule.ok ? 'check' : 'close'} className="h-2.5 w-2.5 shrink-0" />
            {rule.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Shared input styling for the light auth card. */
const INPUT_CLASS =
  'w-full rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-3 text-slate-800 placeholder:text-slate-400 outline-none transition focus:border-blue-600 focus:bg-white focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60';

const LABEL_CLASS = 'mb-1.5 block text-xs font-semibold tracking-wider text-slate-500 uppercase';

const SUBMIT_CLASS =
  'mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-3.5 text-sm font-bold text-white shadow-lg shadow-blue-600/30 transition-all hover:bg-blue-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Two-step sign-in.
 *
 * Step 1 collects the email and asks `/auth/check-email` whether the account
 * exists and already has a password. Step 2 then morphs in place: a normal
 * password form for an established account, or a "create your password" form
 * for an invited account that has never had one.
 */
export default function Login() {
  const { signIn, establishSession, isAuthenticated, mustChangePassword, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [step, setStep] = useState('email'); // 'email' | 'password' | 'setup'
  // Entrance direction for the animated step swap: forward slides from the right.
  const [slide, setSlide] = useState('right');

  // The setup wizard stashes the email it just created in sessionStorage; read
  // it once and clear it so returning visitors get a blank field.
  const [email, setEmail] = useState(() => {
    if (location.state?.prefillEmail) return location.state.prefillEmail;
    try {
      const saved = sessionStorage.getItem('transitsync.prefillEmail');
      if (saved) sessionStorage.removeItem('transitsync.prefillEmail');
      return saved ?? '';
    } catch {
      return '';
    }
  });
  const [emailError, setEmailError] = useState(null);
  const [checking, setChecking] = useState(false);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [forgotHint, setForgotHint] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  const { data: setup } = useApi('/auth/setup-status');
  const institutionName = setup?.institutionName || 'Itahari International College';
  const minLength = setup?.passwordPolicy?.minLength ?? 10;

  useEffect(() => {
    document.title = `Sign in · ${institutionName}`;
  }, [institutionName]);

  // Announce an inactivity sign-out exactly once, then strip the flag so a
  // refresh does not repeat it.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('reason') !== 'timeout') return;
    setTimedOut(true);
    toast.warning('Session expired due to 3 minutes of inactivity. Please sign in again.', {
      title: 'Signed out',
    });
    params.delete('reason');
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Move focus into the credential field once Step 2 has settled.
  useEffect(() => {
    if (step === 'email') {
      emailRef.current?.focus();
      return undefined;
    }
    const timer = setTimeout(() => passwordRef.current?.focus(), 340);
    return () => clearTimeout(timer);
  }, [step]);

  if (loading) {
    return (
      <div className="login-light grid h-screen min-h-screen w-screen place-items-center bg-white">
        <Spinner className="h-7 w-7 text-blue-700" />
      </div>
    );
  }

  if (isAuthenticated) {
    if (mustChangePassword) return <Navigate to="/change-password" replace />;
    const target = location.state?.from?.pathname ?? '/';
    return <Navigate to={target} replace />;
  }

  const goToEmail = () => {
    setSlide('left');
    setStep('email');
    setError(null);
    setForgotHint(false);
    setShowPassword(false);
    setShowConfirmPassword(false);
    setPassword('');
    setConfirmPassword('');
  };

  const onCheckEmail = async (event) => {
    event.preventDefault();
    setEmailError(null);
    setError(null);

    const value = email.trim().toLowerCase();
    if (!value) return setEmailError('Enter your email address.');
    if (!EMAIL_RE.test(value)) return setEmailError('Enter a valid email address.');

    setChecking(true);
    try {
      const response = await api.post('/auth/check-email', { email: value });
      const status = response.data?.status;

      // Defensive only: a server that answers 200 with a NOT_FOUND discriminator.
      if (status === 'NOT_FOUND') {
        setEmailError('No staff account found with this email address.');
        return;
      }

      setEmail(value);
      setPassword('');
      setConfirmPassword('');
      setError(null);
      setSlide('right');
      setStep(status === 'FIRST_TIME_USER' ? 'setup' : 'password');
    } catch (caught) {
      // A 404 (no such account) or 403 (suspended) is an ordinary Step-1
      // outcome, not a transport failure — surface the server's message inline.
      const message = caught?.message || 'We could not verify that address. Please try again.';
      if (caught?.code === 'ACCOUNT_SUSPENDED') {
        setError({ message });
      } else {
        setEmailError(message);
      }
    } finally {
      setChecking(false);
    }
  };

  const onSignIn = async (event) => {
    event.preventDefault();
    setError(null);
    if (!password) return setError({ message: 'Enter your password.' });

    setSubmitting(true);
    try {
      await signIn(email, password, rememberMe);
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  const onCreatePassword = async (event) => {
    event.preventDefault();
    setError(null);

    if (password.length < minLength) {
      return setError({
        message: `Use at least ${minLength} characters.`,
        details: [{ field: 'password', message: `Use at least ${minLength} characters.` }],
      });
    }
    if (password !== confirmPassword) {
      return setError({
        message: 'Passwords do not match.',
        details: [{ field: 'confirmPassword', message: 'Passwords do not match.' }],
      });
    }

    setSubmitting(true);
    try {
      const response = await api.post('/auth/set-first-password', { email, password, confirmPassword });
      await establishSession(response.data);
      toast.success('Your password is set. Welcome aboard.', { title: 'Account activated' });
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-light flex h-screen min-h-screen w-screen flex-col overflow-hidden bg-white">
      {/* -
       * Edge-to-edge split: 5/12 brand panel · 7/12 form panel.
       * */}
      <main className="relative grid h-full w-full flex-1 grid-cols-1 overflow-y-auto md:grid-cols-12 md:overflow-hidden">
        {/*  Brand side  */}
        <aside className="relative flex h-full flex-col justify-between bg-blue-700 p-10 text-white md:col-span-5 md:p-14">
          {/* Decorative accents, clipped so only the tab may protrude. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
            <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-blue-500/30 blur-3xl" />
            <div className="absolute -bottom-28 -left-24 h-72 w-72 rounded-full bg-blue-900/50 blur-3xl" />
            <div className="absolute top-1/2 -left-1/4 h-40 w-[150%] -translate-y-1/2 -rotate-12 bg-white/5" />
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-blue-950/40" />
          </div>

          {/* Top branding */}
          <div className="relative z-10 flex items-center gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white/15 text-white ring-1 ring-white/25 backdrop-blur">
              <Icon name="bus" className="h-6 w-6" strokeWidth={2} />
            </span>
            <div>
              <p className="text-xl font-extrabold tracking-tight text-white">TransitSync</p>
              <p className="text-[0.68rem] font-medium tracking-[0.14em] text-blue-100 uppercase">
                Campus Shuttle Operations Console
              </p>
            </div>
          </div>

          {/* Center headline — fills the previously empty space. */}
          <div className="relative z-10 max-w-lg">
            <h2 className="text-4xl font-extrabold tracking-tight text-white md:text-5xl">
              Every boarding pass.
            </h2>
            <p className="mt-1 text-4xl font-extrabold tracking-tight text-blue-200 md:text-5xl">
              One live picture.
            </p>
            <p className="mt-4 max-w-md text-base leading-relaxed text-blue-50/90">
              RFID-tagged students, live shuttle occupancy and role-based access control for campus
              transport operations - from a single console.
            </p>
          </div>

          {/* Bottom features */}
          <div className="relative z-10">
            <p className="text-xs font-semibold tracking-[0.16em] text-blue-100 uppercase">
              Built for campus transport
            </p>
            <ul className="mt-4 space-y-3">
              {FEATURES.map((feature) => (
                <li
                  key={feature.label}
                  className="flex items-center space-x-3 rounded-xl bg-white/10 p-3 backdrop-blur-md"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10 text-white ring-1 ring-white/20">
                    <Icon name={feature.icon} className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-semibold text-white">{feature.label}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Curved "Login" cut-out tab: the blue curves inward into the white form. */}
          <div className="pointer-events-none absolute top-32 right-0 z-30 hidden select-none md:block">
            <div className="relative h-[72px] w-[100px]">
              <svg
                viewBox="0 0 100 72"
                className="absolute inset-0 h-full w-full"
                aria-hidden="true"
                fill="#ffffff"
              >
                <path d={TAB_PATH} />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center pl-3 text-sm font-black tracking-[0.18em] text-slate-900 uppercase">
                Login
              </span>
            </div>
          </div>
        </aside>

        {/*  Form side  */}
        <section className="flex h-full flex-col bg-white md:col-span-7">
          <div className="flex flex-1 items-center justify-center px-8 md:px-20">
            <div className="w-full max-w-md">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-slate-100 bg-white text-blue-700 shadow-md">
                <Icon
                  name={step === 'email' ? 'user' : step === 'setup' ? 'key' : 'lock'}
                  className="h-7 w-7"
                  strokeWidth={2}
                />
              </div>

              <h1 className="mt-5 text-center text-3xl font-extrabold tracking-tight text-slate-900">
                {step === 'email' ? 'Login' : step === 'setup' ? 'Set your password' : 'Welcome back'}
              </h1>
              <p className="mt-1 mb-6 text-center text-sm text-slate-500">
                {step === 'email'
                  ? `Sign in to the ${institutionName} shuttle operations console.`
                  : step === 'setup'
                    ? 'First time here? Create the password you will use from now on.'
                    : `Enter your password to continue to ${institutionName}.`}
              </p>

              {timedOut ? (
                <div
                  role="status"
                  className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[0.8rem] text-amber-800"
                >
                  <Icon name="alert" className="mt-px h-4 w-4 shrink-0 text-amber-500" />
                  <p className="min-w-0 flex-1">
                    Session expired due to 3 minutes of inactivity. Please sign in again.
                  </p>
                  <button
                    type="button"
                    onClick={() => setTimedOut(false)}
                    className="shrink-0 text-amber-400 transition hover:text-amber-600"
                    aria-label="Dismiss notice"
                  >
                    <Icon name="close" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}

              {error ? (
                <div
                  role="alert"
                  className="mb-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[0.8rem] text-red-700"
                >
                  <Icon name="alert" className="mt-px h-4 w-4 shrink-0 text-red-500" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{error.message || 'Sign-in failed.'}</p>
                    {Array.isArray(error.details) && error.details.length ? (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[0.73rem] text-red-600">
                        {error.details.slice(0, 6).map((detail, index) => (
                          <li key={index}>
                            {detail.field ? (
                              <span className="font-medium">{detail.field}: </span>
                            ) : null}
                            {detail.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setError(null)}
                    className="shrink-0 text-red-400 transition hover:text-red-600"
                    aria-label="Dismiss error"
                  >
                    <Icon name="close" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}

              {/* The step panel is keyed so each transition remounts it and replays
                  the slide animation in the correct direction. */}
              <div key={step} className={step === 'email' ? 'ts-slide-in-left' : `ts-slide-in-${slide}`}>
                {step === 'email' ? (
                  <form onSubmit={onCheckEmail} className="space-y-4" noValidate>
                    <div>
                      <label htmlFor="login-email" className={LABEL_CLASS}>
                        Email address
                      </label>
                      <input
                        id="login-email"
                        ref={emailRef}
                        type="email"
                        name="email"
                        autoComplete="username"
                        placeholder="you@transitsync.edu.np"
                        value={email}
                        onChange={(event) => {
                          setEmail(event.target.value);
                          if (emailError) setEmailError(null);
                        }}
                        disabled={checking}
                        aria-invalid={Boolean(emailError)}
                        required
                        className={`${INPUT_CLASS} ${emailError
                            ? 'border-red-300 bg-red-50/40 focus:border-red-500 focus:ring-red-500/20'
                            : ''
                          }`}
                      />
                      {emailError ? (
                        <p className="mt-1.5 flex items-center gap-1.5 text-[0.76rem] font-medium text-red-600">
                          <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
                          {emailError}
                        </p>
                      ) : null}
                    </div>

                    <button type="submit" disabled={checking} className={SUBMIT_CLASS}>
                      {checking ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <Icon name="arrowRight" className="h-4 w-4" />
                      )}
                      <span>{checking ? 'Checking…' : 'Continue'}</span>
                    </button>
                  </form>
                ) : (
                  <div className="space-y-4">
                    {/* Back to email — shows the address that was verified. */}
                    <button
                      type="button"
                      onClick={goToEmail}
                      className="group flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-left transition hover:border-blue-300 hover:bg-blue-50"
                    >
                      <Icon
                        name="arrowLeft"
                        className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-blue-600"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[0.62rem] font-semibold tracking-[0.12em] text-slate-400 uppercase">
                          Signing in as
                        </span>
                        <span className="block truncate text-[0.85rem] font-semibold text-slate-700">
                          {email}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-[0.72rem] font-semibold text-slate-400 transition group-hover:text-blue-600">
                        <Icon name="edit" className="h-3.5 w-3.5" />
                        Edit
                      </span>
                    </button>

                    {step === 'setup' ? (
                      <form onSubmit={onCreatePassword} className="space-y-4" noValidate>
                        <div
                          role="status"
                          className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[0.78rem] text-blue-800"
                        >
                          <Icon name="shield" className="mt-px h-4 w-4 shrink-0 text-blue-600" />
                          <p>
                            <span className="font-semibold">First-time setup:</span> Please create a
                            secure password for your staff account.
                          </p>
                        </div>

                        <div>
                          <label htmlFor="setup-password" className={LABEL_CLASS}>
                            New password
                          </label>
                          <div className="relative">
                            <input
                              id="setup-password"
                              ref={passwordRef}
                              type={showPassword ? 'text' : 'password'}
                              name="new-password"
                              autoComplete="new-password"
                              placeholder="Create a strong password"
                              value={password}
                              onChange={(event) => setPassword(event.target.value)}
                              disabled={submitting}
                              required
                              className={`${INPUT_CLASS} pr-11`}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword((visible) => !visible)}
                              className="absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
                              aria-label={showPassword ? 'Hide password' : 'Show password'}
                              tabIndex={-1}
                            >
                              <Icon name={showPassword ? 'eyeOff' : 'eye'} className="h-4 w-4" />
                            </button>
                          </div>
                          <PasswordRules value={password} minLength={minLength} />
                        </div>

                        <div>
                          <label htmlFor="setup-confirm" className={LABEL_CLASS}>
                            Confirm password
                          </label>
                          <div className="relative">
                            <input
                              id="setup-confirm"
                              type={showConfirmPassword ? 'text' : 'password'}
                              name="confirm-password"
                              autoComplete="new-password"
                              placeholder="Re-enter your password"
                              value={confirmPassword}
                              onChange={(event) => setConfirmPassword(event.target.value)}
                              disabled={submitting}
                              required
                              className={`${INPUT_CLASS} pr-11`}
                            />
                            <button
                              type="button"
                              onClick={() => setShowConfirmPassword((visible) => !visible)}
                              className="absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
                              aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                              tabIndex={-1}
                            >
                              <Icon name={showConfirmPassword ? 'eyeOff' : 'eye'} className="h-4 w-4" />
                            </button>
                          </div>
                          {confirmPassword && confirmPassword !== password ? (
                            <p className="mt-1.5 flex items-center gap-1.5 text-[0.76rem] font-medium text-red-600">
                              <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
                              Passwords do not match.
                            </p>
                          ) : confirmPassword && confirmPassword === password ? (
                            <p className="mt-1.5 flex items-center gap-1.5 text-[0.76rem] font-medium text-emerald-600">
                              <Icon name="check" className="h-3.5 w-3.5 shrink-0" />
                              Passwords match.
                            </p>
                          ) : null}
                        </div>

                        <button type="submit" disabled={submitting} className={SUBMIT_CLASS}>
                          {submitting ? (
                            <Spinner className="h-4 w-4" />
                          ) : (
                            <Icon name="shield" className="h-4 w-4" />
                          )}
                          <span>{submitting ? 'Creating account…' : 'Create Password & Sign In'}</span>
                        </button>
                      </form>
                    ) : (
                      <form onSubmit={onSignIn} className="space-y-4" noValidate>
                        <div>
                          <label htmlFor="login-password" className={LABEL_CLASS}>
                            Password
                          </label>
                          <div className="relative">
                            <input
                              id="login-password"
                              ref={passwordRef}
                              type={showPassword ? 'text' : 'password'}
                              name="password"
                              autoComplete="current-password"
                              placeholder="••••••••••"
                              value={password}
                              onChange={(event) => setPassword(event.target.value)}
                              disabled={submitting}
                              required
                              className={`${INPUT_CLASS} pr-11`}
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword((visible) => !visible)}
                              className="absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
                              aria-label={showPassword ? 'Hide password' : 'Show password'}
                              tabIndex={-1}
                            >
                              <Icon name={showPassword ? 'eyeOff' : 'eye'} className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                          <label className="flex cursor-pointer items-center gap-2 text-[0.8rem] text-slate-600">
                            <input
                              type="checkbox"
                              checked={rememberMe}
                              onChange={(event) => setRememberMe(event.target.checked)}
                              disabled={submitting}
                              className="h-4 w-4 rounded border-slate-300 accent-blue-600 focus:ring-blue-500/30"
                            />
                            Keep me signed in
                          </label>
                          <button
                            type="button"
                            onClick={() => setForgotHint((visible) => !visible)}
                            className="text-sm font-medium text-blue-600 hover:underline"
                          >
                            Forgot Password?
                          </button>
                        </div>

                        {forgotHint ? (
                          <p className="rounded-lg bg-slate-50 px-3 py-2 text-[0.72rem] leading-relaxed text-slate-500 ring-1 ring-slate-900/5">
                            Password resets are handled by your transport administrator. Contact the
                            Department of Transport &amp; Resource Management.
                          </p>
                        ) : null}

                        <button type="submit" disabled={submitting} className={SUBMIT_CLASS}>
                          {submitting ? (
                            <Spinner className="h-4 w-4" />
                          ) : (
                            <Icon name="logout" className="h-4 w-4" />
                          )}
                          <span>{submitting ? 'Signing in…' : 'Sign In'}</span>
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>

              <p className="mt-3 text-center text-xs text-slate-400">
                Authorised staff only. All access is logged and audited under system policy.
              </p>
            </div>
          </div>

          {/* Footer lives strictly inside the white (right) column. */}
          <div className="w-full px-6 pt-8 pb-4 text-center text-xs font-medium text-slate-400">
            © 2026 TransitSync System • Department of Transport
            &amp; Resource Management. All rights reserved.
          </div>
        </section>
      </main>
    </div>
  );
}

/** Exported for the change-password page, which reuses the same rule display. */
export { PasswordRules };
