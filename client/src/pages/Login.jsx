import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import { Spinner } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';

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

/** Redaction rules mirroring the server's password policy endpoint. */
function PasswordRules({ value }) {
  const rules = [
    { label: 'At least 10 characters', ok: value.length >= 10 },
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

export default function Login() {
  const { signIn, isAuthenticated, mustChangePassword, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

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
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotHint, setForgotHint] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: setup } = useApi('/auth/setup-status');
  const institutionName = setup?.institutionName || 'Itahari International College';

  useEffect(() => {
    document.title = `Sign in · ${institutionName}`;
  }, [institutionName]);

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

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!email.trim()) return setError({ message: 'Enter your email address.' });
    if (!password) return setError({ message: 'Enter your password.' });

    setSubmitting(true);
    try {
      await signIn(email.trim().toLowerCase(), password, rememberMe);
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught);
      setPassword('');
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
                <Icon name="user" className="h-7 w-7" strokeWidth={2} />
              </div>

              <h1 className="mt-5 text-center text-3xl font-extrabold tracking-tight text-slate-900">
                Login
              </h1>
              <p className="mt-1 mb-6 text-center text-sm text-slate-500">
                Sign in to the {institutionName} shuttle operations console.
              </p>

              <form onSubmit={onSubmit} className="space-y-4" noValidate>
                {error ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[0.8rem] text-red-700"
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

                <div>
                  <label htmlFor="login-email" className={LABEL_CLASS}>
                    Email address
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    name="email"
                    autoComplete="username"
                    placeholder="you@transitsync.edu.np"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={submitting}
                    required
                    className={INPUT_CLASS}
                  />
                </div>

                <div>
                  <label htmlFor="login-password" className={LABEL_CLASS}>
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="login-password"
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

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-6 py-3.5 text-sm font-bold text-white shadow-lg shadow-blue-600/30 transition-all hover:bg-blue-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    <Icon name="logout" className="h-4 w-4" />
                  )}
                  <span>{submitting ? 'Signing in…' : 'Sign in'}</span>
                </button>

                <p className="mt-3 text-center text-xs text-slate-400">
                  Authorised staff only. All access is logged and audited under system policy.
                </p>
              </form>
            </div>
          </div>

          {/* Footer lives strictly inside the white (right) column. */}
          <div className="w-full px-6 pt-8 pb-4 text-center text-xs font-medium text-slate-400">
            © 2026 TransitSync System — Itahari International College • Department of Transport
            &amp; Resource Management. All rights reserved.
          </div>
        </section>
      </main>
    </div>
  );
}

/** Exported for the change-password page, which reuses the same rule display. */
export { PasswordRules };
