import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookAppointment,
  validateAppointmentRequest,
} from '../packages/appointments/src/index.js';
import { NotFoundError } from '../packages/core/index.js';

/**
 * Luogo dell'appuntamento (backlog:9ff9a9ee1fea): indirizzo libero o
 * «Online» con il link alla riunione, come il form evento di Google
 * Calendar. Il luogo viaggia con la prenotazione: validazione qui,
 * scrittura nei submitted, idempotenza via 409 sulla stessa chiave.
 */

const NOW = '2026-11-16T09:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'book' };
const ACTOR = { type: 'user', id: 'location-probe' };

const booking = (overrides = {}) => ({
  sourceKey: 'gym:location:1',
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

const contextFor = (service, overrides = {}) => ({
  modules: modulesFor(service),
  actor: ACTOR,
  now: () => NOW,
  consumer: 'host',
  followUps: null,
  ...overrides,
});

test('9ff9a9ee1fea: a free-text address is stored with the booking', async () => {
  const service = fakeAppointments();
  const { appointment, replayed } = await bookAppointment(
    contextFor(service),
    booking({ location: 'Via delle Rose 12, Milano' }),
  );
  assert.equal(replayed, false);
  assert.equal(appointment.location, 'Via delle Rose 12, Milano');
  assert.equal(appointment.locationUrl, null);
});

test('9ff9a9ee1fea: «Online» with the meeting link is stored together', async () => {
  const service = fakeAppointments();
  const { appointment } = await bookAppointment(
    contextFor(service),
    booking({ sourceKey: 'gym:location:2', location: 'Online', locationUrl: 'https://meet.example.com/abc-def' }),
  );
  assert.equal(appointment.location, 'Online');
  assert.equal(appointment.locationUrl, 'https://meet.example.com/abc-def');
});

test('9ff9a9ee1fea: no place named stores nulls, like before', async () => {
  const service = fakeAppointments();
  const { appointment } = await bookAppointment(contextFor(service), booking({ sourceKey: 'gym:location:3' }));
  assert.equal(appointment.location, null);
  assert.equal(appointment.locationUrl, null);
});

test('9ff9a9ee1fea: a link without a label is refused', () => {
  assert.throws(
    () => validateAppointmentRequest(booking({ locationUrl: 'https://meet.example.com/abc' })),
    /locationUrl needs a location label/,
  );
});

test('9ff9a9ee1fea: a non-http link, a spaced link and an overlong place are refused', () => {
  assert.throws(
    () => validateAppointmentRequest(booking({ location: 'Online', locationUrl: 'ftp://files.example.com/x' })),
    /must be an http\(s\) link/,
  );
  assert.throws(
    () => validateAppointmentRequest(booking({ location: 'Online', locationUrl: 'https://meet.example.com/a b' })),
    /no spaces or line breaks/,
  );
  assert.throws(
    () => validateAppointmentRequest(booking({ location: 'x'.repeat(301) })),
    /at most 300 characters/,
  );
});

test('9ff9a9ee1fea: the same key with the same place replays, another place is a 409', async () => {
  const service = fakeAppointments();
  const first = booking({ sourceKey: 'gym:location:4', location: 'Via delle Rose 12, Milano' });
  const { replayed } = await bookAppointment(contextFor(service), first);
  assert.equal(replayed, false);
  const again = await bookAppointment(contextFor(service), first);
  assert.equal(again.replayed, true);
  assert.equal(again.appointment.location, 'Via delle Rose 12, Milano');
  await assert.rejects(
    bookAppointment(contextFor(service), booking({ sourceKey: 'gym:location:4', location: 'Online', locationUrl: 'https://meet.example.com/abc' })),
    (error) => {
      assert.match(String(error.message), /different location/);
      assert.equal(error.details?.conflictingFields?.includes('location'), true);
      return true;
    },
  );
});

test('9ff9a9ee1fea: labels are trimmed, a blank label is missing', () => {
  const input = validateAppointmentRequest(booking({ location: '  Online  ', locationUrl: '  https://meet.example.com/abc  ' }));
  assert.equal(input.location, 'Online');
  assert.equal(input.locationUrl, 'https://meet.example.com/abc');
  assert.throws(
    () => validateAppointmentRequest(booking({ location: '   ', locationUrl: 'https://meet.example.com/abc' })),
    /location is required/,
  );
});
