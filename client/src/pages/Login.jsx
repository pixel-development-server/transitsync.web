import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import GoogleSignInButton from '../components/GoogleSignInButton.jsx';
import { BrandMark, Spinner } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { getDeviceFingerprint } from '../lib/deviceFingerprint.js';
import { GOOGLE_AUTH_ENABLED } from '../lib/features.js';
import { googleError, googleLog } from '../lib/googleDebug.js';
import { useApi } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

/** Value props shown on the branded side panel. */
const FEATURES = [
  { icon: 'wifi', label: 'Live Boarding' },
  { icon: 'trendingUp', label: 'Real-time Analytics (NPT)' },
  { icon: 'shield', label: 'Granular RBAC Control' },
];

/**
 * The Staff/Student toggle is a clean, solid-white capsule pinned flush to the
 * blue hero's right edge. Its solid-white thumb is `rounded-l-full` so the left
 * cap is never clipped and glides vertically between the two 42px slots on a
 * hardware-accelerated `transform`, while its square right edge sits flush on
 * the panel divider.
 */

/** Deliberately loose, client-side format gate; the server validates authoritatively. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Server codes for a wrong-portal sign-in → the portal the account actually belongs to. */
const PORTAL_BY_CODE = {
  STAFF_PORTAL_REQUIRED: 'staff',
  STUDENT_PORTAL_REQUIRED: 'student',
  // Only the full (primary) build can ever receive this code. Spreading the
  // entry conditionally keeps the Google string out of fallback bundles.
  ...(GOOGLE_AUTH_ENABLED ? { GOOGLE_ADMIN_NOT_ALLOWED: 'staff' } : {}),
};

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
      <ul className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
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
  const { establishSession, isAuthenticated, mustChangePassword, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [step, setStep] = useState('email'); // 'email' | 'password' | 'setup'
  // Entrance direction for the animated step swap: forward slides from the right.
  const [slide, setSlide] = useState('right');
  // Who is signing in: operations staff, or a pre-authorized student rider.
  const [audience, setAudience] = useState('staff'); // 'staff' | 'student'
  const isStudent = audience === 'student';

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
  const [googleBusy, setGoogleBusy] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  // Set when the server refuses a valid credential presented at the wrong
  // portal (403). Holds the portal the account actually belongs to so we can
  // offer a one-click switch.
  const [wrongPortal, setWrongPortal] = useState(null); // 'staff' | 'student' | null

  // Platform-owner second factor. Once the password is accepted the server
  // returns a short-lived challenge (not a session), and sign-in finishes here.
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [resending, setResending] = useState(false);

  // Forced password rotation. When sign-in is halted because an administrator
  // set `force_password_reset`, the server answers with a short-lived reset
  // token instead of a session. It is kept here while the inline
  // "create a new password" view is on screen, then discarded.
  const [reset, setReset] = useState(null); // { email, resetToken, name } | null

  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const codeRef = useRef(null);
  // GIS can deliver the credential callback more than once (One Tap + button,
  // or a double click). A ref guards the async exchange, which state alone
  // cannot because setState is not synchronous.
  const googleBusyRef = useRef(false);

  const { data: setup } = useApi('/auth/setup-status');
  const minLength = setup?.passwordPolicy?.minLength ?? 10;
  // Public configuration: the client id is not a secret, and publishing it
  // here keeps the built panel independent of the server's environment file.
  // The request is disabled entirely in Google-free fallback builds, so no
  // OAuth endpoint is ever contacted (or advertised) from that host.
  const { data: googleConfig } = useApi(
    GOOGLE_AUTH_ENABLED ? '/auth/google/config' : null,
    { enabled: GOOGLE_AUTH_ENABLED },
  );

  // Public status endpoint (no session required). Polled once on mount; the
  // banner is a courtesy — the server is the authority that actually refuses
  // sign-ins while maintenance mode is on.
  const { data: systemStatus } = useApi('/system/status');
  const globalMaintenanceMode = Boolean(systemStatus?.isMaintenanceMode);
  const globalMaintenanceMessage = systemStatus?.message || 'Server is currently under maintenance';

  // Tenant-scoped maintenance: once an email is typed, ask the public status
  // endpoint to resolve the address to its campus and report that campus's own
  // switch. Only that campus's users (staff + students) are affected, so the
  // yellow warning appears only when THEIR institution is under maintenance.
  const [campusMaintenance, setCampusMaintenance] = useState(null);
  useEffect(() => {
    if (step !== 'email' || !EMAIL_RE.test(email.trim())) {
      setCampusMaintenance(null);
      return undefined;
    }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await api.get(
          `/system/status?email=${encodeURIComponent(email.trim().toLowerCase())}`,
        );
        if (active) setCampusMaintenance(response.data ?? null);
      } catch {
        if (active) setCampusMaintenance(null);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [email, step]);

  const maintenanceMode = globalMaintenanceMode || Boolean(campusMaintenance?.isMaintenanceMode);
  const maintenanceMessage = campusMaintenance?.isMaintenanceMode
    ? campusMaintenance.message
    : globalMaintenanceMessage;
  const maintenanceInstitution = campusMaintenance?.isMaintenanceMode ? campusMaintenance.institutionName : null;

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
    const timer = setTimeout(() => {
      if (step === 'twofactor') codeRef.current?.focus();
      else passwordRef.current?.focus();
    }, 340);
    return () => clearTimeout(timer);
  }, [step]);

  if (loading) {
    return (
      <div className="login-light grid min-h-dvh w-full place-items-center bg-white">
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
    setWrongPortal(null);
    setChallenge(null);
    setCode('');
    setReset(null);
    setForgotHint(false);
    setShowPassword(false);
    setShowConfirmPassword(false);
    setPassword('');
    setConfirmPassword('');
  };

  /** Switch between the staff console and the student rider portal. */
  const switchAudience = (next) => {
    if (next === audience) return;
    setAudience(next);
    setSlide('left');
    setStep('email');
    setError(null);
    setWrongPortal(null);
    setEmailError(null);
    setChallenge(null);
    setCode('');
    setReset(null);
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
    setWrongPortal(null);

    const value = email.trim().toLowerCase();
    if (!value) return setEmailError('Enter your email address.');
    if (!EMAIL_RE.test(value)) return setEmailError('Enter a valid email address.');

    setChecking(true);
    try {
      const response = await api.post(
        isStudent ? '/auth/student-check-email' : '/auth/check-email',
        { email: value },
      );
      const status = response.data?.status;

      // Defensive only: a server that answers 200 with a NOT_FOUND discriminator.
      if (status === 'NOT_FOUND') {
        setEmailError(
          isStudent
            ? 'No student record found with this email address.'
            : 'No staff account found with this email address.',
        );
        return;
      }

      setEmail(value);
      setPassword('');
      setConfirmPassword('');
      setError(null);
      setWrongPortal(null);
      setSlide('right');
      setStep(status === 'FIRST_TIME_USER' ? 'setup' : 'password');
    } catch (caught) {
      // A 404 (no such account) or 403 (suspended) is an ordinary Step-1
      // outcome, not a transport failure — surface the server's message inline.
      const message = caught?.message || 'We could not verify that address. Please try again.';
      if (['ACCOUNT_SUSPENDED', 'COLLEGE_SUSPENDED', 'STUDENT_INACTIVE'].includes(caught?.code)) {
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
      const response = await api.post('/auth/login', {
        email,
        password,
        rememberMe,
        portalType: isStudent ? 'student' : 'staff',
        // Recognises (or registers) this browser so the server can extend a
        // remembered session and flag a first-time device.
        deviceFingerprint: getDeviceFingerprint(),
      });
      const data = response.data;

      // The platform owner carries a second factor: the server hands back a
      // short-lived challenge instead of a session, and we finish on Step 3.
      if (data?.twoFactorRequired) {
        setChallenge(data);
        setCode('');
        setSlide('right');
        setStep('twofactor');
        if (data.method === 'EMAIL') {
          toast.info(
            data.delivered
              ? `We emailed a 6-digit code to ${data.email}.`
              : `A 6-digit code was generated for ${data.email} — check the server console.`,
            { title: 'Verification code sent' },
          );
        }
        return;
      }

      await establishSession(data);

      // A first-ever sign-in from this browser: the server registered the device
      // and, with "Keep me signed in", remembered it. Announce it through the
      // app-level amber toast, since this page unmounts on the redirect below.
      if (data?.newDevice) {
        toast.warning(
          data.remembered
            ? 'New device recognised and remembered. You can review or revoke it from your account settings.'
            : 'New device recognised. You can review or revoke it from your account settings.',
          { title: 'New device' },
        );
      }

      navigate(isStudent ? '/student/dashboard' : '/', { replace: true });
    } catch (caught) {
      // Forced rotation. The server replies 200 with `success:false` and a
      // `requireNewPassword` flag instead of a session; `api` surfaces that as
      // a thrown error carrying the reset payload. Branch to the inline
      // "create a new password" view rather than rendering a failure.
      if (caught?.requireNewPassword) {
        setReset({
          email: caught.data?.email ?? email,
          resetToken: caught.data?.resetToken,
          name: caught.data?.name,
        });
        setPassword('');
        setConfirmPassword('');
        setShowPassword(false);
        setShowConfirmPassword(false);
        setForgotHint(false);
        setError(null);
        setWrongPortal(null);
        setSlide('right');
        setStep('reset');
        toast.info('Your administrator requires a new password before you can sign in.', {
          title: 'Password reset required',
        });
        return;
      }

      const requiredPortal = PORTAL_BY_CODE[caught?.code];
      if (requiredPortal) {
        setWrongPortal({ portal: requiredPortal, message: caught?.message });
        setError(null);
      } else {
        setWrongPortal(null);
        setError(caught);
      }
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Exchange the Google ID-token credential for a TransitSync session. The
   * server provisions the account with rotation flags already cleared, so this
   * path never hands control to the "create a password" step — even for an
   * `np…` student who has never been added to the registry manually.
   */
  const onGoogleCredential = async (credential) => {
    // Folded away at build time in Google-free bundles; the bundler then drops
    // this whole handler, its imports and the /auth/google call as dead code.
    if (!GOOGLE_AUTH_ENABLED) return;
    if (googleBusyRef.current) {
      googleLog('duplicate credential callback ignored - exchange already in flight');
      return;
    }
    googleBusyRef.current = true;
    setGoogleBusy(true);
    setError(null);
    setEmailError(null);
    setWrongPortal(null);

    const portalType = isStudent ? 'student' : 'staff';
    googleLog('credential callback received', {
      portalType,
      credentialLength: credential?.length ?? 0,
    });

    try {
      if (!credential || typeof credential !== 'string') {
        throw new Error('Google did not return a sign-in credential. Please try again.');
      }

      const response = await api.post('/auth/google', {
        credential,
        // Role hint from the selected tab; the server resolves the authoritative
        // role from the verified email and the campus roster, never from this.
        portalType,
        rememberMe,
        deviceFingerprint: getDeviceFingerprint(),
      });
      const data = response.data ?? {};
      googleLog('token exchange succeeded', {
        userId: data.user?.id ?? data.user?.userId,
        role: data.user?.role,
        tenantId: data.user?.tenantId ?? data.user?.collegeId,
        tokenPresent: Boolean(data.token),
      });

      if (!data.token) {
        throw new Error('The server did not return a session token. Please try again.');
      }

      // Strictly re-read /auth/me so a broken session probe cannot leave us on
      // the login screen with no visible error.
      const me = await establishSession(data);
      const role = me?.role ?? data.user?.role;
      const target = role === 'student' ? '/student/dashboard' : '/';
      googleLog('session established, navigating', {
        role,
        target,
        userId: me?.id ?? me?.userId,
      });

      // Google-provisioned accounts have every rotation flag cleared server-side.
      // This is logged rather than acted on: a password screen must never appear
      // after a successful Google sign-in, even for an `np…` student email.
      if (me?.mustChangePassword || data.mustChangePassword) {
        googleLog('unexpected password-rotation flag on a Google session - ignoring');
      }

      toast.success(
        `Signed in${me?.fullName || me?.name ? ` as ${me.fullName || me.name}` : ''}.`,
        { title: 'Google Sign-In' },
      );
      navigate(target, { replace: true });
    } catch (caught) {
      googleError('sign-in failed', caught);
      const requiredPortal = PORTAL_BY_CODE[caught?.code];
      if (requiredPortal) {
        setWrongPortal({ portal: requiredPortal, message: caught?.message });
      } else {
        setError(caught);
      }
      toast.error(caught?.message || 'Google Sign-In failed. Please try again.', {
        title: 'Google Sign-In failed',
      });
    } finally {
      googleBusyRef.current = false;
      setGoogleBusy(false);
    }
  };

  const onVerifyCode = async (event) => {
    event.preventDefault();
    setError(null);
    const value = code.trim();
    if (!value) return setError({ message: 'Enter the code from your authenticator or email.' });

    setSubmitting(true);
    try {
      const response = await api.post('/auth/2fa/verify', {
        challengeId: challenge?.challengeId,
        code: value,
      });
      await establishSession(response.data);
      toast.success('Two-factor verification complete. Welcome aboard.', {
        title: 'Identity confirmed',
      });
      navigate(isStudent ? '/student/dashboard' : '/', { replace: true });
    } catch (caught) {
      setError(caught);
      setCode('');
      // An expired or superseded challenge cannot be retried — send the user
      // back to the password step rather than letting them hammer a dead id.
      if (caught?.code === 'TWO_FACTOR_EXPIRED' || caught?.code === 'TWO_FACTOR_UNAVAILABLE') {
        setChallenge(null);
        setStep('password');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onResendCode = async () => {
    if (!challenge) return;
    setResending(true);
    try {
      const response = await api.post('/auth/2fa/resend', { challengeId: challenge.challengeId });
      setChallenge((current) => ({ ...current, delivered: response.data?.delivered ?? false }));
      toast.success(
        response.data?.delivered
          ? 'We sent a fresh code to your email.'
          : 'A fresh code was generated — check the server console.',
        { title: 'Code sent' },
      );
    } catch (caught) {
      toast.error(caught.message);
    } finally {
      setResending(false);
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
      const response = await api.post(
        isStudent ? '/auth/student-register' : '/auth/set-first-password',
        { email, password, confirmPassword },
      );
      await establishSession(response.data);
      toast.success(
        isStudent ? 'Your Student pass is active. Welcome aboard.' : 'Your password is set. Welcome aboard.',
        { title: isStudent ? 'Student Card activated' : 'Account activated' },
      );
      navigate(isStudent ? '/student/dashboard' : '/', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Save the password demanded by an administrator-forced reset, then send the
   * user straight back to the standard sign-in state to use it. No session is
   * established here — the server deliberately issues none until the next
   * successful sign-in.
   */
  const onSetNewPassword = async (event) => {
    event.preventDefault();
    setError(null);

    if (password.length < minLength) {
      return setError({
        message: `Use at least ${minLength} characters.`,
        details: [{ field: 'newPassword', message: `Use at least ${minLength} characters.` }],
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
      await api.post('/auth/set-new-password', {
        email: reset?.email ?? email,
        resetToken: reset?.resetToken,
        newPassword: password,
        confirmPassword,
      });

      const nextEmail = reset?.email ?? email;
      setReset(null);
      setSlide('left');
      setStep('password');
      setEmail(nextEmail);
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowConfirmPassword(false);
      toast.success('Your password has been changed. Sign in with your new password.', {
        title: 'Password updated',
      });
    } catch (caught) {
      setError(caught);
      // The reset token is single-use and short-lived: once it is refused there
      // is nothing left to do here, so start over at the email step.
      if (caught?.code === 'RESET_TOKEN_INVALID') {
        setReset(null);
        setPassword('');
        setConfirmPassword('');
        setSlide('left');
        setStep('email');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-light flex h-dvh min-h-dvh w-full flex-col overflow-hidden bg-white">
      {/* Maintenance warning badge — pinned top-right, above the split layout.
          Shown when the platform as a whole is under maintenance, or when the
          campus the typed email belongs to is under maintenance. */}
      {maintenanceMode ? (
        <div
          role="status"
          aria-label="Maintenance notice"
          className="fixed top-3 right-3 left-3 z-50 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-[0.8rem] leading-snug font-bold text-amber-800 break-words shadow-lg shadow-amber-500/10 sm:top-4 sm:right-4 sm:left-auto sm:max-w-[calc(100vw-2rem)]"
        >
          <Icon name="alert" className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="min-w-0 break-words">
            {maintenanceInstitution ? `${maintenanceInstitution} - under maintenance` : 'Server under maintenance'}
          </span>
        </div>
      ) : null}

      {/* -
       * Edge-to-edge split: 5/12 brand panel · 7/12 form panel.
       * */}
      <main className="relative grid w-full min-w-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-12 md:overflow-hidden">
        {/*  Brand side  */}
        <aside className="relative flex flex-col justify-between bg-blue-700 p-6 text-white sm:p-10 md:h-full md:col-span-5 md:p-14">
          {/* Decorative accents, clipped so only the tab may protrude. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
            <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-blue-500/30 blur-3xl" />
            <div className="absolute -bottom-28 -left-24 h-72 w-72 rounded-full bg-blue-900/50 blur-3xl" />
            <div className="absolute top-1/2 -left-1/4 h-40 w-[150%] -translate-y-1/2 -rotate-12 bg-white/5" />
            <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-blue-950/40" />
          </div>

          {/* Top branding */}
          <div className="relative z-10 flex items-center gap-3">
            <BrandMark size={48} rounded="rounded-2xl" className="shadow-lg shadow-blue-950/30" />
            <div>
              <p className="text-xl font-extrabold tracking-tight text-white">TransitSync</p>
              <p className="text-[0.68rem] font-medium tracking-[0.14em] text-blue-100 uppercase">
                Campus Shuttle Operations Console
              </p>
            </div>
          </div>

          {/* Center headline — fills the previously empty space. */}
          <div className="relative z-10 max-w-lg">
            <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl md:text-5xl">
              Every boarding pass.
            </h2>
            <p className="mt-1 text-3xl font-extrabold tracking-tight text-blue-200 sm:text-4xl md:text-5xl">
              One live picture.
            </p>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-blue-50/90 sm:text-base">
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

          {/* Staff / Student sliding notch pinned to the blue hero's right edge.
              A clean, solid-white thumb glides between the STAFF (top) and
              STUDENT (bottom) slots; its square right edge sits flush on the
              panel divider so no sliver of blue shows. Desktop only — the
              horizontal segment below takes over under `lg`. */}
          <div className="pointer-events-auto absolute top-32 right-0 z-30 hidden select-none lg:block">
            <div className="relative flex flex-col py-1 pl-1">
              {/* Sliding white thumb — a single, permanently-mounted element (no
                  `key`) so React never remounts it and the browser can animate
                  the transform across toggles. `pl-1` (no right padding) keeps
                  its right edge flush with the divider. */}
              <div
                aria-hidden="true"
                className="absolute left-1 h-[42px] w-[120px] rounded-l-full bg-white shadow-lg"
                style={{
                  transform: isStudent ? 'translateY(42px)' : 'translateY(0px)',
                  transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1), background-color 150ms ease',
                  willChange: 'transform',
                }}
              />

              {/* Staff option */}
              <button
                type="button"
                onClick={() => switchAudience('staff')}
                disabled={submitting || checking}
                aria-pressed={!isStudent}
                aria-label="Sign in as staff"
                className="relative z-10 flex h-[42px] w-[120px] items-center justify-center gap-1.5 text-xs font-bold tracking-wider uppercase"
                style={{
                  color: !isStudent ? '#1e3a8a' : 'rgba(255, 255, 255, 0.8)',
                  transition: 'color 150ms ease',
                }}
              >
                <Icon name="user" className="h-4 w-4" strokeWidth={2.2} />
                STAFF
              </button>

              {/* Student option */}
              <button
                type="button"
                onClick={() => switchAudience('student')}
                disabled={submitting || checking}
                aria-pressed={isStudent}
                aria-label="Sign in as student"
                className="relative z-10 flex h-[42px] w-[120px] items-center justify-center gap-1.5 text-xs font-bold tracking-wider uppercase"
                style={{
                  color: isStudent ? '#1e3a8a' : 'rgba(255, 255, 255, 0.8)',
                  transition: 'color 150ms ease',
                }}
              >
                <Icon name="graduationCap" className="h-4 w-4" strokeWidth={2.2} />
                STUDENT
              </button>
            </div>
          </div>
        </aside>

        {/*  Form side  */}
        <section className="flex flex-col bg-white md:h-full md:col-span-7">
          <div className="flex flex-1 items-center justify-center px-5 py-8 sm:px-8 md:px-12 md:py-0 xl:px-20">
            <div className="w-full max-w-md">
              {/* Audience switch: staff console vs. student rider portal. On
                  larger screens the morphing notch on the brand panel takes
                  over; this horizontal segment is the small-screen fallback. */}
              <div className="mb-6 flex justify-center lg:hidden">
                <div
                  role="tablist"
                  aria-label="Sign-in type"
                  className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1"
                >
                  {[
                    { key: 'staff', label: 'Staff', icon: 'users' },
                    { key: 'student', label: 'Student', icon: 'students' },
                  ].map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      role="tab"
                      aria-selected={audience === option.key}
                      onClick={() => switchAudience(option.key)}
                      disabled={submitting || checking}
                      className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[0.8rem] font-semibold transition ${audience === option.key
                        ? 'bg-white text-blue-700 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                        }`}
                    >
                      <Icon name={option.icon} className="h-3.5 w-3.5" />
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-slate-100 bg-white text-blue-700 shadow-md">
                <Icon
                  name={
                    step === 'email'
                      ? (isStudent ? 'students' : 'user')
                      : step === 'twofactor'
                        ? 'shield'
                        : step === 'setup' || step === 'reset'
                          ? 'key'
                          : 'lock'
                  }
                  className="h-7 w-7"
                  strokeWidth={2}
                />
              </div>

              <h1 className="mt-5 text-center text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
                {step === 'email'
                  ? (isStudent ? 'Student Portal' : 'Staff Sign-In')
                  : step === 'twofactor'
                    ? "Verify it's you"
                    : step === 'setup'
                      ? (isStudent ? 'Activate your pass' : 'Set your password')
                      : step === 'reset'
                        ? 'Create a new password'
                        : 'Welcome back'}
              </h1>
              <p className="mt-1 mb-6 text-center text-sm text-slate-500">
                {step === 'email'
                  ? (isStudent
                    ? 'Access your route, bus and live shuttle status for your campus.'
                    : 'Sign in to your campus shuttle operations console.')
                  : step === 'twofactor'
                    ? (challenge?.method === 'EMAIL'
                      ? `Enter the 6-digit code we sent to ${challenge?.email}.`
                      : 'Enter the 6-digit code from your authenticator app.')
                    : step === 'setup'
                      ? (isStudent
                        ? 'Create the password you will use to reach your Student dashboard.'
                        : 'First time here? Create the password you will use from now on.')
                      : step === 'reset'
                        ? 'Your administrator requires a new password before you can sign in.'
                        : 'Enter your password to continue.'}
              </p>

              {maintenanceMode ? (
                <div
                  role="alert"
                  className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[0.8rem] text-amber-800"
                >
                  <Icon name="alert" className="mt-px h-4 w-4 shrink-0 text-amber-500" />
                  <p className="min-w-0 flex-1">
                    <span className="font-semibold">Maintenance in progress.</span> {maintenanceMessage}{' '}
                    {maintenanceInstitution
                      ? 'You can not sign in right now.'
                      : 'Only the Platform Super Administrator can sign in right now.'}
                  </p>
                </div>
              ) : null}

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

              {wrongPortal ? (
                <div
                  role="alert"
                  className="mb-4 flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[0.8rem] text-amber-800"
                >
                  <Icon name="alert" className="mt-px h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      {wrongPortal.portal === 'student' ? 'This is a student account.' : 'This is a staff account.'}
                    </p>
                    <p className="mt-0.5">
                      {wrongPortal.message ||
                        (wrongPortal.portal === 'student'
                          ? 'Student accounts sign in through the Student Portal.'
                          : 'Operations accounts sign in through the Staff console.')}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        switchAudience(wrongPortal.portal);
                        setWrongPortal(null);
                      }}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-2.5 py-1 text-[0.75rem] font-semibold text-white transition hover:bg-amber-600"
                    >
                      <Icon name="arrowRight" className="h-3.5 w-3.5" />
                      {wrongPortal.portal === 'student' ? 'Go to Student Portal' : 'Go to Staff Sign-In'}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setWrongPortal(null)}
                    className="shrink-0 text-amber-400 transition hover:text-amber-600"
                    aria-label="Dismiss notice"
                  >
                    <Icon name="close" className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}

              {/* Git-hosted fallback: static-only edition. Live authentication and
                  data return automatically when the primary server is healthy. */}
              {!GOOGLE_AUTH_ENABLED && step === 'email' ? (
                <div
                  role="note"
                  className="mb-4 flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-[0.8rem] text-slate-600"
                >
                  <Icon name="info" className="mt-px h-4 w-4 shrink-0 text-slate-400" />
                  <p className="min-w-0 flex-1">
                    Fallback edition — live authentication and data are served by the primary server
                    whenever it is online.
                  </p>
                </div>
              ) : null}

              {/* Blue notice banner for the student rider portal. */}
              {isStudent && step === 'email' ? (
                <div
                  role="note"
                  className="mb-4 flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[0.8rem] text-blue-800"
                >
                  <Icon name="info" className="mt-px h-4 w-4 shrink-0 text-blue-500" />
                  <p className="min-w-0 flex-1">
                    Only verified institutional student emails (e.g., @yourcollege.edu) can access live
                    route schedules.
                  </p>
                </div>
              ) : null}

              {/* The step panel is keyed so each transition remounts it and replays
                  the slide animation in the correct direction. */}
              <div key={step} className={step === 'email' ? 'ts-slide-in-left' : `ts-slide-in-${slide}`}>
                {step === 'email' ? (
                  <div className="space-y-4">
                    {GOOGLE_AUTH_ENABLED && googleConfig?.enabled ? (
                      <>
                        <GoogleSignInButton
                          clientId={googleConfig.clientId}
                          onCredential={onGoogleCredential}
                          disabled={checking || submitting}
                          busy={googleBusy}
                        />
                        <div className="flex items-center gap-3 text-[0.66rem] font-semibold tracking-wider text-slate-400 uppercase">
                          <span className="h-px flex-1 bg-slate-200" />
                          <span>or sign in with email</span>
                          <span className="h-px flex-1 bg-slate-200" />
                        </div>
                      </>
                    ) : null}
                    <form onSubmit={onCheckEmail} className="space-y-4" noValidate>
                    <div>
                      <label htmlFor="login-email" className={LABEL_CLASS}>
                        {isStudent ? 'Institutional email' : 'Email address'}
                      </label>
                      <input
                        id="login-email"
                        ref={emailRef}
                        type="email"
                        name="email"
                        autoComplete="username"
                        placeholder={isStudent ? 'student@yourcollege.edu' : 'admin@yourcollege.edu'}
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
                      <span>{checking ? 'Checking…' : isStudent ? 'Continue to Student Portal' : 'Continue to Staff Dashboard'}</span>
                    </button>
                    </form>
                    <p className="text-center text-[0.72rem] leading-snug text-slate-500">
                      Administrators continue with their provisioned email and password.
                    </p>
                  </div>
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
                          {step === 'reset' ? 'Resetting password for' : 'Signing in as'}
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

                    {step === 'twofactor' ? (
                      <form onSubmit={onVerifyCode} className="space-y-4" noValidate>
                        <div
                          role="status"
                          className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[0.78rem] text-blue-800"
                        >
                          <Icon name="shield" className="mt-px h-4 w-4 shrink-0 text-blue-600" />
                          <p>
                            <span className="font-semibold">Two-factor protection:</span>{' '}
                            {challenge?.method === 'EMAIL'
                              ? `We emailed a one-time code to ${challenge?.email}. It expires in a few minutes.`
                              : 'Open your authenticator app and enter the current 6-digit code. A one-time recovery code works here too.'}
                          </p>
                        </div>

                        <div>
                          <label htmlFor="login-code" className={LABEL_CLASS}>
                            Verification code
                          </label>
                          <input
                            id="login-code"
                            ref={codeRef}
                            type="text"
                            name="one-time-code"
                            inputMode="text"
                            autoComplete="one-time-code"
                            autoCapitalize="characters"
                            placeholder="123456"
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            disabled={submitting}
                            required
                            className={`${INPUT_CLASS} font-mono tracking-[0.3em]`}
                          />
                        </div>

                        <button type="submit" disabled={submitting} className={SUBMIT_CLASS}>
                          {submitting ? (
                            <Spinner className="h-4 w-4" />
                          ) : (
                            <Icon name="shield" className="h-4 w-4" />
                          )}
                          <span>{submitting ? 'Verifying…' : 'Verify & Sign In'}</span>
                        </button>

                        {challenge?.method === 'EMAIL' ? (
                          <button
                            type="button"
                            onClick={onResendCode}
                            disabled={resending || submitting}
                            className="w-full text-center text-sm font-medium text-blue-600 hover:underline disabled:opacity-60"
                          >
                            {resending ? 'Sending a new code…' : 'Resend code'}
                          </button>
                        ) : null}
                      </form>
                    ) : step === 'setup' ? (
                      <form onSubmit={onCreatePassword} className="space-y-4" noValidate>
                        <div
                          role="status"
                          className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[0.78rem] text-blue-800"
                        >
                          <Icon name="shield" className="mt-px h-4 w-4 shrink-0 text-blue-600" />
                          <p>
                            <span className="font-semibold">First-time setup:</span> Please create a
                            secure password for your {isStudent ? 'student' : 'staff'} account.
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
                    ) : step === 'reset' ? (
                      <form onSubmit={onSetNewPassword} className="space-y-4" noValidate>
                        <div
                          role="status"
                          className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[0.78rem] text-amber-800"
                        >
                          <Icon name="shield" className="mt-px h-4 w-4 shrink-0 text-amber-600" />
                          <p>
                            <span className="font-semibold">Password reset required:</span>{' '}
                            Your administrator has asked you to choose a new password. Save it
                            below, then sign in with it.
                          </p>
                        </div>

                        <div>
                          <label htmlFor="reset-password" className={LABEL_CLASS}>
                            New password
                          </label>
                          <div className="relative">
                            <input
                              id="reset-password"
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
                          <label htmlFor="reset-confirm" className={LABEL_CLASS}>
                            Confirm new password
                          </label>
                          <div className="relative">
                            <input
                              id="reset-confirm"
                              type={showConfirmPassword ? 'text' : 'password'}
                              name="confirm-password"
                              autoComplete="new-password"
                              placeholder="Re-enter your new password"
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
                              <Icon name="alert" className="h-3.5 w-3.5" />
                              Passwords do not match.
                            </p>
                          ) : confirmPassword && confirmPassword === password ? (
                            <p className="mt-1.5 flex items-center gap-1.5 text-[0.76rem] font-medium text-emerald-600">
                              <Icon name="check" className="h-3.5 w-3.5" />
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
                          <span>{submitting ? 'Saving…' : 'Save New Password'}</span>
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
                            {isStudent
                              ? 'Password resets are handled by your college transport office. Contact them with your student ID.'
                              : 'Password resets are handled by your transport administrator. Contact the Department of Transport & Resource Management.'}
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
                {isStudent
                  ? 'Read-only Student access. Activity is logged for campus transport records.'
                  : 'Authorized staff only. All access is logged and audited under system policy.'}
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
