/**
 * Time-based route/bus operational status.
 *
 * A route's timetable is a pair of bare `HH:MM` strings describing a *daily*
 * service, so "is it running?" must be judged against the Nepal wall clock
 * (UTC+5:45) — never the viewer's device time. These cases pin the rule that a
 * route is only `live` strictly inside its departure→arrival window; at 13:22
 * NPT a 06:45–07:50 shuttle reads `completed`, never "Live".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isInScheduleWindow,
  parseMinutesSinceMidnight,
  scheduleLabel,
  scheduleState,
} from '../src/lib/schedule.js';

const at = (h, m) => h * 60 + m;

test('parseMinutesSinceMidnight reads HH:MM and HH:MM:SS, rejects junk', () => {
  assert.equal(parseMinutesSinceMidnight('06:45'), at(6, 45));
  assert.equal(parseMinutesSinceMidnight('7:05:00'), at(7, 5));
  assert.equal(parseMinutesSinceMidnight(''), null);
  assert.equal(parseMinutesSinceMidnight('25:00'), null);
  assert.equal(parseMinutesSinceMidnight('06:99'), null);
  assert.equal(parseMinutesSinceMidnight(null), null);
});

test('a morning window is live only inside it, never at midday', () => {
  const window = { start: '06:45', end: '07:50' };

  assert.equal(scheduleState({ ...window, now: at(6, 44) }), 'offline');
  assert.equal(scheduleState({ ...window, now: at(6, 45) }), 'live');
  assert.equal(scheduleState({ ...window, now: at(7, 10) }), 'live');
  assert.equal(scheduleState({ ...window, now: at(7, 49) }), 'live');
  // Arrival is exclusive: the instant the trip ends it is no longer live.
  assert.equal(scheduleState({ ...window, now: at(7, 50) }), 'completed');
  assert.equal(scheduleState({ ...window, now: at(7, 51) }), 'completed');
  // The reported bug: 1:22 PM / 3:07 PM must not read "Live".
  assert.equal(scheduleState({ ...window, now: at(13, 22) }), 'completed');
  assert.equal(scheduleState({ ...window, now: at(15, 7) }), 'completed');
});

test('only `live` ever labels as "Live"', () => {
  const window = { start: '06:45', end: '07:50' };
  for (let now = 0; now < 24 * 60; now += 5) {
    const state = scheduleState({ ...window, now });
    assert.equal(state === 'live', isInScheduleWindow({ ...window, now }));
    if (state !== 'live') {
      assert.notEqual(scheduleLabel(state), 'Live');
    }
  }
});

test('an overnight window stays live on both legs of the clock', () => {
  const window = { start: '22:00', end: '02:00' };
  assert.equal(scheduleState({ ...window, now: at(22, 30) }), 'live');
  assert.equal(scheduleState({ ...window, now: at(1, 0) }), 'live');
  assert.equal(scheduleState({ ...window, now: at(12, 0) }), 'completed');
  assert.equal(scheduleState({ ...window, now: at(21, 0) }), 'offline');
});

test('a route with no usable timetable is offline, never live', () => {
  assert.equal(scheduleState({ start: null, end: null, now: at(13, 0) }), 'offline');
  assert.equal(scheduleState({ start: '06:45', end: '', now: at(6, 50) }), 'offline');
  assert.equal(scheduleLabel(scheduleState({ start: null, end: null, now: 0 })), 'Offline');
});
