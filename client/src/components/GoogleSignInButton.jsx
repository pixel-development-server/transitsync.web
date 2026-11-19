/**
 * Official Google Identity Services sign-in button.
 *
 * The button itself is rendered by Google's `gsi/client` script, so the
 * multi-colour "G" and the "Continue with Google" wording are the real brand
 * assets rather than an imitation. Only the ID-token `credential` reaches our
 * server; it is verified there before any TransitSync session is created.
 *
 * Three failure modes are handled explicitly so a broken Google handshake is
 * never silent: the script failing to load, the script loading but not exposing
 * `google.accounts.id`, and `renderButton` throwing (e.g. an unauthorised
 * JavaScript origin). Each case flips to a labelled fallback button that
 * retries the whole bootstrap on click.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { googleError, googleLog } from '../lib/googleDebug.js';

const SCRIPT_ID = 'transitsync-google-identity-services';
/** A blocked/slow accounts.google.com must not leave a permanently dead button. */
const SCRIPT_LOAD_TIMEOUT_MS = 8000;

let scriptPromise = null;

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.id) {
    googleLog('gis already available');
    return Promise.resolve(window.google);
  }
  if (scriptPromise) return scriptPromise;

  googleLog('gis script load started', { src: 'https://accounts.google.com/gsi/client' });
  scriptPromise = new Promise((resolve, reject) => {
    // Declared before the element is inserted: a cached script can fire `load`
    // almost immediately, and `settle` must always have a timer to clear.
    let timer;
    let settled = false;
    const settle = (fn) => (detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(detail);
    };

    let script = document.getElementById(SCRIPT_ID);
    if (!script) {
      script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }

    timer = setTimeout(
      settle(() => {
        // Drop the element so the next click creates a fresh request.
        document.getElementById(SCRIPT_ID)?.remove();
        googleError('gis script load timed out', new Error(`No response within ${SCRIPT_LOAD_TIMEOUT_MS}ms`));
        reject(new Error('Google Identity Services took too long to load.'));
      }),
      SCRIPT_LOAD_TIMEOUT_MS,
    );

    script.addEventListener(
      'load',
      settle(() => {
        if (window.google?.accounts?.id) {
          googleLog('gis script loaded');
          resolve(window.google);
          return;
        }
        document.getElementById(SCRIPT_ID)?.remove();
        googleError('gis script loaded without accounts.id', new Error('accounts.id missing'));
        reject(new Error('Google Identity Services did not initialise.'));
      }),
      { once: true },
    );
    script.addEventListener(
      'error',
      settle(() => {
        document.getElementById(SCRIPT_ID)?.remove();
        googleError('gis script failed to load', new Error('script error event'));
        reject(new Error('Google Identity Services could not be loaded.'));
      }),
      { once: true },
    );
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });

  return scriptPromise;
}

/** Official four-colour Google mark, used only if the GIS script is blocked. */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="h-4 w-4 shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.76 24c0-1.6.28-3.15.77-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.87.93 7.52 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function GoogleSignInButton({ clientId, onCredential, disabled = false, busy = false }) {
  const hostRef = useRef(null);
  const callbackRef = useRef(onCredential);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  // Bumped by the fallback button so the whole GIS bootstrap can be retried.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    callbackRef.current = onCredential;
  }, [onCredential]);

  // Google's button takes an explicit pixel width. Follow the card as it
  // shrinks on mobile so the button never introduces horizontal scrolling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect?.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (!clientId) return undefined;
    let active = true;
    setFailed(false);
    googleLog('initializing GIS', { clientIdSet: true, retryToken });
    loadGoogleIdentityServices()
      .then((google) => {
        if (!active) return;
        google.accounts.id.initialize({
          client_id: clientId,
          // This is the callback that receives the ID token after the account
          // picker closes. It runs in the page context, so onCredential can call
          // the API and navigate normally.
          callback: ({ credential }) => {
            googleLog('GIS credential callback fired', {
              credentialLength: credential?.length ?? 0,
              hasCallback: typeof callbackRef.current === 'function',
            });
            if (credential) callbackRef.current?.(credential);
            else googleError('GIS credential callback had no token', new Error('credential missing'));
          },
          ux_mode: 'popup',
          auto_select: false,
          itp_support: true,
        });
        googleLog('GIS initialized');
        setFailed(false);
        setReady(true);
      })
      .catch((error) => {
        if (active) {
          googleError('GIS initialization failed', error);
          setFailed(true);
          setReady(false);
        }
      });
    return () => {
      active = false;
    };
  }, [clientId, retryToken]);

  useEffect(() => {
    if (!ready || !hostRef.current || !window.google?.accounts?.id) return;
    const host = hostRef.current;
    host.replaceChildren();
    try {
      window.google.accounts.id.renderButton(host, {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        width: Math.max(200, Math.min(420, width || 280)),
        locale: 'en',
      });
      googleLog('official button rendered', { width: Math.max(200, Math.min(420, width || 280)) });
    } catch (error) {
      // An unauthorised JavaScript origin makes renderButton throw (or render a
      // blank frame). Surface it on the page instead of leaving an empty card.
      googleError('official button render failed', error);
      setReady(false);
      setFailed(true);
    }
  }, [ready, width]);

  const retry = useCallback(() => {
    googleLog('fallback button clicked - retrying GIS bootstrap');
    setFailed(false);
    setReady(false);
    setRetryToken((token) => token + 1);
  }, []);

  if (!clientId) return null;

  if (!ready) {
    // A blocked script still gets a recognisable button; clicking it re-tries
    // the bootstrap rather than silently doing nothing.
    return (
      <div className="w-full min-w-0">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={retry}
          className="flex h-11 w-full min-w-0 items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 text-[0.86rem] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <GoogleGlyph />
          <span className="truncate">Continue with Google</span>
        </button>
        {failed ? (
          <p role="alert" className="mt-1.5 text-center text-[0.72rem] text-amber-600">
            Google Sign-In is unavailable. Check your connection, then tap to retry — or use email and password.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex w-full min-w-0 justify-center overflow-hidden"
      aria-busy={busy}
      data-disabled={disabled ? 'true' : 'false'}
      style={disabled ? { pointerEvents: 'none', opacity: 0.6 } : undefined}
    >
      <div ref={hostRef} className="flex w-full min-w-0 justify-center" />
    </div>
  );
}
