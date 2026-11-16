import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPOINTMENT_VISIBILITY,
  bookAppointment,
  readTeamWeek,
  validateAppointmentRequest,
  validateVisibility,
} from '../packages/appointments/src/appointments.js';
import { ValidationError } from '../packages/core/index.js';
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';
import { toEngineEvent } from '../packages/calendar-sync/src/google-http.js';

/**
 * Team visibility (backlog:9aa5c073), like Google Calendar:
 * «Predefinita / Pubblico / Privato». A private booking reads as
 * «Occupato» for everyone but its creator and the administrators, and is
 * exported to Google with visibility private.
 */

const NOW = '2026-11-16T09:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'book' };
const CREATOR = { type: 'user', id: 'coach-guido-subject' };
const FROM = '2026-11-19T00:00:00.000Z';
const TO = '2026-11-26T00:00:00.000Z';

const booking = (overrides = {}) => ({
  sourceKey: 'gym:visibility:1',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-11-20T17:00:00.000Z',
  endsAt: '2026-11-20T18:00:00.000Z',
  notes: 'Preferisce il silenzio',
  source: SOURCE,
  ...overrides,
});

function fakeAppointments(seed = []) {
  const rows = seed.map((row, index) => ({ id: `a-${index + 1}`, ...row }));
  return {
    rows,
    async listWhere(where) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
    async createManaged(row) {
      const stored = { id: `a-${rows.length + 1}`, ...row };
      rows.push(stored);
      return stored;
    },
  };
}

const contextFor = (service, actor = CREATOR) => ({
  modules: { get: () => ({ service }) },
  actor,
  now: () => NOW,
  consumer: 'host',
  followUps: null,
});

const weekOf = (storage, filter = {}) => readTeamWeek(
  { appointments: storage, calendarSync: null },
  { teamMemberIds: ['coach-guido'], from: FROM, to: TO, ...filter },
);

test('9aa5c073: the closed visibility set, absent reads as the team default', () => {
  assert.deepEqual([...APPOINTMENT_VISIBILITY], ['default', 'public', 'private']);
  assert.equal(validateVisibility(undefined), 'default');
  assert.equal(validateVisibility(null), 'default');
  assert.equal(validateVisibility(''), 'default');
  for (const value of ['default', 'public', 'private']) assert.equal(validateVisibility(value), value);
  assert.throws(() => validateVisibility('team-only'), /visibility must be one of/);
  assert.throws(() => validateVisibility(42), /visibility must be one of/);
});

test('9aa5c073: the form default books public-in-the-team, private books private', async () => {
  const service = fakeAppointments();
  const plain = await bookAppointment(contextFor(service), booking({ sourceKey: 'gym:visibility:plain' }));
  assert.equal(plain.appointment.visibility, 'default');
  const held = await bookAppointment(
    contextFor(service),
    booking({
      sourceKey: 'gym:visibility:held',
      visibility: 'private',
      startsAt: '2026-11-21T17:00:00.000Z',
      endsAt: '2026-11-21T18:00:00.000Z',
    }),
  );
  assert.equal(held.appointment.visibility, 'private');
  assert.throws(
    () => validateAppointmentRequest(booking({ visibility: 'nascosto' })),
    /visibility must be one of/,
  );
});

test('9aa5c073: a teammate reads a private booking as «Occupato», never the customer, the service or the notes', async () => {
  const service = fakeAppointments();
  await bookAppointment(
    contextFor(service),
    booking({ sourceKey: 'gym:visibility:masked', visibility: 'private' }),
  );
  const week = await weekOf(service, { viewer: { actorId: 'someone-else', isAdmin: false } });
  const masked = week.members[0].appointments;
  assert.equal(masked.length, 1);
  const row = masked[0];
  assert.equal(row.masked, true);
  assert.equal(row.visibility, 'private');
  assert.equal(row.startsAt, '2026-11-20T17:00:00.000Z');
  assert.equal(row.endsAt, '2026-11-20T18:00:00.000Z');
  assert.equal(row.teamMemberId, 'coach-guido');
  for (const leaked of ['subject', 'serviceKey', 'notes', 'priceCents', 'currency', 'sourceKey']) {
    assert.ok(!(leaked in row), `masked row leaks ${leaked}`);
  }
  assert.ok(!JSON.stringify(row).includes('c-presti'), 'no customer id in the masked row');
  assert.ok(!JSON.stringify(row).includes('Preferisce il silenzio'), 'no notes in the masked row');
});

test('9aa5c073: the creator and the administrators read a private booking whole', async () => {
  const service = fakeAppointments();
  await bookAppointment(
    contextFor(service),
    booking({ sourceKey: 'gym:visibility:whole', visibility: 'private' }),
  );
  const own = await weekOf(service, { viewer: { actorId: CREATOR.id, isAdmin: false } });
  assert.equal(own.members[0].appointments[0].masked, undefined);
  assert.equal(own.members[0].appointments[0].subject.id, 'c-presti');
  assert.equal(own.members[0].appointments[0].notes, 'Preferisce il silenzio');
  const admin = await weekOf(service, { viewer: { actorId: 'front-desk', isAdmin: true } });
  assert.equal(admin.members[0].appointments[0].subject.id, 'c-presti');
  const stranger = await weekOf(service);
  assert.equal(stranger.members[0].appointments[0].masked, true);
});

test('9aa5c073: a cancelled private booking frees its slot and paints nothing', async () => {
  const service = fakeAppointments([{
    id: 'a-gone',
    status: 'cancelled',
    startsAt: '2026-11-20T17:00:00.000Z',
    endsAt: '2026-11-20T18:00:00.000Z',
    teamMemberId: 'coach-guido',
    visibility: 'private',
    actorId: CREATOR.id,
    sourceKey: 'gym:visibility:gone',
    subjectResource: 'contact',
    subjectId: 'c-presti',
  }]);
  const week = await weekOf(service, { viewer: { actorId: 'someone-else', isAdmin: false } });
  assert.deepEqual(week.members[0].appointments, []);
});

test('9aa5c073: a stored row outside the closed set fails the read closed, never guessed', async () => {
  const service = fakeAppointments([{
    id: 'a-rotten',
    status: 'booked',
    startsAt: '2026-11-20T17:00:00.000Z',
    endsAt: '2026-11-20T18:00:00.000Z',
    teamMemberId: 'coach-guido',
    visibility: 'nascosto',
    actorId: CREATOR.id,
    sourceKey: 'gym:visibility:rotten',
    subjectResource: 'contact',
    subjectId: 'c-presti',
  }]);
  await assert.rejects(weekOf(service, { viewer: { actorId: 'x', isAdmin: false } }), ValidationError);
});

test('9aa5c073: the fake provider carries visibility private and refuses an unknown one', () => {
  const provider = createFakeGoogleCalendar({ nowMs: () => Date.parse(NOW) });
  const stored = provider.insertEvent({
    calendarId: 'presti-room-1',
    summary: 'Sessione',
    start: { dateTime: '2026-11-20T17:00:00.000Z' },
    end: { dateTime: '2026-11-20T18:00:00.000Z' },
    visibility: 'private',
  });
  assert.equal(stored.visibility, 'private');
  assert.throws(
    () => provider.insertEvent({
      calendarId: 'presti-room-1',
      summary: 'Sessione',
      start: { dateTime: '2026-11-20T17:00:00.000Z' },
      end: { dateTime: '2026-11-20T18:00:00.000Z' },
      visibility: 'nascosto',
    }),
    /visibility must be one of/,
  );
  assert.equal(
    toEngineEvent({ id: 'e1', visibility: 'private', start: null, end: null, status: 'confirmed', updated: NOW }).visibility,
    'private',
  );
});
