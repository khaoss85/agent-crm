import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookAppointment,
  readSchedule,
  readTeamWeek,
} from '../packages/appointments/src/index.js';
import { NotFoundError } from '../packages/core/index.js';

/**
 * Luogo dell'appuntamento nella lettura della settimana del team
 * (backlog:ece111d80305, seguito 19/11 20:0xZ): la shell e il ponte
 * scrivono e restituiscono location/locationUrl (Proponi e Conferma 200),
 * ma la lettura della settimana del team non li manda, quindi il popover
 * e la cronologia non mostrano mai il luogo. Dalla conferma alla lettura
 * della settimana il luogo deve arrivare.
 */

const NOW = '2026-11-19T09:00:00.000Z';
const FROM = '2026-11-16T00:00:00.000Z';
const TO = '2026-11-23T00:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'week-location-test' };
const ACTOR = { type: 'user', id: 'week-location-probe' };

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
    async applyManaged(id, patch) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new NotFoundError(`appointment ${id} not found`);
      Object.assign(row, patch);
      return row;
    },
    async get(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new NotFoundError(`appointment ${id} not found`);
      return row;
    },
  };
}

const modulesFor = (service) => ({
  get: (name) => {
    if (name === 'appointment') return { service };
    throw new NotFoundError(`module ${name} not found`);
  },
});

const contextFor = (service) => ({
  modules: modulesFor(service),
  actor: ACTOR,
  now: () => NOW,
  consumer: 'host',
  followUps: null,
});

const booking = (overrides = {}) => ({
  sourceKey: 'gym:week-location:1',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-11-20T17:00:00.000Z',
  endsAt: '2026-11-20T18:00:00.000Z',
  source: SOURCE,
  ...overrides,
});

test('ece111d80305: the team week carries the meeting place from the booking to the grid', async () => {
  const service = fakeAppointments();
  const { appointment } = await bookAppointment(
    contextFor(service),
    booking({ location: 'Online', locationUrl: 'https://meet.example.com/abc-def' }),
  );
  assert.equal(appointment.location, 'Online');

  const week = await readTeamWeek(
    { appointments: service, calendarSync: null },
    { teamMemberIds: ['coach-guido'], from: FROM, to: TO },
  );
  assert.equal(week.members.length, 1);
  assert.equal(week.members[0].appointments.length, 1);
  assert.equal(week.members[0].appointments[0].location, 'Online');
  assert.equal(week.members[0].appointments[0].locationUrl, 'https://meet.example.com/abc-def');
});

test('ece111d80305: the customer schedule carries the meeting place to the timeline', async () => {
  const service = fakeAppointments();
  await bookAppointment(
    contextFor(service),
    booking({ location: 'Via delle Rose 12, Milano' }),
  );

  const schedule = await readSchedule({ appointments: service }, SUBJECT);
  assert.equal(schedule.length, 1);
  assert.equal(schedule[0].location, 'Via delle Rose 12, Milano');
  assert.equal(schedule[0].locationUrl, null);
});
