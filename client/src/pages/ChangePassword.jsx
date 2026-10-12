import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icon.jsx';
import { FormError, Input, Checkbox } from '../components/form.jsx';
import { Spinner } from '../components/ui.jsx';
import { PasswordRules } from './Login.jsx';
import { api, setToken } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';

/**
 * Forced password rotation.
 *
 * The server rejects every non-auth endpoint while `mustChangePassword` is set,
 * so this page is a hard wall rather than an optional prompt — it renders even
 * when the user deep-links anywhere else.
 */
export default function ChangePassword() {
  const { user, mustChangePassword, refresh, signOut, loading } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // A user who has already rotated has no business here.
  if (!loading && user && !mustChangePassword) return <Navigate to="/" replace />;
  if (!loading && !user) return <Navigate to="/login" replace />;

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      return setError({ message: 'Passwords do not match.', details: [{ field: 'confirmPassword', message: 'Passwords do not match.' }] });
    }
    if (newPassword === currentPassword) {
      return setError({ message: 'New password must be different from the current one.' });
    }

    setSubmitting(true);
    try {
      const response = await api.post('/auth/change-password', {
        currentPassword,
        newPassword,
        confirmPassword,
        revokeOtherSessions,
      });

      // The rotation bumps the user's token_version server-side, which
      // invalidates the JWT we logged in with. Adopt the fresh token carried by
      // the response so the /me probe below (and everything after) keeps
      // authenticating instead of bouncing back to /login.
      if (response?.data?.token) setToken(response.data.token);

      // The rotation response carries a fresh token; re-read /me so the app
      // picks up the cleared gate flag and the new permission set.
      await refresh({ silent: true });
      toast.success('Password updated. Welcome aboard.', { title: 'All set' });
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const fieldErrors = error?.fieldErrors ?? {};

  return (
    <main className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-amber-500/12 text-amber-400 ring-1 ring-amber-500/25">
            <Icon name="key" className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-bold tracking-tight text-mist-100">
            {user?.isFirstLogin ? 'Create your password' : 'Set a new password'}
          </h1>
          <p className="mt-1.5 text-[0.84rem] leading-relaxed text-mist-400">
            {user?.isFirstLogin
              ? 'Your account was created with a temporary password. Choose your own before continuing.'
              : 'Your password must be rotated before you can use the console.'}
          </p>
          {user?.email ? (
            <p className="mt-1 text-[0.75rem] text-mist-500">
              Signed in as <span className="font-medium text-mist-300">{user?.email}</span>
            </p>
          ) : null}
        </div>

        <form onSubmit={onSubmit} className="card space-y-3.5 p-5" noValidate>
          <FormError error={error} onDismiss={() => setError(null)} />

          <Input
            label="Current password"
            type={showPasswords ? 'text' : 'password'}
            autoComplete="current-password"
            icon="lock"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            disabled={submitting}
            error={fieldErrors.currentPassword}
            required
          />

          <Input
            label="New password"
            type={showPasswords ? 'text' : 'password'}
            autoComplete="new-password"
            icon="key"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            disabled={submitting}
            error={fieldErrors.newPassword}
            required
          >
            <PasswordRules value={newPassword} />
          </Input>

          <Input
            label="Confirm new password"
            type={showPasswords ? 'text' : 'password'}
            autoComplete="new-password"
            icon="key"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            disabled={submitting}
            error={fieldErrors.confirmPassword}
            required
          />

          <div className="flex items-center justify-between gap-2 pt-1">
            <Checkbox
              label={
                <>
                  <button
                    type="button"
                    className="text-sky-400 underline-offset-2 hover:underline"
                    onClick={() => setShowPasswords((visible) => !visible)}
                  >
                    {showPasswords ? 'Hide' : 'Show'}
                  </button>{' '}
                  passwords
                </>
              }
              checked={false}
              onChange={() => {}}
              className="[&>span]:inline"
            />
          </div>

          <Checkbox
            label="Sign out my other devices"
            hint="Recommended if the temporary password was shared."
            checked={revokeOtherSessions}
            onChange={(event) => setRevokeOtherSessions(event.target.checked)}
            disabled={submitting}
          />

          <button type="submit" className="btn btn-primary w-full !py-2.5" disabled={submitting}>
            {submitting ? <Spinner className="h-4 w-4" /> : <Icon name="check" className="h-4 w-4" />}
            {submitting ? 'Updating…' : 'Update password & continue'}
          </button>

          <button
            type="button"
            className="btn btn-ghost w-full"
            onClick={async () => {
              await signOut();
              navigate('/login', { replace: true });
            }}
            disabled={submitting}
          >
            Sign out instead
          </button>
        </form>

        <p className="mt-5 text-center text-[0.7rem] text-mist-500">
          Need help? Contact your system administrator.
        </p>
      </div>
    </main>
  );
}
