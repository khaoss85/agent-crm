import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelAppointment,
  readSchedule,
  rescheduleAppointment,
} from '../packages/appointments/src/appointments.js';
import { NotFoundError } from '../packages/core/index.js';

const SUBJECT = { resource: 'contact', id: 'contact-private', owner: 'host' };
const OWNER = { type: 'user', id: 'appointment-owner' };
const STRANGER = { type: 'user', id: 'team-mate' };
const PRIVATE_ID = 'private-appointment-1';
const PRIVATE_KEY = 'calendar:coach-1:2026-11-20T17:00:00Z:contact-private';

function privateRow() {
  return {
    id: PRIVATE_ID,
    sourceKey: PRIVATE_KEY,
    subjectResource: SUBJECT.resource,
    subjectId: SUBJECT.id,
    actorId: OWNER.id,
    visibility: 'private',
    status: 'booked',
    startsAt: '2026-11-20T17:00:00.000Z',
    endsAt: '2026-11-20T18:00:00.000Z',
    teamMemberId: 'coach-1',
    serviceKey: 'massage',
    priceCents: 5000,
    currency: 'EUR',
  };
}

function appointmentStore(rows) {
  let writes = 0;
  return {
    rows,
    get writes() { return writes; },
    async createManaged() { throw new Error('these tests never create appointments'); },
    async get(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new NotFoundError(`no appointment with id "${id}"`);
      return row;
    },
    async listWhere(where) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
    async applyManaged(id, patch) {
      writes += 1;
      const row = rows.find((candidate) => candidate.id === id);
      Object.assign(row, patch);
      return row;
    },
  };
}

function contextFor(store) {
  return {
    modules: { get: () => ({ service: store }) },
    actor: STRANGER,
    now: () => '2026-11-19T12:00:00.000Z',
    consumer: 'test',
    followUps: null,
  };
}

async function publicError(operation, store, request) {
  try {
    await operation(contextFor(store), {
      ...request,
      viewer: { actorId: STRANGER.id, isAdmin: false },
    });
  } catch (error) {
    return { code: error.code, status: error.status, message: error.message, details: error.details };
  }
  assert.fail('expected the row to be missing or hidden');
}

test('private appointment mutations have the same not-found response as a missing id/sourceKey', async () => {
  const cases = [
    {
      label: 'reschedule by id', operation: rescheduleAppointment,
      request: { id: PRIVATE_ID, startsAt: '2026-11-20T19:00:00.000Z', endsAt: '2026-11-20T20:00:00.000Z' },
    },
    {
      label: 'reschedule by sourceKey', operation: rescheduleAppointment,
      request: { sourceKey: PRIVATE_KEY, startsAt: '2026-11-20T19:00:00.000Z', endsAt: '2026-11-20T20:00:00.000Z' },
    },
    { label: 'cancel by id', operation: cancelAppointment, request: { id: PRIVATE_ID, reason: 'test' } },
    { label: 'cancel by sourceKey', operation: cancelAppointment, request: { sourceKey: PRIVATE_KEY, reason: 'test' } },
  ];

  for (const scenario of cases) {
    const hidden = appointmentStore([privateRow()]);
    const missing = appointmentStore([]);
    const hiddenError = await publicError(scenario.operation, hidden, scenario.request);
    const missingError = await publicError(scenario.operation, missing, scenario.request);
    assert.deepEqual(hiddenError, missingError, scenario.label);
    assert.equal(hiddenError.status, 404, `${scenario.label}: ${JSON.stringify(hiddenError)}`);
    assert.equal(hidden.writes, 0, `${scenario.label} did not write the hidden booking`);
  }
});

test('customer schedule omits private rows for teammates but preserves owner and admin visibility', async () => {
  const store = appointmentStore([
    privateRow(),
    {
      id: 'public-appointment-1', sourceKey: 'public:1', subjectResource: SUBJECT.resource,
      subjectId: SUBJECT.id, actorId: OWNER.id, visibility: 'public', status: 'booked',
      startsAt: '2026-11-20T19:00:00.000Z', endsAt: '2026-11-20T20:00:00.000Z',
      teamMemberId: 'coach-1', serviceKey: 'consultation', priceCents: 0, currency: 'EUR',
    },
  ]);

  const stranger = await readSchedule(
    { appointments: store }, SUBJECT, { actorId: STRANGER.id, isAdmin: false },
  );
  assert.deepEqual(stranger.map((row) => row.id), ['public-appointment-1']);

  const owner = await readSchedule(
    { appointments: store }, SUBJECT, { actorId: OWNER.id, isAdmin: false },
  );
  assert.deepEqual(owner.map((row) => row.id), [PRIVATE_ID, 'public-appointment-1']);

  const admin = await readSchedule(
    { appointments: store }, SUBJECT, { actorId: 'front-desk', isAdmin: true },
  );
  assert.deepEqual(admin.map((row) => row.id), [PRIVATE_ID, 'public-appointment-1']);
});
