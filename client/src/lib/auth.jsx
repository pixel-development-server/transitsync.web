/**
 * Session state, resolved permissions and the forced-password-rotation gate.
 *
 * The server exposes 24 permission keys (`students:edit`, `alerts:resolve`, …).
 * The client never re-implements the policy — it only reads the *effective*
 * permission array that `/api/auth/me` returns for the signed-in user, which the
 * server computed from the role plus any per-user overrides. A client-side check
 * is therefore a UX affordance (hide the button), never a security control.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { api, setToken, setUnauthorizedHandler, getToken } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  // `loading` covers only the initial /me probe. Later refreshes use `refreshing`
  // so the UI does not collapse back to a full-page spinner.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const mustChangePassword = Boolean(user?.mustChangePassword);

  const signOut = useCallback(async ({ notifyServer = true } = {}) => {
    if (notifyServer) {
      try {
        await api.post('/auth/logout');
      } catch {
        // A dead session still needs clearing on the client.
      }
    }
    setToken(null);
    setUser(null);
    setSession(null);
  }, []);

  // Any 401 surfaced by the API layer lands here.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
      setSession(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const loadSession = useCallback(async ({ silent = false } = {}) => {
    if (!getToken()) {
      setUser(null);
      setSession(null);
      setLoading(false);
      return null;
    }

    if (silent) setRefreshing(true);
    try {
      const response = await api.get('/auth/me');
      setUser(response.data.user);
      setSession(response.data.session ?? null);
      return response.data.user;
    } catch {
      setToken(null);
      setUser(null);
      setSession(null);
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const signIn = useCallback(async (email, password, rememberMe = false) => {
    const response = await api.post('/auth/login', { email, password, rememberMe });
    const data = response.data;
    setToken(data.token);
    // Re-read /me rather than trusting the login payload: it carries the
    // effective permission array and session row the app actually runs on.
    const me = await loadSession({ silent: true });
    return me ?? data.user;
  }, [loadSession]);

  const value = useMemo(
    () => ({
      user,
      session,
      loading,
      refreshing,
      permissions,
      mustChangePassword,
      isAuthenticated: Boolean(user),
      isSuperAdmin: user?.role === 'system_admin',
      can: (permission) => permissions.has(permission),
      canAny: (...list) => list.some((permission) => permissions.has(permission)),
      signIn,
      signOut,
      refresh: loadSession,
    }),
    [user, session, loading, refreshing, permissions, mustChangePassword, signIn, signOut, loadSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
}