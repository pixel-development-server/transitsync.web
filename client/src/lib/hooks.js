/**
 * Data-fetching hooks.
 *
 * `useApi` is the workhorse: it aborts the in-flight request whenever the
 * dependencies change or the component unmounts, which is what stops a slow
 * first page from overwriting a fast second one when a user types in a search
 * box. Results are only committed after the component is still mounted, so a
 * resolved promise can never call `setState` on an unmounted tree.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from './api.js';

export function useApi(path, { params, enabled = true, transform } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled));
  const [refreshing, setRefreshing] = useState(false);

  // Serialising `params` keeps the effect stable: callers normally pass an
  // inline object literal, which would otherwise refetch on every render.
  const paramsKey = JSON.stringify(params ?? null);
  const mounted = useRef(true);
  const activeController = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async ({ silent } = {}) => {
      if (!enabled || !path) {
        setLoading(false);
        return null;
      }

      if (silent) setRefreshing(true);
      else setLoading(true);

      // The controller that owns *this* request, so the unmount cleanup below can
      // abort it. `apiGet` also keeps a per-key registry so a superseded request
      // for the same path+params is cancelled, but that registry is invisible to
      // this effect's cleanup.
      const controller = new AbortController();
      activeController.current = controller;

      try {
        const response = await apiGet(path, paramsKey, controller.signal);
        if (!mounted.current || activeController.current !== controller) return null;
        setData(transform ? transform(response.data) : response.data);
        setError(null);
        return response.data;
      } catch (caught) {
        if (caught?.name === 'AbortError' || !mounted.current) return null;
        if (activeController.current !== controller) return null;
        setError(caught);
        return null;
      } finally {
        if (mounted.current && activeController.current === controller) {
          setLoading(false);
          setRefreshing(false);
        }
        if (activeController.current === controller) activeController.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, paramsKey, enabled, transform],
  );

  useEffect(() => {
    run();
  }, [run]);

  useEffect(
    () => () => {
      mounted.current = false;
      activeController.current?.abort();
    },
    [],
  );

  return { data, error, loading, refreshing, reload: run, setData };
}

// ---------------------------------------------------------------------------
// Single-flight fetch helper with abort support
// ---------------------------------------------------------------------------

const inFlight = new Map();

async function apiGet(path, paramsKey, signal) {
  const params = paramsKey ? JSON.parse(paramsKey) : undefined;
  const key = `${path}|${paramsKey}`;

  // Single-flight: a newer request for the same path+params cancels the older one.
  inFlight.get(key)?.abort();
  const controller = new AbortController();
  inFlight.set(key, controller);

  // Forward the caller's abort to the internal controller.
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });

  try {
    const { api } = await import('./api.js');
    return await api.get(path, { params, signal: controller.signal });
  } finally {
    signal?.removeEventListener('abort', forward);
    if (inFlight.get(key) === controller) inFlight.delete(key);
  }
}

/**
 * Debounce a rapidly-changing value (search inputs).
 * Keeps the filters responsive without hammering the API on every keystroke.
 */
export function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/**
 * Paginated list state: page, limit, filters and a reset-on-filter-change rule.
 */
export function usePagination({ defaultLimit = 25 } = {}) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(defaultLimit);

  const goToPage = useCallback((next) => setPage(Math.max(1, Number(next) || 1)), []);
  const changeLimit = useCallback((next) => {
    setLimit(Number(next) || defaultLimit);
    setPage(1);
  }, [defaultLimit]);
  const reset = useCallback(() => setPage(1), []);

  return { page, limit, setPage, setLimit, goToPage, changeLimit, reset };
}

/** Human-readable message for anything thrown by the API layer. */
export function errorMessage(error, fallback = 'Something went wrong.') {
  if (!error) return fallback;
  if (error instanceof ApiError) return error.message;
  if (error?.message) return error.message;
  return fallback;
}

/** Copy text to the clipboard, falling back to a hidden textarea. */
export async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }

  try {
    const field = document.createElement('textarea');
    field.value = value;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}