/**
 * Server-Sent Events subscription.
 *
 * `EventSource` cannot set an Authorization header, so the stream authenticates
 * via the httpOnly cookie the server sets at login — nothing to thread through
 * here. If the cookie is missing (for example the API base is cross-origin in
 * some deployment) we fall back to `?access_token=`, which `/api/stream` also
 * accepts.
 *
 * Events are delivered to subscribers through a ref-held listener map so that a
 * changing callback never tears down the connection. Reconnects are the browser's
 * job (the server sends `retry: 3000`); we only surface the state so the UI can
 * show a "reconnecting" badge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getToken, API_ORIGIN } from './api.js';

export function useEventStream({ enabled = true, onEvent } = {}) {
  const [status, setStatus] = useState('idle'); // idle | connecting | open | error
  const listeners = useRef(new Map());
  const sourceRef = useRef(null);
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  // Stable subscribe/unsubscribe identities so effects do not thrash. `useState`
  // with a lazy initialiser is used instead of `useRef(fn).current` because the
  // latter reads `.current` during render, which the React compiler lint rejects.
  const [subscribe] = useState(
    () => (event, fn) => {
      const list = listeners.current.get(event) ?? new Set();
      list.add(fn);
      listeners.current.set(event, list);
      return () => {
        listeners.current.get(event)?.delete(fn);
      };
    },
  );

  const [unsubscribe] = useState((event, fn) => {
    listeners.current.get(event)?.delete(fn);
  });

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return undefined;
    }

    const token = getToken();
    const query = token ? `?access_token=${encodeURIComponent(token)}` : '';
    const source = new EventSource(`${API_ORIGIN}/api/stream${query}`, { withCredentials: true });
    sourceRef.current = source;
    setStatus('connecting');

    const dispatch = (event) => (raw) => {
      let payload = raw?.data;
      try {
        payload = JSON.parse(raw.data);
      } catch {
        /* keep the raw string */
      }

      // Named listeners first, then a catch-all '*' subscriber.
      for (const fn of listeners.current.get(event) ?? []) fn(payload);
      for (const fn of listeners.current.get('*') ?? []) fn({ event, payload });
      handlerRef.current?.(event, payload);
    };

    const bound = {
      connected: dispatch('connected'),
      heartbeat: dispatch('heartbeat'),
      scan: dispatch('scan'),
      activity: dispatch('activity'),
      alert: dispatch('alert'),
      occupancy: dispatch('occupancy'),
      visitor: dispatch('visitor'),
    };

    for (const [event, fn] of Object.entries(bound)) source.addEventListener(event, fn);

    source.onopen = () => setStatus('open');
    source.onerror = () => {
      // readyState CLOSED means the browser gave up; CONNECTING means it is
      // retrying on its own and we should keep showing "reconnecting".
      setStatus(source.readyState === EventSource.CLOSED ? 'error' : 'connecting');
    };

    return () => {
      for (const [event, fn] of Object.entries(bound)) source.removeEventListener(event, fn);
      source.close();
      sourceRef.current = null;
    };
  }, [enabled]);

  return { status, subscribe, unsubscribe };
}

/**
 * Rolling in-memory buffer of live events.
 *
 * Kept as a ref plus a mirrored state because SSE frames can arrive in bursts
 * (the seed replays history on reconnect); batching them into one render keeps
 * the DOM from thrashing.
 */
export function useLiveBuffer(limit = 50) {
  const [items, setItems] = useState([]);
  const pending = useRef([]);
  const scheduled = useRef(false);

  // Coalesce same-tick frames into a single state update.
  const push = useCallback(
    (item) => {
      pending.current = [item, ...pending.current].slice(0, limit);

      if (scheduled.current) return;
      scheduled.current = true;

      queueMicrotask(() => {
        scheduled.current = false;
        const batch = pending.current;
        if (!batch.length) return;
        pending.current = [];
        setItems((current) => [...batch, ...current].slice(0, limit));
      });
    },
    [limit],
  );

  const clear = useCallback(() => {
    pending.current = [];
    setItems([]);
  }, []);

  return { items, push, clear };
}