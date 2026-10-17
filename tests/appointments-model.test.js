import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  APPOINTMENT_INITIAL,
  APPOINTMENT_STATES,
  APPOINTMENT_TERMINAL,
  APPOINTMENT_TRANSITIONS,
  advanceAppointment,
  bookAppointment,
  createAppointmentBookCapability,
  findOverlap,
  readAppointment,
  reminderSourceKey,
  validateAppointmentRequest,
} from '../packages/appointments/src/index.js';
import { createAppointmentsPackage } from '../packages/appointments/src/index.js';
import { NotFoundError } from '../packages/core/index.js';
import { assertPackageConforms } from './helpers/package-conformance.js';

/**
 * Appointments v1 model and booking-lifecycle tests, with no application
 * boot: every claim here is about the transition tables, the validation, the
 * overlap rule and the reminder wiring, so a database would prove nothing and
 * only slow the answer.
 */

const NOW = '2026-10-17T09:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'book' };
const ACTOR = { type: 'user', id: 'e2e' };

const booking = (overrides = {}) => ({
  sourceKey: 'gym:booking:1',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-20T18:00:00.000Z',
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

const fakeFollowUps = (calls = []) => ({
  async createFollowUp(request) {
    calls.push(request);
    return { task: { id: 't-1', ...request }, activity: null, replayed: false };
  },
});

test('the package conforms: identity, one owned record, one declared reach, one offered capability', () => {
  const definition = createAppointmentsPackage();
  assertPackageConforms({
    definition,
    dir: join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'appointments'),
    expected: {
      name: 'appointments',
      version: 1,
      resources: ['appointment'],
      requires: ['work/follow-up@1'],
      provides: ['appointment-book@1'],
    },
    forbiddenImports: [/from\s+['"]node:(https?|net|dgram|tls|dns)['"]/, /\bfetch\s*\(/, /child_process/],
  });
});

test('the lifecycle table is the whole answer, with no other moves', () => {
  assert.deepEqual([...APPOINTMENT_STATES], ['booked', 'confirmed', 'done', 'no-show', 'cancelled']);
  assert.deepEqual(APPOINTMENT_TRANSITIONS, {
    booked: ['confirmed', 'cancelled'],
    confirmed: ['done', 'no-show', 'cancelled'],
    done: [],
    'no-show': [],
    cancelled: [],
  });
  assert.deepEqual([...APPOINTMENT_TERMINAL], ['done', 'no-show', 'cancelled']);
  assert.equal(APPOINTMENT_INITIAL, 'booked');
});

test('a fresh booking stores the agreed snapshot as booked, with no reminder when none is named', async () => {
  const service = fakeAppointments();
  const { appointment, reminder, replayed } = await bookAppointment(contextFor(service), booking());
  assert.equal(replayed, false);
  assert.equal(appointment.status, 'booked');
  assert.equal(appointment.serviceKey, 'pt-single');
  assert.equal(appointment.priceCents, 4000);
  assert.equal(appointment.currency, 'EUR');
  assert.equal(appointment.teamMemberId, 'coach-guido');
  assert.equal(appointment.bookedAt, NOW);
  assert.equal(appointment.decidedAt, null);
  assert.equal(appointment.reminderSourceKey, null);
  assert.equal(appointment.reminderDueAt, null);
  assert.equal(reminder, null);
});

test('endsAt must be after startsAt, and a slot is at most 24 hours', () => {
  assert.throws(() => validateAppointmentRequest(booking({ endsAt: '2026-10-20T17:00:00.000Z' })), /endsAt must be after startsAt/);
  assert.throws(() => validateAppointmentRequest(booking({ endsAt: '2026-10-20T16:00:00.000Z' })), /endsAt must be after startsAt/);
  assert.throws(
    () => validateAppointmentRequest(booking({ endsAt: '2026-10-21T17:00:01.000Z' })),
    /at most 24 hours/,
  );
});

test('serviceKey is the listino product key and currency is a 3-letter code', () => {
  assert.throws(() => validateAppointmentRequest(booking({ serviceKey: 'PT Single!' })), /serviceKey must be the listino product key/);
  assert.throws(() => validateAppointmentRequest(booking({ currency: 'eur' })), /currency must be a 3-letter ISO code/);
  assert.throws(() => validateAppointmentRequest(booking({ priceCents: -1 })), /priceCents/);
  assert.throws(() => validateAppointmentRequest(booking({ teamMemberId: '' })), /teamMemberId is required/);
});

test('an impossible date is refused, not rolled over', () => {
  assert.throws(
    () => validateAppointmentRequest(booking({ startsAt: '2027-02-30T17:00:00.000Z', endsAt: '2027-02-30T18:00:00.000Z' })),
    /never existed/,
  );
});

test('the same source key with the same payload replays; a divergent payload is refused 409', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const first = await bookAppointment(context, booking());
  assert.equal(first.replayed, false);
  const second = await bookAppointment(context, booking());
  assert.equal(second.replayed, true);
  assert.equal(second.appointment.id, first.appointment.id);
  await assert.rejects(
    bookAppointment(context, booking({ priceCents: 5000 })),
    (error) => error.code === 'APPOINTMENTS_LOG_CONFLICT' && error.status === 409,
  );
});

test('an overlapping booking for the same member is refused 409 naming the held row', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  await bookAppointment(context, booking());
  const attempt = booking({ sourceKey: 'gym:booking:2', startsAt: '2026-10-20T17:30:00.000Z', endsAt: '2026-10-20T18:30:00.000Z' });
  await assert.rejects(
    bookAppointment(context, attempt),
    (error) => error.code === 'APPOINTMENTS_OVERLAP'
      && error.status === 409
      && error.details?.conflictingId === 'a-1',
  );
});

test('back-to-back slots share an endpoint and do not overlap; another member is another calendar', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  await bookAppointment(context, booking());
  const next = await bookAppointment(context, booking({
    sourceKey: 'gym:booking:2', startsAt: '2026-10-20T18:00:00.000Z', endsAt: '2026-10-20T19:00:00.000Z',
  }));
  assert.equal(next.replayed, false);
  const other = await bookAppointment(context, booking({
    sourceKey: 'gym:booking:3',
    teamMemberId: 'coach-marta',
    startsAt: '2026-10-20T17:30:00.000Z',
    endsAt: '2026-10-20T18:30:00.000Z',
  }));
  assert.equal(other.replayed, false);
});

test('a cancelled booking frees its slot; done and no-show still hold theirs', async () => {
  const held = (status) => ({
    sourceKey: `gym:held:${status}`,
    status,
    teamMemberId: 'coach-guido',
    startsAt: '2026-10-20T17:00:00.000Z',
    endsAt: '2026-10-20T18:00:00.000Z',
  });
  const candidate = { teamMemberId: 'coach-guido', startMs: Date.parse('2026-10-20T17:30:00.000Z'), endMs: Date.parse('2026-10-20T18:30:00.000Z') };
  assert.equal(findOverlap(candidate, [held('cancelled')]), null);
  assert.equal(findOverlap(candidate, [held('booked')]).status, 'booked');
  assert.equal(findOverlap(candidate, [held('confirmed')]).status, 'confirmed');
  assert.equal(findOverlap(candidate, [held('done')]).status, 'done');
  assert.equal(findOverlap(candidate, [held('no-show')]).status, 'no-show');
  const free = { ...candidate, startMs: Date.parse('2026-10-20T18:00:00.000Z'), endMs: Date.parse('2026-10-20T19:00:00.000Z') };
  assert.equal(findOverlap(free, [held('booked')]), null);
});

test('booked advances to confirmed, confirmed ends done or no-show, terminals never regress', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const { appointment } = await bookAppointment(context, booking());
  const confirmed = await advanceAppointment({ appointments: service, actor: ACTOR }, appointment, 'confirmed');
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.decidedAt !== null);
  const done = await advanceAppointment({ appointments: service, actor: ACTOR }, confirmed, 'done');
  assert.equal(done.status, 'done');
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: ACTOR }, done, 'confirmed'),
    (error) => error.code === 'APPOINTMENTS_INVALID_STATE' && error.status === 409,
  );
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: ACTOR }, appointment, 'done'),
    /cannot advance to "done"/,
  );
});

test('cancelling always carries a reason; any other move carries none', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const { appointment } = await bookAppointment(context, booking());
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: ACTOR }, appointment, 'cancelled'),
    /cancelReason is required/,
  );
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: ACTOR }, appointment, 'confirmed', 'just because'),
    /cancelReason is recorded only when an appointment is cancelled/,
  );
  const cancelled = await advanceAppointment({ appointments: service, actor: ACTOR }, appointment, 'cancelled', 'customer asked on WhatsApp');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelReason, 'customer asked on WhatsApp');
});

test('a booking with remindAt opens exactly one work follow-up reminder, due at the named instant', async () => {
  const service = fakeAppointments();
  const calls = [];
  const context = contextFor(service, { followUps: fakeFollowUps(calls) });
  const { appointment, reminder } = await bookAppointment(context, booking({ remindAt: '2026-10-19T17:00:00.000Z' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceKey, reminderSourceKey('gym:booking:1'));
  assert.equal(calls[0].sourceKey, appointment.reminderSourceKey);
  assert.equal(calls[0].dueAt, '2026-10-19T17:00:00.000Z');
  assert.equal(calls[0].dueAt, appointment.reminderDueAt);
  assert.equal(calls[0].subject.resource, 'contact');
  assert.equal(calls[0].subject.id, 'c-presti');
  assert.equal(calls[0].source.package, 'host');
  assert.ok(calls[0].title.length <= 200);
  assert.equal(reminder.task.id, 't-1');
});

test('remindAt must be before the slot, and a reminder without the work handle fails closed', async () => {
  assert.throws(
    () => validateAppointmentRequest(booking({ remindAt: '2026-10-20T17:00:00.000Z' })),
    /remindAt must be before startsAt/,
  );
  const service = fakeAppointments();
  await assert.rejects(
    bookAppointment(contextFor(service), booking({ remindAt: '2026-10-19T17:00:00.000Z' })),
    (error) => error.code === 'APPOINTMENTS_REMINDER_UNAVAILABLE' && error.status === 500,
  );
});

test('the offered capability opens the provider handle with the opener modules', async () => {
  const service = fakeAppointments();
  const calls = [];
  const provider = {
    name: 'follow-up',
    version: 1,
    create: (providerContext) => {
      assert.equal(providerContext.consumer, 'appointments');
      return fakeFollowUps(calls);
    },
  };
  const capability = createAppointmentBookCapability({ provider });
  const opened = capability.create({ modules: modulesFor(service), actor: ACTOR, now: () => NOW, consumer: 'host' });
  const { appointment } = await opened.bookAppointment(booking({ remindAt: '2026-10-19T17:00:00.000Z' }));
  assert.equal(calls.length, 1);
  assert.equal(appointment.reminderDueAt, '2026-10-19T17:00:00.000Z');
  const reread = await opened.appointment(appointment.id);
  assert.equal(reread.id, appointment.id);
  assert.equal(await opened.appointment('missing'), null);
});

test('a booking key too long to own a reminder fails closed at booking time', async () => {
  const service = fakeAppointments();
  assert.throws(
    () => reminderSourceKey('k'.repeat(200)),
    /needs a sourceKey of at most 179 characters/,
  );
  await assert.rejects(
    bookAppointment(contextFor(service), booking({ sourceKey: 'k'.repeat(200), remindAt: '2026-10-19T17:00:00.000Z' })),
    /needs a sourceKey of at most 179 characters/,
  );
  assert.equal(service.rows.length, 0);
});

test('provenance is bound to the resolved consumer, not to caller text', async () => {
  const service = fakeAppointments();
  await assert.rejects(
    bookAppointment(contextFor(service), booking({ source: { package: 'delivery', action: 'book' } })),
    (error) => error.code === 'APPOINTMENTS_SOURCE_PACKAGE_MISMATCH' && error.status === 403,
  );
});
