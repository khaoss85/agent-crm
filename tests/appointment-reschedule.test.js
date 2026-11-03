import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAppointmentBookCapability,
  rescheduleAppointment,
} from '../packages/appointments/src/appointments.js';
import { AppError, NotFoundError, ValidationError } from '../packages/core/index.js';

/**
 * Appointment reschedule (backlog:bdca2010d471): the governed write behind
 * dragging a calendar event to another day or hour, or stretching its
 * bottom edge. Every claim here is about the move itself — validation, the
 * Italian conflict refusal, terminal immunity, the no-op drop — so fakes
 * prove it fast; the Google reflection rides the calendar-sync suite, where
 * the fake provider lives.
 */

const ACTOR = { type: 'user', id: 'operator' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };

const row = (overrides = {}) => ({
  id: 'a-1',
  sourceKey: 'gym:move:1',
  subjectResource: SUBJECT.resource,
  subjectId: SUBJECT.id,
  subjectOwner: SUBJECT.owner,
  subjectOwnerPackage: null,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-20T18:00:00.000Z',
  notes: null,
  status: 'booked',
  ...overrides,
});

function fakeAppointments(seed = []) {
  const rows = seed.map((entry, index) => ({ id: `a-${index + 1}`, ...entry }));
  const writes = [];
  return {
    rows,
    writes,
    async listWhere(where) {
      return rows.filter((candidate) => Object.entries(where).every(([key, value]) => candidate[key] === value));
    },
    async createManaged(entry) {
      const stored = { id: `a-${rows.length + 1}`, ...entry };
      rows.push(stored);
      return stored;
    },
    async applyManaged(id, patch) {
      const found = rows.find((candidate) => candidate.id === id);
      if (!found) throw new NotFoundError(`appointment ${id} not found`);
      writes.push({ id, patch: { ...patch } });
      Object.assign(found, patch);
      return found;
    },
    async get(id) {
      const found = rows.find((candidate) => candidate.id === id);
      if (!found) throw new NotFoundError(`appointment ${id} not found`);
      return found;
    },
  };
}

const modulesFor = (service) => ({
  get: (name) => {
    if (name === 'appointment') return { service };
    throw new NotFoundError(`module ${name} not found`);
  },
});

const contextFor = (service, overrides = {}) => ({
  modules: modulesFor(service),
  actor: ACTOR,
  now: () => '2026-10-19T09:00:00.000Z',
  consumer: 'host',
  ...overrides,
});

const move = (overrides = {}) => ({
  id: 'a-1',
  startsAt: '2026-10-21T17:00:00.000Z',
  endsAt: '2026-10-21T18:00:00.000Z',
  ...overrides,
});

test('a move by id rewrites the slot and keeps the lifecycle state', async () => {
  const service = fakeAppointments([row()]);
  const out = await rescheduleAppointment(contextFor(service), move());
  assert.equal(out.moved, true);
  assert.equal(out.appointment.startsAt, '2026-10-21T17:00:00.000Z');
  assert.equal(out.appointment.endsAt, '2026-10-21T18:00:00.000Z');
  assert.equal(out.appointment.status, 'booked');
  assert.equal(out.push, null);
  assert.equal(out.pushError, null);
  assert.equal(service.writes.length, 1);
});

test('a move by sourceKey names the same row', async () => {
  const service = fakeAppointments([row()]);
  const out = await rescheduleAppointment(
    contextFor(service),
    { sourceKey: 'gym:move:1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:30:00.000Z' },
  );
  assert.equal(out.moved, true);
  assert.equal(out.appointment.endsAt, '2026-10-21T18:30:00.000Z');
});

test('a move onto a held slot refuses 409 with an Italian message', async () => {
  const service = fakeAppointments([
    row(),
    row({
      id: 'a-2', sourceKey: 'gym:move:2', startsAt: '2026-10-21T17:30:00.000Z', endsAt: '2026-10-21T18:30:00.000Z',
    }),
  ]);
  await assert.rejects(
    rescheduleAppointment(contextFor(service), move()),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
      assert.equal(error.status, 409);
      assert.match(error.message, /ha già un altro appuntamento/);
      assert.match(error.message, /fascia libera/);
      assert.equal(error.details.conflictingId, 'a-2');
      return true;
    },
  );
  assert.equal(service.writes.length, 0, 'a refused move writes nothing');
});

test('a stretch over the row\u2019s own old slot is a longer booking, not a conflict', async () => {
  const service = fakeAppointments([row()]);
  const out = await rescheduleAppointment(
    contextFor(service),
    { id: 'a-1', startsAt: '2026-10-20T17:00:00.000Z', endsAt: '2026-10-20T19:00:00.000Z' },
  );
  assert.equal(out.moved, true);
  assert.equal(out.appointment.endsAt, '2026-10-20T19:00:00.000Z');
});

test('a terminal booking never moves', async () => {
  const service = fakeAppointments([row({ status: 'cancelled' })]);
  await assert.rejects(
    rescheduleAppointment(contextFor(service), move()),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'APPOINTMENTS_INVALID_STATE');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(service.writes.length, 0);
});

test('a missing row is a typed miss, never a quiet move', async () => {
  const service = fakeAppointments([]);
  await assert.rejects(
    rescheduleAppointment(contextFor(service), move()),
    (error) => {
      assert.ok(error instanceof NotFoundError);
      return true;
    },
  );
  await assert.rejects(
    rescheduleAppointment(contextFor(service), { ...move(), id: undefined, sourceKey: 'gym:nope' }),
    (error) => {
      assert.ok(error instanceof NotFoundError);
      return true;
    },
  );
});

test('an anonymous move is refused: the session behind the drag is required', async () => {
  const service = fakeAppointments([row()]);
  await assert.rejects(
    rescheduleAppointment(contextFor(service, { actor: null }), move()),
    (error) => error instanceof AppError,
  );
  assert.equal(service.writes.length, 0);
});

test('a drop without a move answers the stored row with moved:false', async () => {
  const service = fakeAppointments([row()]);
  const out = await rescheduleAppointment(
    contextFor(service),
    { id: 'a-1', startsAt: '2026-10-20T17:00:00.000Z', endsAt: '2026-10-20T18:00:00.000Z' },
  );
  assert.equal(out.moved, false);
  assert.equal(out.appointment.startsAt, '2026-10-20T17:00:00.000Z');
  assert.equal(service.writes.length, 0, 'a no-op drop writes nothing');
});

test('the row is named by exactly one of id or sourceKey', async () => {
  const service = fakeAppointments([row()]);
  await assert.rejects(
    rescheduleAppointment(contextFor(service), { startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z' }),
    (error) => error instanceof ValidationError,
  );
  await assert.rejects(
    rescheduleAppointment(contextFor(service), { ...move(), sourceKey: 'gym:move:1' }),
    (error) => error instanceof ValidationError,
  );
});

test('a slot with no duration or past a day is refused like a booking', async () => {
  const service = fakeAppointments([row()]);
  await assert.rejects(
    rescheduleAppointment(contextFor(service), { ...move(), endsAt: '2026-10-21T17:00:00.000Z' }),
    (error) => error instanceof ValidationError,
  );
  await assert.rejects(
    rescheduleAppointment(
      contextFor(service),
      { ...move(), startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-22T17:00:01.000Z' },
    ),
    (error) => error instanceof ValidationError,
  );
  assert.equal(service.writes.length, 0);
});

test('a named calendar without a push handle fails before any write', async () => {
  const service = fakeAppointments([row()]);
  await assert.rejects(
    rescheduleAppointment(contextFor(service), { ...move(), calendar: { calendarId: 'room-1' } }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'APPOINTMENTS_CALENDAR_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(service.writes.length, 0);
});

test('a runtime push failure rides as data: the move stands, the code travels', async () => {
  const service = fakeAppointments([row()]);
  const calendarSync = {
    async pushAppointment() {
      const error = new Error('grant gone');
      error.code = 'GOOGLE_GRANT_REFUSED';
      error.status = 401;
      throw error;
    },
  };
  const out = await rescheduleAppointment(
    contextFor(service, { calendarSync }),
    { ...move(), calendar: { calendarId: 'room-1' } },
  );
  assert.equal(out.moved, true);
  assert.equal(out.appointment.startsAt, '2026-10-21T17:00:00.000Z');
  assert.equal(out.push, null);
  assert.deepEqual(out.pushError, { code: 'GOOGLE_GRANT_REFUSED' });
});

test('appointment-book@1 opens rescheduleAppointment beside book and advance', async () => {
  const service = fakeAppointments([row()]);
  const handle = createAppointmentBookCapability({}).create({
    modules: modulesFor(service), actor: ACTOR, consumer: 'host',
  });
  assert.equal(typeof handle.rescheduleAppointment, 'function');
  const out = await handle.rescheduleAppointment(move());
  assert.equal(out.moved, true);
  assert.equal(out.appointment.endsAt, '2026-10-21T18:00:00.000Z');
});
