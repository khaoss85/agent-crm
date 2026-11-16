import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookAppointment,
  proposeBooking,
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

const AGENT = { type: 'agent', id: 'agente-agenda' };

/** A switch-off gate that dedups on the proposal action key, like the real one. */
const keyDedupGate = (seen = new Map()) => ({
  async gate() { return { decision: 'deny' }; },
  async propose({ actionKey }) {
    if (seen.has(actionKey)) return { proposalId: seen.get(actionKey), replayed: true };
    const id = `p-${seen.size + 1}`;
    seen.set(actionKey, id);
    return { proposalId: id, replayed: false };
  },
});

const proposeAsAgent = (overrides = {}, gate) => proposeBooking(
  { ...contextFor(fakeAppointments()), actor: AGENT, permissionGate: gate },
  { ...booking({ sourceKey: 'gym:location:7' }), spaceId: 'spazio-1', ...overrides },
);

test('9ff9a9ee1fea: the same place replays its proposal, another place opens a new one (review P1 giro 2)', async () => {
  // Before the fix proposalActionKey missed location/locationUrl while the
  // booking counted them: two proposals for the same source key with a
  // different place collapsed onto one action key.
  const gate = keyDedupGate();
  const first = await proposeAsAgent({ location: 'Via delle Rose 12, Milano' }, gate);
  assert.equal(first.decision, 'proposal');
  assert.equal(first.replayed, false);
  const same = await proposeAsAgent({ location: 'Via delle Rose 12, Milano' }, gate);
  assert.equal(same.proposalId, first.proposalId);
  assert.equal(same.replayed, true);
  const moved = await proposeAsAgent(
    { location: 'Online', locationUrl: 'https://meet.example.com/abc' }, gate,
  );
  assert.equal(moved.replayed, false);
  assert.notEqual(moved.proposalId, first.proposalId);
  const movedAgain = await proposeAsAgent(
    { location: 'Online', locationUrl: 'https://meet.example.com/abc' }, gate,
  );
  assert.equal(movedAgain.proposalId, moved.proposalId);
  assert.equal(movedAgain.replayed, true);
});

test('9ff9a9ee1fea: every booking-claim field opens its own proposal (single source of truth)', async () => {
  // bookingClaimKeyParts is the one list the key hashes: changing any field
  // the booking idempotency counts must change the action key. The table
  // holds every case of the earlier rounds (notes, reminderChannel, the
  // place in the draft) and this one (the place in the key).
  const gate = keyDedupGate();
  const base = await proposeAsAgent({}, gate);
  assert.equal(base.replayed, false);
  const cases = {
    subject: { subject: { resource: 'contact', id: 'c-altro', owner: 'host' } },
    teamMemberId: { teamMemberId: 'coach-maria' },
    serviceKey: { serviceKey: 'pt-double' },
    priceCents: { priceCents: 5000 },
    currency: { currency: 'USD' },
    slot: { startsAt: '2026-11-20T18:00:00.000Z', endsAt: '2026-11-20T19:00:00.000Z' },
    notes: { notes: 'porta il tappetino' },
    location: { location: 'Via delle Rose 12, Milano' },
    locationUrl: { location: 'Online', locationUrl: 'https://meet.example.com/abc' },
    remindAt: { remindAt: '2026-11-20T16:00:00.000Z' },
    reminderChannel: {
      remindAt: '2026-11-20T16:00:00.000Z',
      reminderChannel: {
        spaceId: 'spazio-1',
        connectionKey: 'wa-principale',
        to: '+393331234567',
        template: { name: 'promemoria_appuntamento', language: 'it', variables: ['Guido'] },
      },
    },
    source: { source: { package: 'host', action: 'link' } },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const varied = await proposeAsAgent(overrides, gate);
    assert.equal(varied.replayed, false, `${name} diverges the claim: no replay`);
    assert.notEqual(varied.proposalId, base.proposalId, `${name} opens its own proposal`);
  }
  const replay = await proposeAsAgent({}, gate);
  assert.equal(replay.proposalId, base.proposalId);
  assert.equal(replay.replayed, true);
});

test('9ff9a9ee1fea: the confirm-required draft round-trips the validated place (review P1)', async () => {
  // A person who books is the approval: the switch answer is allow and the
  // draft is the confirm payload. Before the fix the draft dropped the new
  // location/locationUrl, so confirming from it stored nulls.
  const gate = {
    async gate() { return { decision: 'allow' }; },
    async propose() { return { proposalId: null, replayed: false }; },
  };
  const service = fakeAppointments();
  const context = { ...contextFor(service), permissionGate: gate };
  const proposed = await proposeBooking(context, {
    ...booking({ sourceKey: 'gym:location:5', location: 'Via delle Rose 12, Milano' }),
    spaceId: 'spazio-1',
  });
  assert.equal(proposed.decision, 'confirm-required');
  assert.equal(proposed.draft.location, 'Via delle Rose 12, Milano');
  assert.equal(proposed.draft.locationUrl, null);
  const online = await proposeBooking({ ...contextFor(fakeAppointments()), permissionGate: gate }, {
    ...booking({ sourceKey: 'gym:location:6', location: 'Online', locationUrl: 'https://meet.example.com/abc' }),
    spaceId: 'spazio-1',
  });
  assert.equal(online.draft.location, 'Online');
  assert.equal(online.draft.locationUrl, 'https://meet.example.com/abc');
});
