// @ts-check

/**
 * Calendar attendees from the real provider (backlog:1f15c248fc05).
 *
 * `toEngineEvent` used to drop `attendees` and `organizer`, so in
 * production every event skipped with "no customer mapping" and Presti's
 * calendar imported nothing. The engine event now carries them — email,
 * displayName and responseStatus only, each bounded — proven here against
 * a real `events.list` wire shape, and through `listEvents` over a
 * scripted HTTP double. No test dials Google. Google's `self` flag rides
 * along when true (backlog:13c09f03), so the lead resolver can tell the
 * calendar owner apart from a real guest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpGoogleCalendar,
  toEngineEvent,
} from '../packages/calendar-sync/src/google-http.js';

/** One real-shaped `events.list` page: a lesson with two attendees, a personal event, a tombstone. */
function realListPage() {
  return {
    kind: 'calendar#events',
    etag: '"p33p33"',
    summary: 'coach@example.com',
    updated: '2026-11-04T10:00:00.000Z',
    timeZone: 'Europe/Rome',
    accessRole: 'owner',
    nextSyncToken: 'sync-1700000000000',
    items: [
      {
        kind: 'calendar#event',
        etag: '"evt-etag-1"',
        id: 'evt-lezione-1',
        status: 'confirmed',
        htmlLink: 'https://www.google.com/calendar/event?eid=abc123',
        created: '2026-11-01T09:00:00.000Z',
        updated: '2026-11-04T10:00:00.000Z',
        summary: 'Lezione PT',
        description: 'Scheda forza',
        creator: { email: 'coach@example.com', displayName: 'Guido' },
        organizer: { email: 'coach@example.com', displayName: 'Guido', self: true },
        start: { dateTime: '2026-11-06T10:00:00+01:00', timeZone: 'Europe/Rome' },
        end: { dateTime: '2026-11-06T11:00:00+01:00', timeZone: 'Europe/Rome' },
        attendees: [
          {
            email: 'cliente@example.com', displayName: 'Mario Rossi',
            responseStatus: 'accepted',
          },
          {
            email: 'coach@example.com', displayName: 'Guido',
            organizer: true, self: true, resource: false,
            responseStatus: 'accepted',
          },
        ],
        extendedProperties: { private: { accordoSourceKey: 'gcal:primary:evt-lezione-1' }, shared: { room: 'sala-1' } },
        reminders: { useDefault: true },
        eventType: 'default',
      },
      {
        kind: 'calendar#event',
        etag: '"evt-etag-2"',
        id: 'evt-personale-1',
        status: 'confirmed',
        updated: '2026-11-04T09:00:00.000Z',
        summary: 'Dentista',
        start: { dateTime: '2026-11-07T10:00:00+01:00', timeZone: 'Europe/Rome' },
        end: { dateTime: '2026-11-07T11:00:00+01:00', timeZone: 'Europe/Rome' },
      },
      { id: 'evt-cancellato-1', status: 'cancelled', updated: '2026-11-04T08:00:00.000Z' },
    ],
  };
}

test('toEngineEvent keeps attendees and organizer from a real events.list payload', () => {
  const [lesson, personal, tombstone] = realListPage().items.map(toEngineEvent);

  assert.deepEqual(lesson.attendees, [
    { email: 'cliente@example.com', displayName: 'Mario Rossi', responseStatus: 'accepted' },
    { email: 'coach@example.com', displayName: 'Guido', responseStatus: 'accepted', self: true },
  ]);
  assert.deepEqual(lesson.organizer, { email: 'coach@example.com', displayName: 'Guido', self: true });
  for (const person of [...lesson.attendees, lesson.organizer]) {
    assert.ok(Object.isFrozen(person), 'attendee entries are frozen');
    for (const key of Object.keys(person)) {
      assert.ok(['email', 'displayName', 'responseStatus', 'self', 'resource'].includes(key), `only matching keys travel (got ${key})`);
    }
  }
  const room = toEngineEvent({
    id: 'evt-sala-1', status: 'confirmed', updated: '2026-11-04T10:00:00.000Z',
    start: { dateTime: '2026-11-06T10:00:00+01:00' }, end: { dateTime: '2026-11-06T11:00:00+01:00' },
    attendees: [{ email: 'sala@example.com', displayName: 'Sala Rossa', resource: true }],
  });
  assert.deepEqual(room.attendees, [{ email: 'sala@example.com', displayName: 'Sala Rossa', resource: true }],
    'a room carries its resource flag so the resolver can skip it');
  assert.ok(Object.isFrozen(lesson.attendees), 'the attendees list is frozen');
  assert.equal(lesson.extendedProperties.accordoSourceKey, 'gcal:primary:evt-lezione-1');

  assert.deepEqual(personal.attendees, []);
  assert.equal(personal.organizer, null);

  assert.equal(tombstone.status, 'cancelled');
  assert.deepEqual(tombstone.attendees, []);
  assert.equal(tombstone.organizer, null);
});

test('listEvents carries attendees from the wire to the engine', async () => {
  const page = realListPage();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => page });
  const provider = createHttpGoogleCalendar({ fetchImpl });
  const listed = await provider.listEvents({ calendarId: 'primary', timeMin: '2026-11-01T00:00:00.000Z', secret: 's' });

  assert.equal(listed.nextSyncToken, 'sync-1700000000000');
  const [lesson, personal] = listed.items;
  assert.deepEqual(lesson.attendees.map((attendee) => attendee.email),
    ['cliente@example.com', 'coach@example.com']);
  assert.deepEqual(personal.attendees, []);
});

test('unusable attendee entries are dropped and the list stays bounded', () => {
  const many = Array.from({ length: 205 }, (_, index) => ({ email: `extra${index}@example.com`, responseStatus: 'accepted' }));
  const crowded = toEngineEvent({
    id: 'evt-affollato-1', status: 'confirmed', updated: '2026-11-04T10:00:00.000Z',
    start: { dateTime: '2026-11-06T10:00:00+01:00' }, end: { dateTime: '2026-11-06T11:00:00+01:00' },
    attendees: [{ email: 'cliente@example.com', displayName: 'Mario Rossi', responseStatus: 'accepted' }, ...many],
  });
  assert.equal(crowded.attendees.length, 200);
  assert.equal(crowded.attendees[0].email, 'cliente@example.com');

  const cleaned = toEngineEvent({
    id: 'evt-sporco-1', status: 'confirmed', updated: '2026-11-04T10:00:00.000Z',
    start: { dateTime: '2026-11-06T10:00:00+01:00' }, end: { dateTime: '2026-11-06T11:00:00+01:00' },
    attendees: ['cliente@example.com', null, 42, {}, { email: '' }, { email: `${'a'.repeat(321)}@x.com` },
      { email: 'forse@example.com', responseStatus: 'maybe' }, { email: 'ok@example.com', displayName: 'Ok' }],
  });
  assert.deepEqual(cleaned.attendees, [{ email: 'forse@example.com' }, { email: 'ok@example.com', displayName: 'Ok' }]);
});
