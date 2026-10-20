import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppointmentScheduleCapability, readTeamWeek } from '../packages/appointments/src/appointments.js';
import { ValidationError } from '../packages/core/index.js';

/**
 * Team week (BO-F3-01, "07 Calendario", backlog:3ec06fdee0e2): every
 * appointment overlapping a window for each named team member, grouped per
 * person. No database: every claim here is about the filter shape (the
 * person filter, the window edges, the validation), so a database would
 * prove nothing and only slow the answer. Storage is the same exact-match
 * `listWhere` seam the booking path overlap-checks against.
 */

const FROM = '2026-10-19T00:00:00.000Z';
const TO = '2026-10-26T00:00:00.000Z';

const row = (overrides = {}) => ({
  id: 'a-1',
  status: 'booked',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-20T18:00:00.000Z',
  serviceKey: 'pt-single',
  teamMemberId: 'coach-guido',
  priceCents: 4000,
  currency: 'EUR',
  notes: null,
  sourceKey: 'gym:booking:1',
  subjectResource: 'contact',
  subjectId: 'c-presti',
  subjectOwner: 'host',
  subjectOwnerPackage: null,
  sourcePackage: 'host',
  ...overrides,
});

function fakeAppointments(seed = []) {
  const rows = [...seed];
  return {
    rows,
    async listWhere(where) {
      return rows.filter((candidate) => Object.entries(where).every(([key, value]) => candidate[key] === value));
    },
  };
}

const weekOf = (storage, filter = {}) => readTeamWeek(
  { appointments: storage },
  { teamMemberIds: ['coach-guido', 'coach-maria'], from: FROM, to: TO, ...filter },
);

test('groups overlapping bookings per person, soonest slot first', async () => {
  const storage = fakeAppointments([
    row({ id: 'a-2', teamMemberId: 'coach-maria', startsAt: '2026-10-21T09:00:00.000Z', endsAt: '2026-10-21T10:00:00.000Z', sourceKey: 'gym:booking:2' }),
    row({ id: 'a-1', startsAt: '2026-10-20T17:00:00.000Z', endsAt: '2026-10-20T18:00:00.000Z' }),
    row({ id: 'a-3', startsAt: '2026-10-20T10:00:00.000Z', endsAt: '2026-10-20T11:00:00.000Z', sourceKey: 'gym:booking:3' }),
    row({ id: 'a-far', startsAt: '2026-11-02T10:00:00.000Z', endsAt: '2026-11-02T11:00:00.000Z', sourceKey: 'gym:booking:far' }),
  ]);
  const week = await weekOf(storage);
  assert.equal(week.from, FROM);
  assert.equal(week.to, TO);
  assert.deepEqual(week.members.map((group) => group.teamMemberId), ['coach-guido', 'coach-maria']);
  assert.deepEqual(week.members[0].appointments.map((booking) => booking.id), ['a-3', 'a-1']);
  assert.deepEqual(week.members[1].appointments.map((booking) => booking.id), ['a-2']);
});

test('the person filter is the member list: a subset is a filtered week', async () => {
  const storage = fakeAppointments([
    row({ id: 'a-1' }),
    row({ id: 'a-2', teamMemberId: 'coach-maria', sourceKey: 'gym:booking:2' }),
  ]);
  const week = await weekOf(storage, { teamMemberIds: ['coach-maria'] });
  assert.deepEqual(week.members.map((group) => group.teamMemberId), ['coach-maria']);
  assert.deepEqual(week.members[0].appointments.map((booking) => booking.id), ['a-2']);
});

test('window edges are half-open: touching the border is out, spanning is in', async () => {
  const storage = fakeAppointments([
    row({ id: 'ends-at-from', startsAt: '2026-10-18T23:00:00.000Z', endsAt: FROM, sourceKey: 'gym:ends-at-from' }),
    row({ id: 'starts-at-to', startsAt: TO, endsAt: '2026-10-26T01:00:00.000Z', sourceKey: 'gym:starts-at-to' }),
    row({ id: 'spans', startsAt: '2026-10-18T10:00:00.000Z', endsAt: '2026-10-30T10:00:00.000Z', sourceKey: 'gym:spans' }),
  ]);
  const week = await weekOf(storage, { teamMemberIds: ['coach-guido'] });
  assert.deepEqual(week.members[0].appointments.map((booking) => booking.id), ['spans']);
});

test('cancelled rows stay listed with their status', async () => {
  const storage = fakeAppointments([
    row({ id: 'a-cancelled', status: 'cancelled', sourceKey: 'gym:cancelled' }),
  ]);
  const week = await weekOf(storage, { teamMemberIds: ['coach-guido'] });
  assert.equal(week.members[0].appointments[0].status, 'cancelled');
});

test('a member with no bookings reads as an empty group, never an error', async () => {
  const storage = fakeAppointments([row({ id: 'a-1' })]);
  const week = await weekOf(storage);
  assert.deepEqual(week.members[1], { teamMemberId: 'coach-maria', appointments: [] });
});

test('duplicate member ids collapse to one group', async () => {
  const storage = fakeAppointments([row({ id: 'a-1' })]);
  const week = await weekOf(storage, { teamMemberIds: ['coach-guido', 'coach-guido'] });
  assert.deepEqual(week.members.map((group) => group.teamMemberId), ['coach-guido']);
});

test('an empty member list is refused: a week for nobody would leak the roster it names', async () => {
  await assert.rejects(weekOf(fakeAppointments(), { teamMemberIds: [] }), (error) => (
    error instanceof ValidationError && /at least one team member/.test(error.message)
  ));
});

test('a missing window is refused, and a backwards or oversized one too', async () => {
  const storage = fakeAppointments();
  await assert.rejects(readTeamWeek({ appointments: storage }, { teamMemberIds: ['coach-guido'], to: TO }), ValidationError);
  await assert.rejects(
    readTeamWeek({ appointments: storage }, { teamMemberIds: ['coach-guido'], from: TO, to: FROM }),
    (error) => error instanceof ValidationError && /after from/.test(error.message),
  );
  await assert.rejects(
    readTeamWeek({ appointments: storage }, { teamMemberIds: ['coach-guido'], from: FROM, to: '2026-12-01T00:00:00.000Z' }),
    (error) => error instanceof ValidationError && /at most 31 days/.test(error.message),
  );
});

test('hostile member ids are refused, not queried', async () => {
  const storage = fakeAppointments();
  await assert.rejects(weekOf(storage, { teamMemberIds: ['coach-guido\nx'] }), ValidationError);
});

test('a storage without the exact-match read fails closed', async () => {
  await assert.rejects(
    weekOf({}, { teamMemberIds: ['coach-guido'] }),
    (error) => error.code === 'APPOINTMENTS_STORAGE_INVALID' && error.status === 500,
  );
});

test('rows carry the sync join key, the subject and no write path', async () => {
  const storage = fakeAppointments([row({ id: 'a-1' })]);
  const week = await weekOf(storage, { teamMemberIds: ['coach-guido'] });
  assert.equal(week.members[0].appointments[0].sourceKey, 'gym:booking:1');
  assert.deepEqual(week.members[0].appointments[0].subject, {
    resource: 'contact', id: 'c-presti', owner: 'host', ownerPackage: null,
  });
  assert.ok(Object.isFrozen(week));
  assert.ok(Object.isFrozen(week.members));
  assert.ok(Object.isFrozen(week.members[0]));
  assert.ok(Object.isFrozen(week.members[0].appointments));
  assert.ok(Object.isFrozen(week.members[0].appointments[0]));
  assert.throws(() => { week.members[0].appointments[0].status = 'done'; }, TypeError);
});

test('teamWeekFor on appointment-schedule@1 reads through the capability', async () => {
  const storage = fakeAppointments([row({ id: 'a-1' })]);
  const capability = createAppointmentScheduleCapability({})
    .create({ modules: new Map([['appointment', { service: storage }]]) });
  assert.equal(capability.capabilityContract, 1);
  const week = await capability.teamWeekFor({ teamMemberIds: ['coach-guido'], from: FROM, to: TO });
  assert.deepEqual(week.members[0].appointments.map((booking) => booking.id), ['a-1']);
  // The pre-existing read is unchanged by the additive method.
  assert.deepEqual(
    (await capability.scheduleFor({ resource: 'contact', id: 'c-presti', owner: 'host' })).map((booking) => booking.id),
    ['a-1'],
  );
});
