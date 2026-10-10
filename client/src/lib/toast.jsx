import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

const TONE_STYLES = {
  success: 'border-emerald-500/45 text-emerald-400',
  error: 'border-red-500/45 text-red-400',
  warning: 'border-amber-500/45 text-amber-400',
  info: 'border-sky-500/45 text-sky-400',
};

const TONE_ICONS = {
  success: 'M20 6 9 17l-5-5',
  error: 'M12 8v5m0 3h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  warning: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 16v-5m0-4h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (message, tone = 'info', { duration = 4500, title } = {}) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current.slice(-4), { id, message, tone, title }]);

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const store = timers.current;
    return () => {
      for (const timer of store.values()) clearTimeout(timer);
      store.clear();
    };
  }, []);

  const value = useMemo(
    () => ({
      notify,
      success: (message, options) => notify(message, 'success', options),
      error: (message, options) => notify(message, 'error', { duration: 7000, ...options }),
      warning: (message, options) => notify(message, 'warning', options),
      info: (message, options) => notify(message, 'info', options),
      dismiss,
    }),
    [notify, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
            style={{ background: 'var(--glass-fill-strong)' }}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 shadow-2xl backdrop-blur-md ${TONE_STYLES[toast.tone] ?? TONE_STYLES.info}`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-px h-4 w-4 shrink-0"
              aria-hidden="true"
            >
              <path d={TONE_ICONS[toast.tone] ?? TONE_ICONS.info} />
            </svg>
            <div className="min-w-0 flex-1">
              {toast.title ? <p className="text-[0.8rem] font-bold">{toast.title}</p> : null}
              <p className="text-[0.82rem] leading-snug break-words">{toast.message}</p>
            </div>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="shrink-0 opacity-60 transition hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');
  return context;
}