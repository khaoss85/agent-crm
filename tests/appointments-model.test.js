import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

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
import { NotFoundError, ValidationError } from '../packages/core/index.js';
import { createDatabase } from '../packages/core/src/database.js';
import { recordModuleMigrations } from '../packages/core/src/record-module-runtime.js';
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

/**
 * An in-memory database handle with no tables: fakes that carry it can prove
 * a caller transaction through the same storage-seam witness production uses,
 * while staying table-free and fast.
 */
function txDatabase(t) {
  const db = createDatabase({ path: ':memory:' });
  t.after(() => db.close());
  return db;
}

function fakeAppointments(seed = [], database = null) {
  const rows = seed.map((row, index) => ({ id: `a-${index + 1}`, ...row }));
  return {
    rows,
    database,
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

const fakeFollowUps = (calls = []) => {
  const seen = new Map();
  return {
    async createFollowUp(request) {
      calls.push(request);
      // Replay-aware like the real handle: the same reminder identity answers
      // with its task rather than opening a second one.
      if (seen.has(request.sourceKey)) {
        return { task: seen.get(request.sourceKey), activity: null, replayed: true };
      }
      const task = { id: `t-${seen.size + 1}`, ...request };
      seen.set(request.sourceKey, task);
      return { task, activity: null, replayed: false };
    },
  };
};

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
  assert.equal(first.reminder, null);
  const second = await bookAppointment(context, booking());
  assert.equal(second.replayed, true);
  assert.equal(second.appointment.id, first.appointment.id);
  assert.equal(second.reminder, null, 'a replay without a reminder answers the same shape, with an explicit null');
  await assert.rejects(
    bookAppointment(context, booking({ priceCents: 5000 })),
    (error) => error.code === 'APPOINTMENTS_LOG_CONFLICT' && error.status === 409,
  );
});

test('the reminder intent is part of the source-key identity: adding, removing or moving it is a 409', async (t) => {
  const db = txDatabase(t);
  const withReminder = booking({ remindAt: '2026-10-19T17:00:00.000Z' });
  // Booked without a reminder, retried with one: refused, never silently dropped.
  {
    const service = fakeAppointments([], db);
    const context = contextFor(service, { followUps: fakeFollowUps() });
    await bookAppointment(context, booking());
    await assert.rejects(
      db.transactionAsync(() => bookAppointment(context, withReminder)),
      (error) => {
        assert.equal(error.code, 'APPOINTMENTS_LOG_CONFLICT');
        assert.equal(error.status, 409);
        assert.ok(error.details.conflictingFields.includes('reminderDueAt'), `names the reminder: ${JSON.stringify(error.details.conflictingFields)}`);
        assert.ok(error.details.conflictingFields.includes('reminderSourceKey'), `names the reminder identity: ${JSON.stringify(error.details.conflictingFields)}`);
        return true;
      },
    );
  }
  // Booked with a reminder, retried without one — or with a moved one: refused.
  {
    const service = fakeAppointments([], db);
    const context = contextFor(service, { followUps: fakeFollowUps() });
    await db.transactionAsync(() => bookAppointment(context, withReminder));
    await assert.rejects(
      bookAppointment(context, booking()),
      (error) => error.code === 'APPOINTMENTS_LOG_CONFLICT' && error.status === 409,
    );
    await assert.rejects(
      db.transactionAsync(() => bookAppointment(context, booking({ remindAt: '2026-10-18T17:00:00.000Z' }))),
      (error) => error.code === 'APPOINTMENTS_LOG_CONFLICT' && error.status === 409,
    );
  }
});

test('a replay with the same reminder answers the same shape, with the reminder handle', async (t) => {
  const db = txDatabase(t);
  const service = fakeAppointments([], db);
  const calls = [];
  const context = contextFor(service, { followUps: fakeFollowUps(calls) });
  const request = booking({ remindAt: '2026-10-19T17:00:00.000Z' });
  const first = await db.transactionAsync(() => bookAppointment(context, request));
  assert.equal(first.replayed, false);
  assert.equal(first.reminder.task.id, 't-1');
  const second = await db.transactionAsync(() => bookAppointment(context, request));
  assert.equal(second.replayed, true);
  assert.equal(second.appointment.id, first.appointment.id);
  assert.equal(second.reminder.task.id, 't-1', 'the replay re-issues the identical reminder rather than opening a second');
  assert.equal(second.reminder.replayed, true);
  assert.equal(calls.length, 2);
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

test('two interleaved bookings for the same member do not double-book: the loser gets 409', async () => {
  const service = fakeAppointments();
  // Force the interleaving the mutex exists to close: every storage step
  // yields, so without serialization both reads would see an empty slot and
  // both writes would commit.
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const rawList = service.listWhere.bind(service);
  service.listWhere = async (where) => { await tick(); const rows = await rawList(where); await tick(); return rows; };
  const rawCreate = service.createManaged.bind(service);
  service.createManaged = async (row, options) => { await tick(); return rawCreate(row, options); };
  const context = contextFor(service);
  const first = booking({ sourceKey: 'gym:race:1' });
  const second = booking({
    sourceKey: 'gym:race:2',
    startsAt: '2026-10-20T17:30:00.000Z',
    endsAt: '2026-10-20T18:30:00.000Z',
  });
  const [winner, loser] = await Promise.all([
    bookAppointment(context, first).then((result) => ({ ok: result }), (error) => ({ error })),
    bookAppointment(context, second).then((result) => ({ ok: result }), (error) => ({ error })),
  ]);
  // Acquisition attaches synchronously, so the first caller in the tick wins.
  assert.ok(winner.ok && winner.ok.replayed === false, 'the winner books');
  assert.ok(loser.error, 'the loser is refused, never booked over the winner');
  assert.equal(loser.error.code, 'APPOINTMENTS_OVERLAP');
  assert.equal(loser.error.status, 409);
  assert.equal(service.rows.length, 1, 'exactly one row survives the race');
});

test('interleaved bookings for different members do not block each other', async () => {
  const service = fakeAppointments();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const rawList = service.listWhere.bind(service);
  service.listWhere = async (where) => { await tick(); return rawList(where); };
  const context = contextFor(service);
  // Same slot, two calendars: both book.
  const [guido, marta] = await Promise.all([
    bookAppointment(context, booking({ sourceKey: 'gym:parallel:1' })),
    bookAppointment(context, booking({
      sourceKey: 'gym:parallel:2',
      teamMemberId: 'coach-marta',
    })),
  ]);
  assert.equal(guido.replayed, false);
  assert.equal(marta.replayed, false);
  assert.equal(service.rows.length, 2);
});

test('a held row whose slot cannot be proven fails closed: refused, never booked over', async () => {
  const corrupt = (slot) => fakeAppointments([{
    sourceKey: 'gym:held:corrupt',
    status: 'booked',
    teamMemberId: 'coach-guido',
    ...slot,
  }]);
  for (const slot of [
    { startsAt: 'not-a-date', endsAt: '2026-10-20T18:00:00.000Z' },
    { startsAt: '2026-10-20T18:00:00.000Z', endsAt: '2026-10-20T17:00:00.000Z' },
  ]) {
    const service = corrupt(slot);
    await assert.rejects(
      bookAppointment(contextFor(service), booking({ sourceKey: 'gym:booking:9' })),
      (error) => {
        assert.equal(error.code, 'APPOINTMENTS_STORAGE_INVALID');
        assert.equal(error.status, 500);
        assert.equal(error.details?.rowId, 'a-1', 'the refusal names the corrupt row');
        return true;
      },
    );
    assert.equal(service.rows.length, 1, 'the refused booking stores nothing');
  }
  // The pure function fails the same way, without touching storage.
  assert.throws(
    () => findOverlap(
      { teamMemberId: 'coach-guido', startMs: Date.parse('2026-10-20T17:30:00.000Z'), endMs: Date.parse('2026-10-20T18:30:00.000Z') },
      [{ id: 'a-9', status: 'booked', startsAt: 'garbage', endsAt: '2026-10-20T18:00:00.000Z' }],
    ),
    (error) => error.code === 'APPOINTMENTS_STORAGE_INVALID' && error.details?.rowId === 'a-9',
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

test('an advance is enforced against the stored row, never against a stale copy', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const { appointment } = await bookAppointment(context, booking());
  const confirmed = await advanceAppointment({ appointments: service, actor: ACTOR }, appointment, 'confirmed');
  assert.equal(confirmed.status, 'confirmed');
  // A snapshot taken while the row was still confirmed...
  const stale = { ...confirmed };
  // ...then another writer cancels the booking...
  await advanceAppointment({ appointments: service, actor: ACTOR }, confirmed, 'cancelled', 'customer called back');
  // ...so the stale copy advancing to done is refused: confirmed -> done is
  // legal on the copy, but the stored row is cancelled and terminal.
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: ACTOR }, stale, 'done'),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_INVALID_STATE');
      assert.equal(error.status, 409);
      assert.equal(error.details.from, 'cancelled');
      return true;
    },
  );
  assert.equal(service.rows[0].status, 'cancelled', 'the refused move writes nothing');
});

test('an advance without an actor is refused before anything is read or written', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const { appointment } = await bookAppointment(context, booking());
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: null }, appointment, 'confirmed'),
    /an actor is required/,
  );
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: undefined }, appointment, 'confirmed'),
    /an actor is required/,
  );
  assert.equal(service.rows[0].status, 'booked', 'the refused move writes nothing');
});

test('a booking with remindAt opens exactly one work follow-up reminder, due at the named instant', async (t) => {
  const db = txDatabase(t);
  const service = fakeAppointments([], db);
  const calls = [];
  const context = contextFor(service, { followUps: fakeFollowUps(calls) });
  const { appointment, reminder } = await db.transactionAsync(
    () => bookAppointment(context, booking({ remindAt: '2026-10-19T17:00:00.000Z' })),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceKey, reminderSourceKey('gym:booking:1'));
  assert.equal(calls[0].sourceKey, appointment.reminderSourceKey);
  assert.equal(calls[0].dueAt, '2026-10-19T17:00:00.000Z');
  assert.equal(calls[0].dueAt, appointment.reminderDueAt);
  assert.equal(calls[0].subject.resource, 'contact');
  assert.equal(calls[0].subject.id, 'c-presti');
  // The reminder is opened as this package: forwarding the booking source
  // (e.g. `host`) makes work refuse the write after the booking is committed.
  assert.equal(calls[0].source.package, 'appointments');
  assert.ok(calls[0].title.length <= 200);
  assert.equal(reminder.task.id, 't-1');
});

test('a booking with remindAt outside a transaction is refused before anything is written', async (t) => {
  const db = txDatabase(t);
  const service = fakeAppointments([], db);
  const context = contextFor(service, { followUps: fakeFollowUps() });
  await assert.rejects(
    bookAppointment(context, booking({ remindAt: '2026-10-19T17:00:00.000Z' })),
    (error) => error.code === 'APPOINTMENTS_TRANSACTION_REQUIRED' && error.status === 500,
  );
  assert.equal(service.rows.length, 0, 'the pair promise is proven before the first write');
});

test('remindAt must be before the slot, and a reminder without the work handle fails closed', async (t) => {
  assert.throws(
    () => validateAppointmentRequest(booking({ remindAt: '2026-10-20T17:00:00.000Z' })),
    /remindAt must be before startsAt/,
  );
  const db = txDatabase(t);
  const service = fakeAppointments([], db);
  await assert.rejects(
    db.transactionAsync(
      () => bookAppointment(contextFor(service), booking({ remindAt: '2026-10-19T17:00:00.000Z' })),
    ),
    (error) => error.code === 'APPOINTMENTS_REMINDER_UNAVAILABLE' && error.status === 500,
  );
});

test('the offered capability opens the provider handle with the opener modules', async (t) => {
  const db = txDatabase(t);
  const service = fakeAppointments([], db);
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
  const { appointment } = await db.transactionAsync(
    () => opened.bookAppointment(booking({ remindAt: '2026-10-19T17:00:00.000Z' })),
  );
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

test('an advance on a missing record is a typed refusal, never a TypeError', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const { appointment } = await bookAppointment(context, booking());
  // A null, undefined or id-less record — e.g. a missed exact lookup
  // forwarded straight into the advance — names the field it is missing.
  for (const record of [null, undefined, {}, { id: '' }, { id: '   ' }, { id: 42 }]) {
    await assert.rejects(
      advanceAppointment({ appointments: service, actor: ACTOR }, record, 'confirmed'),
      (error) => {
        assert.ok(error instanceof ValidationError, `typed, not a crash: ${String(error)}`);
        assert.match(error.message, /id is required/);
        return true;
      },
    );
  }
  // A well-formed id for a row that was deleted since it was read surfaces
  // the storage's own miss rather than advancing a ghost.
  await assert.rejects(
    advanceAppointment({ appointments: service, actor: ACTOR }, { id: 'a-999' }, 'confirmed'),
    (error) => error instanceof NotFoundError,
  );
  // The public capability refuses the same way: a missed lookup forwarded
  // into the advance never leaves the framework error contract.
  const capability = createAppointmentBookCapability({}).create({
    modules: modulesFor(service),
    actor: ACTOR,
    now: () => NOW,
    consumer: 'host',
  });
  await assert.rejects(
    capability.advanceAppointment(await capability.appointment('missing-id'), 'confirmed'),
    (error) => error instanceof ValidationError && /id is required/.test(error.message),
  );
  assert.equal(appointment.status, 'booked', 'the refused moves write nothing');
  assert.equal(service.rows.length, 1);
});

test('a replay that names a reminder without the work handle fails like the fresh path', async (t) => {
  const db = txDatabase(t);
  const service = fakeAppointments([], db);
  const calls = [];
  const request = booking({ remindAt: '2026-10-19T17:00:00.000Z' });
  const first = await db.transactionAsync(
    () => bookAppointment(contextFor(service, { followUps: fakeFollowUps(calls) }), request),
  );
  assert.equal(first.replayed, false);
  assert.equal(calls.length, 1);
  // The identical request replayed where no follow-up handle is composed is
  // refused with the fresh path's code — never an explicit null next to a
  // stored reminderDueAt, which would report a missing reminder as success.
  for (const followUps of [null, undefined, {}, { createFollowUp: 'not-a-function' }]) {
    await assert.rejects(
      db.transactionAsync(() => bookAppointment(contextFor(service, { followUps }), request)),
      (error) => {
        assert.equal(error.code, 'APPOINTMENTS_REMINDER_UNAVAILABLE');
        assert.equal(error.status, 500);
        return true;
      },
    );
  }
  assert.equal(calls.length, 1, 'the refused replays open no duplicate reminder');
  assert.equal(service.rows.length, 1);
});

test('two connections racing overlapping bookings refuse the loser 409: exactly one row per round', async (t) => {
  // Two worker isolates, each with its own connection to the same file: no
  // process-local chain is shared, so only the handle transaction (SQLite
  // BEGIN IMMEDIATE) can serialize the writers. Without it both reads see an
  // empty slot and both inserts commit.
  const dir = mkdtempSync(join(tmpdir(), 'accordo-appointments-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'race.sqlite');
  const manifest = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'appointments', 'modules', 'appointment.module.json'),
    'utf8',
  ));
  // The table exists before any worker opens the file, so workers never race DDL.
  const setup = createDatabase({
    path: dbPath,
    moduleMigrations: recordModuleMigrations([{ name: 'appointment', manifest }]),
  });
  t.after(() => setup.close());

  const ROUNDS = 5;
  const pad = (n) => String(n).padStart(2, '0');
  const bookingFor = (worker, round) => ({
    sourceKey: `gym:race:r${round}:${worker}`,
    subject: SUBJECT,
    teamMemberId: 'coach-guido',
    serviceKey: 'pt-single',
    priceCents: 4000,
    currency: 'EUR',
    startsAt: `2026-10-20T${pad(17 + round)}:00:00.000Z`,
    endsAt: `2026-10-20T${pad(18 + round)}:00:00.000Z`,
    source: SOURCE,
  });
  const shared = new SharedArrayBuffer(8);
  const barrier = new Int32Array(shared);
  const workerUrl = new URL('./helpers/appointments-race-worker.mjs', import.meta.url);
  const failures = [];
  const inboxes = [[], []];
  const workers = [0, 1].map((index) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        dbPath,
        shared,
        rounds: Array.from({ length: ROUNDS }, (_, round) => bookingFor(index === 0 ? 'a' : 'b', round)),
      },
    });
    worker.on('message', (receipt) => { inboxes[index][receipt.round] = receipt; });
    worker.on('error', (error) => { failures.push(error); });
    worker.on('exit', (code) => {
      if (code !== 0) failures.push(new Error(`race worker ${index} exited with code ${code}`));
    });
    return worker;
  });
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));

  const waitFor = async (what, ready) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (ready()) return;
      if (failures.length > 0) throw failures[0];
      if (Date.now() > deadline) throw new Error(`${what} timed out`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitFor('race workers to become ready', () => Atomics.load(barrier, 0) === 2);

  for (let round = 0; round < ROUNDS; round++) {
    Atomics.store(barrier, 1, round + 1);
    Atomics.notify(barrier, 1);
    await waitFor(`race round ${round}`, () => inboxes[0][round] !== undefined && inboxes[1][round] !== undefined);
    const [a, b] = [inboxes[0][round], inboxes[1][round]];
    assert.equal(
      [a.ok, b.ok].filter(Boolean).length, 1,
      `round ${round}: exactly one writer books (a=${JSON.stringify(a)}, b=${JSON.stringify(b)})`,
    );
    const winner = a.ok ? a : b;
    const loser = a.ok ? b : a;
    assert.equal(winner.replayed, false, `round ${round}: the winner books fresh, never replays`);
    assert.ok(winner.id, `round ${round}: the winner names its row`);
    assert.equal(loser.code, 'APPOINTMENTS_OVERLAP', `round ${round}: the loser names the overlap`);
    assert.equal(loser.status, 409, `round ${round}: the loser is refused 409`);
  }
  const count = setup.raw.prepare('SELECT COUNT(*) AS n FROM appointments').get();
  assert.equal(count.n, ROUNDS, 'exactly one row per round survives the race');
});
