/**
 * Application shell: sidebar, topbar and the <Outlet> outlet for pages.
 *
 * Responsibilities kept deliberately narrow — this file owns navigation, the
 * global alert badge and the session menu. Anything a page needs for itself it
 * fetches itself, so navigating away always tears down its subscriptions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { Icon } from './Icon.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { Badge, LiveIndicator } from './ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';
import { useEventStream } from '../lib/stream.js';
import { NAV_SECTIONS, canSeeNavItem } from '../lib/nav.js';
import { initials } from '../lib/format.js';

const THEME_KEY = 'transitsync.theme';

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) || 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}

/** Closes a popover when the user clicks outside it or presses Escape. */
function useDismissable(onDismiss) {
  const ref = useRef(null);

  useEffect(() => {
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) onDismiss();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss]);

  return ref;
}

export default function Layout() {
  const { user, can, signOut, mustChangePassword } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState('');

  const menuRef = useDismissable(() => setMenuOpen(false));

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  // While the drawer is open on a phone, lock the page behind it so a swipe
  // scrolls the menu instead of the dashboard underneath.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sidebarOpen]);

  // A new alert changes the sidebar badge. The reload handle is held in a ref so
  // the stream callback can stay referentially stable and never tear down the
  // EventSource on every render.
  const reloadAlertStatsRef = useRef(null);

  // Open-alert count for the sidebar badge. Polled rather than streamed because
  // `alerts:read` is optional — a user without it must not trigger a failed call.
  const { data: alertStats, reload: reloadAlertStats } = useApi('/alerts/stats', {
    enabled: can('alerts:read') && !mustChangePassword,
  });

  // Assigning a ref during render is a side effect React may repeat or discard;
  // an effect keeps the stream callback stable without that risk.
  useEffect(() => {
    reloadAlertStatsRef.current = reloadAlertStats;
  }, [reloadAlertStats]);

  const { status: streamStatus } = useEventStream({
    enabled: !mustChangePassword,
    onEvent: useCallback((event) => {
      if (event === 'alert') reloadAlertStatsRef.current?.();
    }, []),
  });

  const openAlerts = alertStats?.open ?? null;

  const roleLevel = Number(user?.roleLevel ?? 0);

  const visibleSections = useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((item) => canSeeNavItem(item, { can, roleLevel })),
      })).filter((section) => section.items.length > 0),
    [can, roleLevel],
  );

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <div className="relative flex min-h-dvh bg-[var(--surface)]">
      <div className="aurora" aria-hidden="true" />

      {/* ---------------------------------------------------------------- */}
      {/* Sidebar                                                          */}
      {/* ---------------------------------------------------------------- */}
      {sidebarOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-[var(--border-subtle)] bg-[var(--glass-fill-strong)] backdrop-blur-xl transition-transform pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-[var(--border-subtle)] px-4">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white shadow-lg shadow-brand-600/25">
            <Icon name="bus" className="h-4.5 w-4.5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.9rem] leading-tight font-extrabold tracking-tight text-mist-100">
              TransitSync
            </p>
            <p className="truncate text-[0.63rem] tracking-[0.08em] text-mist-500 uppercase">
              Shuttle Operations
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost ml-auto !p-1.5 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Main navigation">
          {visibleSections.map((section) => (
            <div key={section.label}>
              <p className="mb-1.5 px-2 text-[0.63rem] font-bold tracking-[0.1em] text-mist-500 uppercase">
                {section.label}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        `group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[0.83rem] transition ${
                          isActive
                            ? 'bg-brand-500/10 font-semibold text-brand-500'
                            : 'font-medium text-mist-400 hover:bg-brand-500/[0.06] hover:text-mist-100'
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon
                            name={item.icon}
                            className={`h-4 w-4 shrink-0 ${isActive ? 'text-brand-500' : 'text-mist-500 group-hover:text-mist-300'}`}
                          />
                          <span className="flex-1 truncate">{item.label}</span>
                          {item.badge === 'alerts' && openAlerts > 0 ? (
                            <Badge tone="bad" className="tabular">
                              {openAlerts > 99 ? '99+' : openAlerts}
                            </Badge>
                          ) : null}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-[var(--border-subtle)] px-3 py-3">
          <div className="mb-2 flex items-center justify-between px-2">
            <LiveIndicator status={streamStatus} />
            <button
              type="button"
              onClick={toggle}
              className="btn btn-ghost !p-1.5"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="px-2 text-[0.63rem] leading-relaxed text-mist-500">
            v1.0.0 · SQLite · SSE
          </p>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Main column                                                      */}
      {/* ---------------------------------------------------------------- */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] bg-[var(--glass-fill-strong)] px-4 backdrop-blur-xl [height:calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]">
          <button
            type="button"
            className="btn btn-ghost !p-1.5 lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <Icon name="menu" className="h-4.5 w-4.5" />
          </button>

          <form
            className="relative hidden min-w-0 flex-1 md:block"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const term = globalQuery.trim();
              navigate(term ? `/students?search=${encodeURIComponent(term)}` : '/students');
            }}
          >
            <Icon
              name="search"
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-mist-500"
            />
            <input
              type="search"
              value={globalQuery}
              onChange={(event) => setGlobalQuery(event.target.value)}
              placeholder="Search students, buses, routes…"
              aria-label="Global search"
              className="field !rounded-xl pr-10 pl-9"
            />
            <button
              type="submit"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-lg p-1.5 text-mist-500 transition hover:bg-brand-500/10 hover:text-brand-500"
              aria-label="Apply filters"
              title="Search"
            >
              <Icon name="filter" className="h-4 w-4" />
            </button>
          </form>

          <button
            type="button"
            onClick={() => navigate('/alerts')}
            className="btn btn-ghost relative !p-2"
            aria-label={openAlerts > 0 ? `${openAlerts} open alerts` : 'Open alerts'}
            title="Alerts"
          >
            <Icon name="bell" className="h-4.5 w-4.5" />
            {openAlerts > 0 ? (
              <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[0.6rem] font-bold text-white">
                {openAlerts > 99 ? '99+' : openAlerts}
              </span>
            ) : null}
          </button>

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-brand-500/[0.07]"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-sky-500 text-[0.7rem] font-bold text-white">
                {initials(user?.fullName)}
              </span>
              <span className="hidden min-w-0 text-left sm:block">
                <span className="block max-w-[9rem] truncate text-[0.78rem] font-semibold text-mist-200">
                  {user?.fullName ?? user?.email}
                </span>
                <span className="block max-w-[9rem] truncate text-[0.66rem] text-mist-500">
                  {user?.roleName ?? user?.role}
                </span>
              </span>
              <Icon name="chevronDown" className="hidden h-3.5 w-3.5 text-mist-500 sm:block" />
            </button>

            {menuOpen ? (
              <div
                role="menu"
                className="card absolute right-0 z-50 mt-2 w-60 overflow-hidden py-1 shadow-2xl"
              >
                <div className="border-b border-[var(--border-subtle)] px-3.5 py-2.5">
                  <p className="truncate text-[0.82rem] font-semibold text-mist-100">{user?.fullName}</p>
                  <p className="truncate text-[0.7rem] text-mist-500">{user?.email}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <Badge tone="accent">{user?.roleName ?? user?.role}</Badge>
                    <Badge tone="neutral">Level {user?.roleLevel ?? '—'}</Badge>
                  </div>
                </div>

                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8rem] text-mist-300 transition hover:bg-brand-500/[0.08]"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate('/profile');
                  }}
                >
                  <Icon name="user" className="h-4 w-4 text-mist-500" />
                  My profile
                </button>

                {can('settings:read') ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[0.8rem] text-mist-300 transition hover:bg-brand-500/[0.08]"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/settings');
                    }}
                  >
                    <Icon name="settings" className="h-4 w-4 text-mist-500" />
                    System settings
                  </button>
                ) : null}

                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2.5 border-t border-[var(--border-subtle)] px-3.5 py-2 text-left text-[0.8rem] text-red-400 transition hover:bg-red-500/10"
                  onClick={handleSignOut}
                >
                  <Icon name="logout" className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        <footer className="shrink-0 border-t border-[var(--border-subtle)] px-6 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <p className="text-[0.7rem] text-mist-500">
            TransitSync — RFID campus shuttle management · Itahari International College
          </p>
        </footer>
      </div>
    </div>
  );
}