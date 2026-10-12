/**
 * Routing and route guards.
 *
 * Three guards, all client-side conveniences that mirror server behaviour:
 *
 *  - `SetupGate` sends a never-initialised deployment to /system-setup.
 *  - `Protected` keeps unauthenticated visitors on /login.
 *  - `PermissionGate` renders a 403-style notice instead of a page whose every
 *    API call would fail. The server is still the authority — a user who reaches
 *    the API without the permission gets a real 403 regardless of this check.
 */

import { Suspense, lazy, useEffect, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';

import Layout from './components/Layout.jsx';import ErrorBoundary from './components/ErrorBoundary.jsx';
import { Icon } from './components/Icon.jsx';
import SessionTimeout from './components/SessionTimeout.jsx';
import { EmptyState, Spinner } from './components/ui.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { useApi } from './lib/hooks.js';
import { ToastProvider } from './lib/toast.jsx';

// The auth pages are eagerly imported: they are the first paint for most
// sessions, and a lazy chunk there would trade a blank screen for a spinner.
import Login from './pages/Login.jsx';
import Setup from './pages/Setup.jsx';
import ChangePassword from './pages/ChangePassword.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const LiveMonitor = lazy(() => import('./pages/LiveMonitor.jsx'));
const Students = lazy(() => import('./pages/Students.jsx'));
const StudentDetail = lazy(() => import('./pages/StudentDetail.jsx'));
const Alerts = lazy(() => import('./pages/Alerts.jsx'));
const Fleet = lazy(() => import('./pages/Fleet.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Roles = lazy(() => import('./pages/Roles.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const StudentManagement = lazy(() => import('./pages/StudentManagement.jsx'));
const Colleges = lazy(() => import('./pages/super-admin/Colleges.jsx'));
const PlatformSystem = lazy(() => import('./pages/super-admin/SystemPanel.jsx'));
const StudentPortal = lazy(() => import('./pages/student/StudentPortal.jsx'));

function FullPageSpinner() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--surface)]">
      <Spinner className="h-7 w-7 text-sky-400" />
    </main>
  );
}

/**
 * Dynamic document title: generic "TransitSync — Campus Shuttle Operations
 * Console" while no authenticated user is present; once a user signs in and
 * their campus name is loaded, the brand reflects that institution
 * (e.g. "TransitSync — Everest College").
 */
function DocumentTitle() {
  const { user } = useAuth();

  useEffect(() => {
    const institution = user?.institutionName?.trim();
    document.title = institution
      ? `TransitSync — ${institution}`
      : 'TransitSync — Campus Shuttle Operations Console';
  }, [user]);

  return null;
}

function PageFallback() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Spinner className="h-6 w-6 text-sky-400" />
    </div>
  );
}

/** Requires a session; sends the rotation wall ahead of every other route. */
function Protected() {
  const { isAuthenticated, mustChangePassword, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (mustChangePassword) return <Navigate to="/change-password" replace />;

  return <Outlet />;
}

/** Wraps a page with a permission check and a readable 403 state. */
function PermissionGate({ permission, children }) {
  const { can } = useAuth();

  if (permission && !can(permission)) {
    return (
      <EmptyState
        icon="lock"
        title="You do not have access to this view"
        message={`This page requires the "${permission}" permission, which is not part of your role. Ask an administrator to grant it.`}
        className="min-h-[50vh]"
      />
    );
  }

  return children;
}

/** PLATFORM MASTER surface — reserved for the Level 200 Super Administrator. */
function SuperAdminGate({ children }) {
  const { user } = useAuth();

  if (Number(user?.roleLevel ?? user?.level ?? 0) < 200) {
    return (
      <EmptyState
        icon="lock"
        title="Platform access only"
        message="This area is reserved for the Platform Super Administrator (Level 200)."
        className="min-h-[50vh]"
      />
    );
  }

  return children;
}

/** Read-only rider portal — reserved for the STUDENT role. */
function StudentGate({ children }) {
  const { user } = useAuth();

  if (user?.role !== 'student') {
    return <Navigate to="/" replace />;
  }

  return children;
}

/**
 * Keeps a signed-in student out of the operations console. Students reach the
 * app shell only to be redirected to their own portal.
 */
function StaffOnly() {
  const { user } = useAuth();
  if (user?.role === 'student') return <Navigate to="/student/dashboard" replace />;
  return <Outlet />;
}

/**
 * First-run routing gate.
 *
 * A deployment with no `system_admin` account has nobody who could sign in, so
 * every route — /login included — is dead ends until the master account exists.
 * This gate sends such a deployment to /system-setup, and sends a deployment
 * that is already initialised back to /login if someone bookmarks the wizard.
 *
 * An unreachable API is deliberately treated as "already initialised": a
 * transient outage must not strand the user on a setup screen that cannot work.
 * The following request surfaces the real error.
 */
function SetupGate({ children }) {
  const { data, loading, reload } = useApi('/auth/setup-status');
  const location = useLocation();
  const [rechecking, setRechecking] = useState(false);

  const bootstrapped = data?.bootstrapped !== false;
  const atSetup = location.pathname === '/system-setup';

  // Re-check setup status whenever a not-yet-initialised deployment asks for a
  // route other than the wizard (for example /login right after setup finished).
  // Without this the gate keeps its stale "not bootstrapped" answer and bounces
  // the user back to the wizard, which remounts, refetches, and loops forever.
  useEffect(() => {
    if (bootstrapped) return; // already initialised — nothing to re-check
    if (atSetup) return; // the wizard is the correct place — nothing to bounce
    let active = true;
    setRechecking(true);
    reload({ silent: true }).finally(() => {
      if (active) setRechecking(false);
    });
    return () => {
      active = false;
    };
    // bootstrapped/atSetup are read from the latest render; only the route
    // change triggers the re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (loading) return <FullPageSpinner />;
  if (rechecking) return <FullPageSpinner />; // wait for the fresh answer instead of bouncing

  if (!bootstrapped && !atSetup) return <Navigate to="/system-setup" replace />;
  if (bootstrapped && atSetup) return <Navigate to="/login" replace />;

  return children;
}

function Shell() {
  const { mustChangePassword } = useAuth();

  // The rotation wall must not be reachable behind the app shell.
  if (mustChangePassword) return <Navigate to="/change-password" replace />;

  return (
    <Suspense fallback={<PageFallback />}>
      <Outlet />
    </Suspense>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/system-setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<ChangePassword />} />

      <Route element={<Protected />}>
        {/* Read-only rider portal — its own chrome, no operations console. */}
        <Route
          path="/student/dashboard"
          element={
            <StudentGate>
              <Suspense fallback={<FullPageSpinner />}>
                <StudentPortal />
              </Suspense>
            </StudentGate>
          }
        />

        <Route element={<Shell />}>
          <Route element={<Layout />}>
            <Route element={<StaffOnly />}>
              <Route index element={<Dashboard />} />

            <Route
              path="live"
              element={
                <PermissionGate permission="dashboard:read">
                  <LiveMonitor />
                </PermissionGate>
              }
            />

            <Route
              path="students"
              element={
                <PermissionGate permission="students:read">
                  {Number(user?.roleLevel ?? user?.level ?? 0) >= 200 || user?.role === 'super_admin' ? (
                    <Navigate to="/admin/colleges" replace />
                  ) : (
                    <Students />
                  )}
                </PermissionGate>
              }
            />
            <Route
              path="students/:id"
              element={
                <PermissionGate permission="students:read">
                  {Number(user?.roleLevel ?? user?.level ?? 0) >= 200 || user?.role === 'super_admin' ? (
                    <Navigate to="/admin/colleges" replace />
                  ) : (
                    <StudentDetail />
                  )}
                </PermissionGate>
              }
            />
            <Route
              path="alerts"
              element={
                <PermissionGate permission="alerts:read">
                  <Alerts />
                </PermissionGate>
              }
            />
            <Route
              path="fleet"
              element={
                <PermissionGate permission="fleet:read">
                  {Number(user?.roleLevel ?? user?.level ?? 0) >= 200 || user?.role === 'super_admin' ? (
                    <Navigate to="/admin/colleges" replace />
                  ) : (
                    <Fleet />
                  )}
                </PermissionGate>
              }
            />

            <Route
              path="users"
              element={
                <PermissionGate permission="users:read">
                  <Users />
                </PermissionGate>
              }
            />
            <Route
              path="admin/student-accounts"
              element={
                <PermissionGate permission="users:read">
                  <StudentManagement />
                </PermissionGate>
              }
            />
            <Route
              path="roles"
              element={
                <PermissionGate permission="roles:read">
                  <Roles />
                </PermissionGate>
              }
            />
            <Route
              path="settings"
              element={
                <PermissionGate permission="settings:read">
                  <Settings />
                </PermissionGate>
              }
            />
            <Route path="profile" element={<Profile />} />

            <Route
              path="super-admin/colleges"
              element={
                <SuperAdminGate>
                  <Colleges />
                </SuperAdminGate>
              }
            />
            <Route
              path="super-admin/system"
              element={
                <SuperAdminGate>
                  <PlatformSystem />
                </SuperAdminGate>
              }
            />
            <Route path="super-admin" element={<Navigate to="/super-admin/colleges" replace />} />
            <Route path="/admin/colleges" element={<Navigate to="/super-admin/colleges" replace />} />

            {/* Unknown paths fall back to the Dashboard instead of a dead-end
                "Page not found", so stale bookmarks and typos still show the app. */}
            <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <SessionTimeout />
          <DocumentTitle />
          <SetupGate>
            <ErrorBoundary><AppRoutes /></ErrorBoundary>
          </SetupGate>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

/** Shared icon re-export so pages import from one place. */
export { Icon };



