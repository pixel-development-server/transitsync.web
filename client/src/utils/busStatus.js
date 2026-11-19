/**
 * Dynamic bus status derived from Nepal Standard Time (NPT, UTC+5:45).
 *
 * A route's timetable is stored as two bare `HH:MM` strings
 * (`routes.departure_time` / `routes.arrival_time`) with no date attached: they
 * describe a *daily* service, not a pair of instants. Status therefore has to be
 * judged against the **Nepali wall clock**, never the viewer's device clock — a
 * browser in London must still read "Active" while the shuttle is mid-route in
 * Kathmandu.
 *
 * The zone is resolved through `Intl.DateTimeFormat` with an explicit
 * `Asia/Kathmandu` zone rather than by adding a hard-coded +5:45 offset, so the
 * runtime's own ICU data owns the rule (the same approach `lib/format.js`
 * already takes for presentation).
 */

import { useCallback, useEffect, useState } from 'react';

export const NPT_TIME_ZONE = 'Asia/Kathmandu';

/** How close to departure a service starts reading as "Upcoming". */
export const UPCOMING_WINDOW_MINUTES = 5;

const DAY_MINUTES = 24 * 60;

const NPT_CLOCK_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: NPT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const NPT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: NPT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The current Nepali wall clock.
 *
 * @returns {{date: string, minutes: number, hour: number, minute: number}|null}
 *   `minutes` is the minute-of-day (0–1439) in NPT; null for an invalid instant.
 */
export function nptClock(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;

  const [hour, minute] = NPT_CLOCK_FMT.format(date).split(':').map(Number);
  const isoDay = `${NPT_DAY_FMT.format(date)}T00:00:00`;
  return {
    date: Number.isNaN(Date.parse(isoDay)) ? '' : isoDay.slice(0, 10),
    minutes: hour * 60 + minute,
    hour,
    minute,
  };
}

/**
 * Parse a timetable value into a minute-of-day.
 *
 * Accepts a bare `HH:MM` (the storage format) or a full `HH:MM:SS`. Anything
 * that carries a date (an ISO timestamp) is converted through the NPT
 * zone first, because the scan rows that feed the tracking views hand back
 * instants rather than timetable strings.
 *
 * @returns {number|null} minute-of-day, or null when the value is unusable
 */
export function parseHHMM(value) {
  if (value === null || value === undefined || value === '') return null;

  const text = String(value).trim();

  // Bare timetable value: `HH:MM` or `HH:MM:SS`.
  const bare = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (bare) {
    const hours = Number(bare[1]);
    const minutes = Number(bare[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  // Anything else that parses as a date is an instant. Bare API stamps carry
  // no zone and are NPT wall time (the MySQL session runs at +05:45), so pin
  // them to +05:45; strings that already carry a zone (`Z` or an ISO offset)
  // parse as-is.
  const stamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text);
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const parsed = new Date(stamp && !zoned ? `${text.replace(' ', 'T')}+05:45` : text);
  if (Number.isNaN(parsed.getTime())) return null;
  const clock = nptClock(parsed);
  return clock ? clock.minutes : null;
}

/** The display metadata for each dynamic status. */
export const BUS_STATUS_META = {
  UPCOMING: { state: 'UPCOMING', label: 'Upcoming', tone: 'warn' },
  ACTIVE: { state: 'ACTIVE', label: 'Active', tone: 'good' },
  COMPLETED: { state: 'COMPLETED', label: 'Completed', tone: 'neutral' },
  SCHEDULED: { state: 'SCHEDULED', label: 'Scheduled', tone: 'info' },
  UNKNOWN: { state: 'UNKNOWN', label: 'No schedule', tone: 'neutral' },
};

/**
 * Classify a timetable against the Nepali clock.
 *
 *   UPCOMING   departure is within the next {@link UPCOMING_WINDOW_MINUTES} min
 *   ACTIVE     now is between departure and arrival
 *   COMPLETED  now is past arrival (today's service has finished)
 *   SCHEDULED  more than the upcoming window before departure
 *   UNKNOWN    no usable timetable on the row
 *
 * Overnight services (arrival earlier than departure, e.g. 22:00 → 01:00) are
 * handled by treating the running window as wrapping past midnight.
 *
 * @param {{departureTime?: string, arrivalTime?: string}} schedule
 * @param {Date} [at] override the clock (tests)
 */
export function evaluateBusStatus(schedule = {}, at = new Date()) {
  const clock = nptClock(at);
  const departure = parseHHMM(schedule.departureTime);
  const arrival = parseHHMM(schedule.arrivalTime);

  if (!clock || departure === null || arrival === null) {
    return { ...BUS_STATUS_META.UNKNOWN, departure, arrival, nowMinutes: clock?.minutes ?? null };
  }

  const now = clock.minutes;
  let state;

  if (departure === arrival) {
    // A zero-length service is a data error, not a running bus.
    state = now < departure ? 'SCHEDULED' : 'COMPLETED';
  } else if (departure < arrival) {
    // Same-day service.
    if (now >= arrival) state = 'COMPLETED';
    else if (now >= departure) state = 'ACTIVE';
    else if (departure - now <= UPCOMING_WINDOW_MINUTES) state = 'UPCOMING';
    else state = 'SCHEDULED';
  } else {
    // Overnight service: runs departure → 24:00, then 00:00 → arrival.
    if (now < arrival || now >= departure) {
      state = 'ACTIVE';
    } else if (departure - now <= UPCOMING_WINDOW_MINUTES) {
      // Between this morning's arrival and tonight's departure, and about to go.
      state = 'UPCOMING';
    } else {
      state = 'COMPLETED';
    }
  }

  return {
    ...BUS_STATUS_META[state],
    state,
    departure,
    arrival,
    nowMinutes: now,
    minutesUntilDeparture: (((departure - now) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES,
  };
}

/**
 * Re-render on a fixed cadence so a status badge ages on its own.
 *
 * Returns `{ now, clock, tick }`. `now` is a real `Date` refreshed every tick,
 * and `tick()` forces an immediate recomputation — wired to `visibilitychange`
 * so a tab that slept in the background snaps up to date the moment it is looked
 * at again, instead of waiting out a whole interval.
 */
export function useBusStatusClock(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());

  const tick = useCallback(() => setNow(new Date()), []);

  useEffect(() => {
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') tick();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, tick]);

  return { now, clock: nptClock(now), tick };
}

/**
 * Subscribe a component to a schedule's dynamic status.
 *
 * Dependencies are the two primitive timetable strings, not the schedule object,
 * so a caller may pass an inline `{ departureTime, arrivalTime }` literal without
 * thrashing the interval effect on every render.
 */
export function useBusStatus(schedule, intervalMs = 30_000) {
  const { now } = useBusStatusClock(intervalMs);
  const departureTime = schedule?.departureTime ?? null;
  const arrivalTime = schedule?.arrivalTime ?? null;
  return evaluateBusStatus({ departureTime, arrivalTime }, now);
}

export default { evaluateBusStatus, parseHHMM, nptClock, useBusStatusClock, useBusStatus };
