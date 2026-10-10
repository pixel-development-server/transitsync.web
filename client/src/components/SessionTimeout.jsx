/**
 * Global inactivity auto-logout.
 *
 * A single listener armed only while a session exists. Any real interaction
 * (`mousemove`, `mousedown`, `keydown`, `touchstart`, `scroll`) restarts the
 * three-minute clock; when it elapses the session is cleared and the visitor is
 * returned to /login with `?reason=timeout`, which the Login screen turns into a
 * one-time notice.
 *
 * Two details matter for correctness:
 *
 *  - Activity is throttled. `mousemove` fires dozens of times per second and a
 *    naive `setTimeout`/`clearTimeout` on every event is a measurable cost, so
 *    the clock is only rebuilt at most once per second.
 *  - Ordering matters. `signOut()` clears the token and React state, then the
 *    redirect carries `?reason=timeout`; doing it the other way round would let
 *    the `Protected` guard bounce the user to a bare `/login` first.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../lib/auth.jsx';

const TIMEOUT_MS = 3 * 60 * 1000; // exactly three minutes
const THROTTLE_MS = 1000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];

export default function SessionTimeout() {
  const { isAuthenticated, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated) return undefined;

    let timer = null;
    let lastReset = 0;

    const expire = () => {
      // Clear first so a stray activity event after this cannot re-arm.
      if (timer) clearTimeout(timer);
      timer = null;
      Promise.resolve(signOut({ notifyServer: true }))
        .catch(() => {
          /* a dead session still needs clearing on the client */
        })
        .finally(() => {
          navigate('/login?reason=timeout', { replace: true });
        });
    };

    const reset = () => {
      const now = Date.now();
      if (now - lastReset < THROTTLE_MS) return;
      lastReset = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(expire, TIMEOUT_MS);
    };

    reset();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }

    return () => {
      if (timer) clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, reset);
      }
    };
    // `signOut` (useCallback with no deps) and `navigate` (react-router) are
    // stable, so this effect arms once per sign-in rather than per render.
  }, [isAuthenticated, signOut, navigate]);

  return null;
}
