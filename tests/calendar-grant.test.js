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
  const first = await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
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
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL, { spaceId: SPACE });
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
  const failure = await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN }).then(
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
  const failure = await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN }).then(
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
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  const watched = ctx.provider.watch({ calendarId: CAL, token: 'push-bearer-grant' });
  await ctx.sync.watchCalendar(CAL, {
    spaceId: SPACE, channelId: watched.channelId, resourceId: watched.resourceId, channelToken: 'push-bearer-grant',
  });
  const revoked = await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  assert.deepEqual(revoked, { calendarId: CAL, grantStatus: 'revoked' });
  for (const call of [
    () => ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN }),
    () => ctx.sync.pullIncremental(CAL, { spaceId: SPACE }),
    () => ctx.sync.pushLocalChanges(CAL, { spaceId: SPACE }),
    () => ctx.sync.watchCalendar(CAL, { spaceId: SPACE, channelId: 'x', channelToken: 'y' }),
  ]) {
    await assert.rejects(call(), (error) => error?.code === 'CALENDAR_GRANT_REVOKED');
  }
  const row = ctx.rows().appointments[0];
  await assert.rejects(
    ctx.sync.pushAppointment(CAL, row.sourceKey, { spaceId: SPACE }),
    (error) => error?.code === 'CALENDAR_GRANT_REVOKED',
  );
  // The forgotten push channel refuses as unknown: a stale Google push
  // after the revoke can never trigger a pull.
  await assert.rejects(
    ctx.sync.handlePush({ spaceId: SPACE, channelId: watched.channelId, channelToken: 'push-bearer-grant', resourceState: 'exists' }),
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
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  await bound(ctx);
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL, { spaceId: SPACE });
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
    ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN }),
    (error) => error?.code === 'CALENDAR_SECRET_UNWIRED',
  );
});

test('the package factory rejects a non-function custody edge', () => {
  assert.throws(
    () => createCalendarSyncPackage({ resolveSecret: 'vault://presti/google-calendar' }),
    (error) => /resolveSecret must be a function/.test(error?.message ?? ''),
  );
});

test('a foreign space reads a bound calendar as unknown, on every sync path', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  for (const call of [
    () => ctx.sync.importFuture(CAL, { spaceId: 'altro-spazio', timeMin: TIME_MIN }),
    () => ctx.sync.importFuture(CAL, { timeMin: TIME_MIN }),
    () => ctx.sync.pullIncremental(CAL, { spaceId: 'altro-spazio' }),
    () => ctx.sync.pushLocalChanges(CAL, { spaceId: 'altro-spazio' }),
  ]) {
    await assert.rejects(call(), (error) => error?.code === 'CALENDAR_GRANT_UNKNOWN');
  }
  const row = ctx.rows().appointments[0];
  await assert.rejects(
    ctx.sync.pushAppointment(CAL, row.sourceKey, { spaceId: 'altro-spazio' }),
    (error) => error?.code === 'CALENDAR_GRANT_UNKNOWN',
  );
  // The owning space is unaffected: its sync still resolves its own grant.
  const pull = await ctx.sync.pullIncremental(CAL, { spaceId: SPACE });
  assert.ok(Array.isArray(pull.entries));
});

test('one space cannot hijack another space live binding', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  await assert.rejects(
    ctx.sync.bindCalendarGrant({ spaceId: 'altro-spazio', calendarId: CAL, secretRef: SECRET_REF, actor: ACTOR }),
    (error) => error?.code === 'CALENDAR_GRANT_ALREADY_BOUND' && error?.status === 409,
  );
  const [state] = ctx.rows().states;
  assert.equal(state.spaceId, SPACE, 'the binding still belongs to the owning space');
  assert.equal(state.secretRef, SECRET_REF);
  assert.equal(state.grantStatus, 'active');
  // The owning space re-binds freely (secret rotation); the foreign space
  // binds only after the owner revoked.
  await ctx.sync.bindCalendarGrant({ spaceId: SPACE, calendarId: CAL, secretRef: SECRET_REF, actor: ACTOR });
  await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  const rebound = await ctx.sync.bindCalendarGrant({ spaceId: 'altro-spazio', calendarId: CAL, secretRef: SECRET_REF, actor: ACTOR });
  assert.equal(rebound.spaceId, 'altro-spazio');
});

test('a push delivery verifies the channel token before reading grant state', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  const watched = ctx.provider.watch({ calendarId: CAL, token: 'push-bearer-oracle' });
  await ctx.sync.watchCalendar(CAL, {
    spaceId: SPACE, channelId: watched.channelId, resourceId: watched.resourceId, channelToken: 'push-bearer-oracle',
  });
  // A deployment-recorded revocation that keeps the channel registered:
  // an unauthenticated probe still reads 403, never the 409 oracle.
  const [live] = ctx.rows().states;
  await ctx.modules.get('calendar-sync-state').service.applyManaged(live.id, { grantStatus: 'revoked' }, { actor: ACTOR });
  await assert.rejects(
    ctx.sync.handlePush({ spaceId: SPACE, channelId: watched.channelId, channelToken: 'wrong-bearer', resourceState: 'exists' }),
    (error) => error?.code === 'CALENDAR_PUSH_FORBIDDEN',
  );
  await assert.rejects(
    ctx.sync.handlePush({ spaceId: SPACE, channelId: watched.channelId, channelToken: 'push-bearer-oracle', resourceState: 'exists' }),
    (error) => error?.code === 'CALENDAR_GRANT_REVOKED',
  );
  // And a foreign space with the right token reads unknown, not revoked.
  await assert.rejects(
    ctx.sync.handlePush({ spaceId: 'altro-spazio', channelId: watched.channelId, channelToken: 'push-bearer-oracle', resourceState: 'exists' }),
    (error) => error?.code === 'CALENDAR_PUSH_UNKNOWN_CHANNEL',
  );
});

test('watch validates the channel shape before reading grant state', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  await assert.rejects(
    ctx.sync.watchCalendar(CAL, { spaceId: SPACE, channelId: '', channelToken: '' }),
    (error) => error?.code === 'VALIDATION_ERROR',
  );
});

test('an expired sync token carrying a secret is normalized to a fixed message', async (t) => {
  const leaking = new Error(`sync token invalid for grant ${GRANT} (personal data)`);
  leaking.code = 'GOOGLE_SYNC_TOKEN_INVALID';
  leaking.status = 410;
  const ctx = setup({ providerThrows: leaking });
  t.after(() => ctx.close());
  await bound(ctx);
  const failure = await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN }).then(
    () => { throw new Error('import should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'GOOGLE_SYNC_TOKEN_INVALID');
  assert.ok(!String(failure.message).includes(GRANT), 'callers get the fixed message, never provider text');
  assert.ok(!JSON.stringify(ctx.rows()).includes(GRANT), 'rows keep no provider text');
});

test('an expired token mid-pull still reconciles without leaking the secret', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  const realList = ctx.provider.listEvents.bind(ctx.provider);
  let refused = false;
  ctx.provider.listEvents = async (params) => {
    if (!refused && params?.syncToken) {
      refused = true;
      const leaking = new Error(`sync token invalid for grant ${GRANT}`);
      leaking.code = 'GOOGLE_SYNC_TOKEN_INVALID';
      leaking.status = 410;
      throw leaking;
    }
    return realList(params);
  };
  const pull = await ctx.sync.pullIncremental(CAL, { spaceId: SPACE });
  assert.equal(pull.recovered, true, 'the expired token reconciles fully');
  assert.ok(refused, 'the token-invalid branch ran');
  assert.ok(!JSON.stringify(ctx.rows()).includes(GRANT), 'rows keep no provider text');
});

test('a padded calendar id syncs as the bound calendar, never as shadow state', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  const padded = await ctx.sync.importFuture(`  ${CAL}  `, { spaceId: `  ${SPACE}  `, timeMin: TIME_MIN });
  assert.ok(padded.entries.every((e) => e.status === 'already-tracked'), 'the padded variant reads the same row');
  assert.equal(padded.calendarId, CAL, 'the canonical id is answered');
  assert.equal(ctx.rows().states.length, 1, 'no shadow state row for the padded spelling');
  await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  await assert.rejects(
    ctx.sync.importFuture(`  ${CAL}  `, { spaceId: SPACE, timeMin: TIME_MIN }),
    (error) => error?.code === 'CALENDAR_GRANT_REVOKED',
    'the revoke stops the padded variant too',
  );
});

test('the fake reconciles a positional lookup and refuses a malformed one loudly', async (t) => {
  const ctx = setup({ unwired: true, expectedSecret: null });
  t.after(() => ctx.close());
  ctx.provider.insertEvent({
    calendarId: CAL, id: 'evt-pos', summary: 'Positional',
    start: { dateTime: '2026-10-21T09:00:00.000Z' }, end: { dateTime: '2026-10-21T10:00:00.000Z' },
    extendedProperties: { accordoSourceKey: 'pos-key-1' },
  });
  const found = await ctx.provider.findByAccordoSourceKey(CAL, 'pos-key-1');
  assert.ok(found, 'the old positional shape reconciles instead of inserting a duplicate');
  assert.equal(found.extendedProperties.accordoSourceKey, 'pos-key-1');
  const foundObject = await ctx.provider.findByAccordoSourceKey({ calendarId: CAL, sourceKey: 'pos-key-1' });
  assert.ok(foundObject, 'the object shape keeps working');
  assert.throws(
    // @ts-expect-error — the contract needs the locator pair, not a number.
    () => ctx.provider.findByAccordoSourceKey(42),
    (error) => error?.code === 'GOOGLE_CALL_MALFORMED',
    'a malformed lookup refuses instead of returning a silent null',
  );
});
