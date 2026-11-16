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
import { runExternalOperation } from '../packages/core/src/external-operation.js';
import { createExecutionRunStore } from '../packages/core/src/execution-run-store.js';
import { createCalendarSyncOperations } from '../packages/calendar-sync/src/sync.js';
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';

/**
 * Calendar-sync writes through the traced external-operation sequencer
 * (backlog:f7a380e7): every Google-touching call leaves a completed
 * workflow/operation trace row, and a Google push after the channel
 * registration finds its channel. No test dials Google.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const ACTOR = { type: 'user', id: 'trace-kit' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host', label: 'Presti Group' };
const MEMBER = 'coach-guido';
const SERVICE = { serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR' };
const CAL = 'presti-room-1';
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
  const provider = options.provider ?? createFakeGoogleCalendar({ nowMs: () => fakeNow });
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
    ...(options.traced === true ? { runExternal: runExternalOperation } : {}),
  });
  const tracedRuns = () => createExecutionRunStore(database)
    .listRuns({})
    .filter((run) => String(run.workflowName ?? '').startsWith('calendar-sync.'));
  return {
    database, modules, provider, sync, tracedRuns,
    setNow: (ms) => { fakeNow = ms; },
    close: () => database.close(),
  };
}

function seedEvent(ctx, id, day, from, to) {
  return ctx.provider.seedEvent(CAL, { id, summary: `Session ${id}`, ...slot(day, from, to) });
}

test('a Google push after the channel registration finds its channel', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const watched = ctx.provider.watch({ calendarId: CAL, token: 'push-bearer-1' });
  await ctx.sync.watchCalendar(CAL, { channelId: watched.channelId, resourceId: watched.resourceId, channelToken: 'push-bearer-1' });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  let pulled = null;
  ctx.provider.onPush((delivery) => { pulled = delivery; return ctx.sync.handlePush(delivery); });
  const out = await ctx.provider.deliverPush(watched.channelId);
  assert.equal(out.effect, 'pulled');
  assert.equal(pulled.deliveryId, 'fake-delivery-1');
  await assert.rejects(
    ctx.sync.handlePush({ channelId: 'no-such-channel', channelToken: 'push-bearer-1', resourceState: 'exists' }),
    (error) => error.code === 'CALENDAR_PUSH_UNKNOWN_CHANNEL',
  );
});

test('every Google write leaves a completed external-operation trace, with no secret or personal detail', async (t) => {
  const ctx = setup({ traced: true });
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z', actor: ACTOR });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  const { appointment } = await handle.bookAppointment({
    sourceKey: 'gym:trace:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-22T09:00:00.000Z',
    endsAt: '2026-10-22T10:00:00.000Z',
    notes: 'Very personal note that must never land in a trace row',
    source: { package: 'calendar-sync', action: 'probe' },
  });
  const pushed = await ctx.sync.pushAppointment(CAL, appointment.sourceKey, { actor: ACTOR });
  assert.equal(pushed.status, 'exported');
  const runs = ctx.tracedRuns();
  assert.ok(runs.length >= 2, `expected at least an import and an export trace, saw ${runs.length}`);
  for (const run of runs) {
    assert.equal(run.status, 'completed');
  }
  const names = runs.map((run) => run.workflowName);
  assert.ok(names.some((name) => name === 'calendar-sync.google.insertEvent'), `export traced, saw ${names.join(',')}`);
  assert.ok(names.some((name) => name === 'calendar-sync.google.listEvents'), `import traced, saw ${names.join(',')}`);
  const dump = JSON.stringify(runs);
  assert.ok(!dump.includes('Very personal note'), 'no personal detail in any trace row');
  assert.ok(!dump.includes('appointment-book'), 'no grant or bearer material in any trace row');
});

test('a failed Google write keeps its code and leaves a failed trace', async (t) => {
  const failing = Object.create(createFakeGoogleCalendar({ nowMs: () => T0 }));
  failing.insertEvent = async () => {
    const error = new Error('provider exploded');
    error.code = 'GOOGLE_CALL_MALFORMED';
    error.status = 422;
    throw error;
  };
  const ctx = setup({ traced: true, provider: failing });
  t.after(() => ctx.close());
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  const { appointment } = await handle.bookAppointment({
    sourceKey: 'gym:trace:fail:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-22T09:00:00.000Z',
    endsAt: '2026-10-22T10:00:00.000Z',
    source: { package: 'calendar-sync', action: 'probe' },
  });
  await assert.rejects(
    ctx.sync.pushAppointment(CAL, appointment.sourceKey, { actor: ACTOR }),
    (error) => error.code === 'GOOGLE_CALL_MALFORMED' && error.status === 422,
  );
  const failed = ctx.tracedRuns().filter((run) => run.workflowName === 'calendar-sync.google.insertEvent');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'failed');
  assert.ok(!String(failed[0].error ?? '').includes('exploded'), 'no provider text in the failed trace');
});
