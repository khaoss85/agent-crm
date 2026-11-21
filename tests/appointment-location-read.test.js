import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookAppointment,
  readSchedule,
  readTeamWeek,
} from '../packages/appointments/src/index.js';
import { NotFoundError } from '../packages/core/index.js';

/**
 * Luogo nelle letture (backlog:9ff9a9ee1fea, VERIFIER_BACK failed 3:
 * popover e cronologia scheda non mostrano mai il luogo perché la
 * lettura della settimana del team non manda location/locationUrl).
 * Dalla conferma alla lettura della settimana il luogo arriva.
 */

const NOW = '2026-11-20T09:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'book' };
const ACTOR = { type: 'user', id: 'location-probe' };

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
  sourceKey: 'gym:location-read:1',
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

test('9ff9a9ee1fea: dalla conferma alla lettura della settimana il luogo arriva (team + scheda)', async () => {
  const service = fakeAppointments();
  const { appointment } = await bookAppointment(
    contextFor(service),
    booking({ location: 'Online', locationUrl: 'https://meet.example.com/abc-def' }),
  );
  assert.equal(appointment.location, 'Online');

  const week = await readTeamWeek(
    { appointments: service },
    {
      teamMemberIds: ['coach-guido'],
      from: '2026-11-20T00:00:00.000Z',
      to: '2026-11-27T00:00:00.000Z',
    },
  );
  const slot = week.members[0].appointments.find((entry) => entry.id === appointment.id);
  assert.ok(slot, 'la settimana del team mostra la prenotazione');
  assert.equal(slot.location, 'Online');
  assert.equal(slot.locationUrl, 'https://meet.example.com/abc-def');

  const schedule = await readSchedule({ appointments: service }, SUBJECT);
  const line = schedule.find((entry) => entry.id === appointment.id);
  assert.ok(line, 'la scheda mostra la prenotazione');
  assert.equal(line.location, 'Online');
  assert.equal(line.locationUrl, 'https://meet.example.com/abc-def');
});

test('9ff9a9ee1fea: senza luogo le letture restano nulle come prima', async () => {
  const service = fakeAppointments();
  const { appointment } = await bookAppointment(
    contextFor(service),
    booking({ sourceKey: 'gym:location-read:2' }),
  );
  const week = await readTeamWeek(
    { appointments: service },
    {
      teamMemberIds: ['coach-guido'],
      from: '2026-11-20T00:00:00.000Z',
      to: '2026-11-27T00:00:00.000Z',
    },
  );
  const slot = week.members[0].appointments.find((entry) => entry.id === appointment.id);
  assert.equal(slot.location, null);
  assert.equal(slot.locationUrl, null);
  const schedule = await readSchedule({ appointments: service }, SUBJECT);
  const line = schedule.find((entry) => entry.id === appointment.id);
  assert.equal(line.location, null);
  assert.equal(line.locationUrl, null);
});
