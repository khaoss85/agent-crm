import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelAppointment,
  createAppointmentBookCapability,
  rescheduleAppointment,
} from '../packages/appointments/src/appointments.js';
import { AppError, NotFoundError, ValidationError } from '../packages/core/index.js';

/**
 * Appointment cancellation (backlog:5346ab531538): the governed write behind
 * «Annulla appuntamento» in the calendar popover. Every claim here is about
 * the cancellation itself — the reason, terminal immunity, idempotency, the
 * race with a move, the calendar push as data — so fakes prove it fast; the
 * composed application (operation, audit, history read) rides
 * tests/appointments-e2e.test.js.
 */

const ACTOR = { type: 'user', id: 'operator' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };

const row = (overrides = {}) => ({
  id: 'a-1',
  sourceKey: 'gym:cancel:1',
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
  cancelReason: null,
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
    async createManaged() {
      throw new Error('a cancellation never creates a row');
    },
    async applyManaged(id, patch, options) {
      const found = rows.find((candidate) => candidate.id === id);
      if (!found) throw new NotFoundError(`appointment ${id} not found`);
      writes.push({ id, patch: { ...patch }, actor: options?.actor ?? null });
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

test('a cancel by id advances to cancelled with the reason and the actor', async () => {
  const service = fakeAppointments([row()]);
  const out = await cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Il cliente ha disdetto' });
  assert.equal(out.cancelled, true);
  assert.equal(out.appointment.status, 'cancelled');
  assert.equal(out.appointment.cancelReason, 'Il cliente ha disdetto');
  assert.equal(out.push, null);
  assert.equal(out.pushError, null);
  assert.equal(service.writes.length, 1);
  assert.deepEqual(service.writes[0].actor, ACTOR, 'the write names its author');
  assert.equal(service.rows[0].startsAt, '2026-10-20T17:00:00.000Z', 'the row stays stored with its slot');
});

test('a cancel by sourceKey names the same row; a confirmed booking cancels too', async () => {
  const service = fakeAppointments([row({ status: 'confirmed' })]);
  const out = await cancelAppointment(contextFor(service), { sourceKey: 'gym:cancel:1', reason: 'Malattia' });
  assert.equal(out.appointment.id, 'a-1');
  assert.equal(out.appointment.status, 'cancelled');
});

test('a second cancel replays the row and writes nothing', async () => {
  const service = fakeAppointments([row()]);
  await cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Disdetto' });
  const again = await cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Doppio clic' });
  assert.equal(again.cancelled, false, 'the replay says nothing new happened');
  assert.equal(again.appointment.status, 'cancelled');
  assert.equal(again.appointment.cancelReason, 'Disdetto', 'the first reason stands');
  assert.equal(service.writes.length, 1, 'one write only');
});

test('two cancels racing one booking both answer the cancelled row, one write', async () => {
  const service = fakeAppointments([row()]);
  const [first, second] = await Promise.all([
    cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Primo' }),
    cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Secondo' }),
  ]);
  assert.equal(first.appointment.status, 'cancelled');
  assert.equal(second.appointment.status, 'cancelled');
  assert.equal([first, second].filter((out) => out.cancelled).length, 1, 'one of the two cancelled');
  assert.equal(service.writes.length, 1, 'the loser re-reads the winner and writes nothing');
});

test('a happened visit is never rewritten: done and no-show refuse 409', async () => {
  for (const status of ['done', 'no-show']) {
    const service = fakeAppointments([row({ status })]);
    await assert.rejects(
      cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Tardi' }),
      (error) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'APPOINTMENTS_INVALID_STATE');
        assert.equal(error.status, 409);
        return true;
      },
    );
    assert.equal(service.writes.length, 0, `${status}: nothing written`);
  }
});

test('a cancel racing a move on the same row serializes: the terminal row never moves', async () => {
  const service = fakeAppointments([row()]);
  const cancelling = cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Disdetto' });
  const moving = rescheduleAppointment(contextFor(service), {
    id: 'a-1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z',
  });
  const [cancelledOut, movedOut] = await Promise.allSettled([cancelling, moving]);
  const final = service.rows[0];
  if (final.status === 'cancelled' && cancelledOut.status === 'fulfilled' && movedOut.status === 'rejected') {
    assert.equal(final.startsAt, '2026-10-20T17:00:00.000Z', 'the cancel won: the row keeps its slot');
  } else {
    // The move won the race: the cancellation then cancels the moved row.
    assert.equal(cancelledOut.status, 'fulfilled');
    assert.equal(final.status, 'cancelled');
  }
});

test('the reason is required and bounded; the row is named by exactly one of id or sourceKey', async () => {
  const service = fakeAppointments([row()]);
  for (const reason of [undefined, '', '   ', 'x'.repeat(301), 'a\nb']) {
    await assert.rejects(
      cancelAppointment(contextFor(service), { id: 'a-1', reason }),
      (error) => error instanceof ValidationError && error.details?.field === 'reason',
    );
  }
  await assert.rejects(
    cancelAppointment(contextFor(service), { reason: 'Disdetto' }),
    (error) => error instanceof ValidationError,
  );
  await assert.rejects(
    cancelAppointment(contextFor(service), { id: 'a-1', sourceKey: 'gym:cancel:1', reason: 'Disdetto' }),
    (error) => error instanceof ValidationError,
  );
  assert.equal(service.writes.length, 0);
});

test('a missing row is a typed miss, and an anonymous cancel is refused', async () => {
  const service = fakeAppointments([row()]);
  await assert.rejects(
    cancelAppointment(contextFor(service), { id: 'a-9', reason: 'Disdetto' }),
    (error) => error instanceof NotFoundError,
  );
  await assert.rejects(
    cancelAppointment(contextFor(service, { actor: undefined }), { id: 'a-1', reason: 'Disdetto' }),
  );
  assert.equal(service.writes.length, 0);
});

test('a named calendar converges the Google event after the commit; a push failure rides as data', async () => {
  const service = fakeAppointments([row()]);
  const pushes = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey, options) {
      pushes.push({ calendarId, sourceKey, options });
      return { status: 'pushed', sourceKey, change: 'cancelled' };
    },
  };
  const out = await cancelAppointment(contextFor(service, { calendarSync }), {
    id: 'a-1', reason: 'Disdetto', spaceId: 'spazio-1', calendar: { calendarId: 'primary' },
  });
  assert.equal(out.appointment.status, 'cancelled');
  assert.deepEqual(out.push, { status: 'pushed', sourceKey: 'gym:cancel:1', change: 'cancelled' });
  assert.equal(pushes[0].options.spaceId, 'spazio-1');

  const failing = fakeAppointments([row()]);
  const broken = { async pushAppointment() { throw Object.assign(new Error('provider said REF-1'), { code: 'CALENDAR_GRANT_REVOKED' }); } };
  const out2 = await cancelAppointment(contextFor(failing, { calendarSync: broken }), {
    id: 'a-1', reason: 'Disdetto', spaceId: 'spazio-1', calendar: { calendarId: 'primary' },
  });
  assert.equal(out2.appointment.status, 'cancelled', 'the cancellation stands');
  assert.deepEqual(out2.pushError, { code: 'CALENDAR_GRANT_REVOKED' }, 'only the code travels');
});

test('a named calendar without a push handle or a spaceId fails before any write', async () => {
  const service = fakeAppointments([row()]);
  await assert.rejects(
    cancelAppointment(contextFor(service), { id: 'a-1', reason: 'Disdetto', spaceId: 's', calendar: { calendarId: 'primary' } }),
    (error) => error.code === 'APPOINTMENTS_CALENDAR_UNAVAILABLE',
  );
  await assert.rejects(
    cancelAppointment(contextFor(service, { calendarSync: { pushAppointment: async () => null } }), {
      id: 'a-1', reason: 'Disdetto', calendar: { calendarId: 'primary' },
    }),
    (error) => error instanceof ValidationError && error.details?.field === 'spaceId',
  );
  assert.equal(service.writes.length, 0);
});

test('appointment-book@1 opens cancelAppointment beside reschedule and advance', async () => {
  const service = fakeAppointments([row()]);
  const handle = createAppointmentBookCapability({}).create({
    modules: modulesFor(service), actor: ACTOR, consumer: 'host',
  });
  assert.equal(typeof handle.cancelAppointment, 'function');
  const out = await handle.cancelAppointment({ id: 'a-1', reason: 'Disdetto' });
  assert.equal(out.appointment.status, 'cancelled');
});
