import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createAppointmentBookCapability } from '../packages/appointments/src/appointments.js';
import { createCalendarSyncOperations } from '../packages/calendar-sync/src/sync.js';
import { createCalendarSyncPackage } from '../packages/calendar-sync/src/index.js';
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';

/**
 * Space-grant tests (backlog:43b62d4bcaa3): one calendar syncs under the
 * space's Google grant from the vault. Binding stores the secretRef —
 * never the grant — every provider call resolves it per call through the
 * same custody edge the channel connections use, revoking stops the sync,
 * and no grant, token or provider text lands in a row, an error or a log.
 * No test dials Google.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const ACTOR = { type: 'user', id: 'calendar-grant-kit' };
const SYSTEM = { type: 'system', id: 'calendar-grant-kit' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host', label: 'Presti Group' };
const MEMBER = 'coach-guido';
const SERVICE = { serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR' };
const CAL = 'presti-room-1';
const SPACE = 'presti';
const SECRET_REF = 'vault://presti/google-calendar';
const GRANT = 'grant-vault-value-9f3a7c2e51';
const T0 = new Date('2026-10-20T08:00:00.000Z').getTime();

const slot = (day, from, to) => ({
  start: { dateTime: `2026-10-${day}T${from}:00.000Z` },
  end: { dateTime: `2026-10-${day}T${to}:00.000Z` },
});

function setup(options = {}) {
  const database = createDatabase({ path: ':memory:' });
  const manifests = [
    { name: 'appointment', manifest: manifest('appointments', 'appointment') },
    { name: 'calendar-link', manifest: manifest('calendar-sync', 'calendar-link') },
    { name: 'calendar-sync-state', manifest: manifest('calendar-sync', 'calendar-sync-state') },
  ];
  for (const { sql } of recordModuleMigrations(manifests)) database.raw.exec(sql);
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const { name, manifest: body } of manifests) {
    modules.set(name, { service: createRecordModuleFromManifest(body, { database, audit, events, references: {} }).service });
  }
  let fakeNow = options.nowMs ?? T0;
  const provider = createFakeGoogleCalendar({
    nowMs: () => fakeNow,
    expectedSecret: options.expectedSecret === undefined ? GRANT : options.expectedSecret,
  });
  if (options.providerThrows) {
    const throwing = options.providerThrows;
    provider.listEvents = async () => { throw throwing; };
  }
  const resolveCalls = [];
  const resolveSecret = options.unwired
    ? null
    : async (ref, context) => {
      resolveCalls.push({ ref, context });
      if (ref !== SECRET_REF) {
        const error = new Error('unknown secret reference');
        error.code = 'SECRET_NOT_FOUND';
        throw error;
      }
      return options.grantValue === undefined ? GRANT : options.grantValue;
    };
  const appointmentBook = createAppointmentBookCapability({});
  const mapping = {
    subjectForEvent: () => ({ ...SUBJECT }),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules, appointmentBook, provider, mapping, database,
    actor: ACTOR, now: () => new Date(fakeNow).toISOString(),
    ...(resolveSecret === null ? {} : { resolveSecret }),
  });
  const rows = () => ({
    appointments: [...modules.get('appointment').service.listWhere({})],
    links: [...modules.get('calendar-link').service.listWhere({})],
    states: [...modules.get('calendar-sync-state').service.listWhere({})],
    audit: audit.list({ limit: 500 }).map((row) => row.data),
  });
  return {
    database, modules, provider, sync, mapping, resolveCalls, rows,
    setNow: (ms) => { fakeNow = ms; },
    close: () => database.close(),
  };
}

function seedEvent(ctx, id, day, from, to, extra = {}) {
  return ctx.provider.seedEvent(CAL, { id, summary: `Session ${id}`, ...slot(day, from, to), ...extra });
}

const TIME_MIN = '2026-10-20T00:00:00.000Z';

async function bound(ctx, ref = SECRET_REF) {
  return ctx.sync.bindCalendarGrant({ spaceId: SPACE, calendarId: CAL, secretRef: ref, actor: ACTOR });
}

test('bind refuses a raw grant value: only the vault locator is stored', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await assert.rejects(
    bound(ctx, GRANT),
    (error) => error?.code === 'ValidationError' || /secretRef must be a bounded reference locator/.test(error?.message ?? ''),
  );
  assert.equal(ctx.rows().states.length, 0, 'no binding row for a refused value');
});

test('bind and revoke need a human actor', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await assert.rejects(
    ctx.sync.bindCalendarGrant({ spaceId: SPACE, calendarId: CAL, secretRef: SECRET_REF, actor: SYSTEM }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  await bound(ctx);
  await assert.rejects(
    ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: SYSTEM }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
  );
});

test('a bound calendar imports with the grant resolved from the vault', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const binding = await bound(ctx);
  assert.deepEqual(binding, { calendarId: CAL, spaceId: SPACE, secretRef: SECRET_REF, grantStatus: 'active' });
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  seedEvent(ctx, 'evt2', '21', '11:00', '12:00');
  const first = await ctx.sync.importFuture(CAL, { timeMin: TIME_MIN });
  assert.equal(first.entries.filter((e) => e.status === 'imported').length, 2);
  assert.equal(ctx.rows().appointments.length, 2);
  assert.equal(ctx.resolveCalls.length, 1);
  assert.equal(ctx.resolveCalls[0].ref, SECRET_REF);
  assert.equal(ctx.resolveCalls[0].context.spaceId, SPACE);
  assert.equal(ctx.resolveCalls[0].context.purpose, 'calendar-sync:read');
});

test('the grant resolves per call and never lands in a row', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: TIME_MIN });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.ok(pull.entries.some((e) => e.status === 'applied'));
  assert.ok(ctx.resolveCalls.length >= 2, 'no caching: every provider call resolves again');
  const dump = JSON.stringify(ctx.rows());
  assert.ok(!dump.includes(GRANT), 'the resolved grant is in no row and no audit entry');
  const [state] = ctx.rows().states;
  assert.equal(state.secretRef, SECRET_REF);
  assert.equal(state.grantStatus, 'active');
});

test('a wrong grant refuses with a fixed message and no secret anywhere', async (t) => {
  const ctx = setup({ grantValue: 'wrong-grant-0000' });
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  const failure = await ctx.sync.importFuture(CAL, { timeMin: TIME_MIN }).then(
    () => { throw new Error('import should have refused'); },
    (error) => error,
  );
  assert.equal(failure.code, 'GOOGLE_GRANT_REFUSED');
  assert.ok(!String(failure.message).includes(GRANT), 'fixed message, not provider text');
  assert.ok(!String(failure.message).includes('wrong-grant-0000'));
  assert.ok(!JSON.stringify(ctx.rows()).includes(GRANT));
  assert.ok(!JSON.stringify(ctx.rows()).includes('wrong-grant-0000'));
});

test('a provider error echoing the grant is normalized before rows and callers', async (t) => {
  const echoing = new Error(`google list failed for grant ${GRANT}`);
  echoing.code = 'GOOGLE_LIST_FAILED';
  echoing.status = 502;
  const ctx = setup({ providerThrows: echoing });
  t.after(() => ctx.close());
  await bound(ctx);
  const failure = await ctx.sync.importFuture(CAL, { timeMin: TIME_MIN }).then(
    () => { throw new Error('import should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'GOOGLE_LIST_FAILED');
  assert.ok(!String(failure.message).includes(GRANT), 'callers get a fixed message');
  assert.ok(!JSON.stringify(ctx.rows()).includes(GRANT), 'rows keep no provider text');
});

test('revoke stops import, pull, push and push delivery', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: TIME_MIN });
  const watched = ctx.provider.watch({ calendarId: CAL, token: 'push-bearer-grant' });
  await ctx.sync.watchCalendar(CAL, {
    channelId: watched.channelId, resourceId: watched.resourceId, channelToken: 'push-bearer-grant',
  });
  const revoked = await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  assert.deepEqual(revoked, { calendarId: CAL, grantStatus: 'revoked' });
  for (const call of [
    () => ctx.sync.importFuture(CAL, { timeMin: TIME_MIN }),
    () => ctx.sync.pullIncremental(CAL),
    () => ctx.sync.pushLocalChanges(CAL),
    () => ctx.sync.watchCalendar(CAL, { channelId: 'x', channelToken: 'y' }),
  ]) {
    await assert.rejects(call(), (error) => error?.code === 'CALENDAR_GRANT_REVOKED');
  }
  const row = ctx.rows().appointments[0];
  await assert.rejects(
    ctx.sync.pushAppointment(CAL, row.sourceKey),
    (error) => error?.code === 'CALENDAR_GRANT_REVOKED',
  );
  // The forgotten push channel refuses as unknown: a stale Google push
  // after the revoke can never trigger a pull.
  await assert.rejects(
    ctx.sync.handlePush({ channelId: watched.channelId, channelToken: 'push-bearer-grant', resourceState: 'exists' }),
    (error) => error?.code === 'CALENDAR_PUSH_UNKNOWN_CHANNEL',
  );
  const dump = JSON.stringify(ctx.rows());
  assert.ok(!dump.includes(GRANT), 'no grant at rest after the revoke');
  assert.ok(!dump.includes('push-bearer-grant'), 'no channel token at rest after the revoke');
  const [state] = ctx.rows().states;
  assert.equal(state.grantStatus, 'revoked');
  assert.equal(state.secretRef, SECRET_REF, 'the locator stays for audit; the value never did');
});

test('re-bind after revoke reconnects the calendar', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: TIME_MIN });
  await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  await bound(ctx);
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.ok(pull.entries.some((e) => e.status === 'applied'), 'the reconnected calendar syncs again');
  assert.equal(ctx.rows().states[0].grantStatus, 'active');
});

test('one space never revokes another space grant', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  await assert.rejects(
    ctx.sync.revokeCalendarGrant({ spaceId: 'altro-spazio', calendarId: CAL, actor: ACTOR }),
    (error) => error?.code === 'CALENDAR_GRANT_UNKNOWN',
  );
  assert.equal(ctx.rows().states[0].grantStatus, 'active', 'the grant survives the foreign revoke');
});

test('revoking an unbound calendar refuses instead of inventing a binding', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await assert.rejects(
    ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR }),
    (error) => error?.code === 'CALENDAR_GRANT_UNKNOWN',
  );
});

test('an unbound calendar syncs without any grant, as on main', async (t) => {
  const ctx = setup({ unwired: true, expectedSecret: null });
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  const first = await ctx.sync.importFuture(CAL, { timeMin: TIME_MIN });
  assert.equal(first.entries.filter((e) => e.status === 'imported').length, 1);
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.ok(Array.isArray(pull.entries));
});

test('a bound calendar refuses until the custody edge is wired', async (t) => {
  const ctx = setup({ unwired: true, expectedSecret: null });
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await assert.rejects(
    ctx.sync.importFuture(CAL, { timeMin: TIME_MIN }),
    (error) => error?.code === 'CALENDAR_SECRET_UNWIRED',
  );
});

test('the package factory rejects a non-function custody edge', () => {
  assert.throws(
    () => createCalendarSyncPackage({ resolveSecret: 'vault://presti/google-calendar' }),
    (error) => /resolveSecret must be a function/.test(error?.message ?? ''),
  );
});
