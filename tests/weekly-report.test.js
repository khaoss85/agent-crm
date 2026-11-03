// @ts-check

/**
 * Weekly report artifact (backlog:19bf5b6e8d73) — «Report settimanale».
 *
 * What it must prove:
 * - a weekly run publishes a NEW version of the artifact carrying the
 *   Reporting numbers (dashboard model built from the declared metric
 *   registry over real sqlite, never hand-typed totals);
 * - the artifact holds sales, pipeline, channels and appointments with 2–3
 *   observations and one recommended action each;
 * - a missing appointments summary fails closed instead of publishing a
 *   report without appointments.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../packages/core/src/database.js';
import { ValidationError } from '../packages/core/src/errors.js';
import { runReport } from '../packages/analytics/src/compiler.js';
import { dashboardCompilations, buildDashboardModel } from '../packages/analytics/src/dashboard.js';
import {
  WEEKLY_REPORT_ARTIFACT,
  buildWeeklyReport,
  weekKeyOf,
  weekLabelOf,
} from '../packages/analytics/src/weekly-report.js';

const TS = '2026-09-01T00:00:00.000Z';
const MONDAY = '2026-11-02T08:00:00.000Z';
const QUERY = Object.freeze({ period: '2026-10', owner: null, currency: 'EUR' });
const APPOINTMENTS = Object.freeze({ upcoming: 4, done: 5, noShow: 2, cancelled: 1 });

function companyRow() {
  return {
    kind: 'insert', table: 'companies', values: [
      { column: 'id', value: 'c1' }, { column: 'name', value: 'Acme' },
      { column: 'domain', value: null }, { column: 'created_at', value: TS },
      { column: 'updated_at', value: TS },
    ],
  };
}

/**
 * @param {{id: string, stage: string, cents: number, owner: string, close: string | null}} opportunity
 */
function opportunityRow({ id, stage, cents, owner, close }) {
  return {
    kind: 'insert', table: 'opportunities', values: [
      { column: 'id', value: id }, { column: 'company_id', value: 'c1' },
      { column: 'contact_id', value: null }, { column: 'name', value: id },
      { column: 'type', value: 'new_business' }, { column: 'value_cents', value: cents },
      { column: 'currency', value: 'EUR' }, { column: 'stage', value: stage },
      { column: 'owner', value: owner }, { column: 'expected_close_date', value: close },
      { column: 'created_at', value: TS }, { column: 'updated_at', value: TS },
    ],
  };
}

/** @param {import('node:test').TestContext} t */
function fixtureDatabase(t, rows) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.storage.sync.execute(companyRow());
  for (const row of rows) database.storage.sync.execute(opportunityRow(row));
  return database;
}

const FIXTURE = [
  { id: 'a1', stage: 'qualification', cents: 10000, owner: 'alice', close: '2026-10-15' },
  { id: 'a2', stage: 'negotiation', cents: 4000, owner: 'alice', close: '2026-10-20' },
  { id: 'a3', stage: 'won', cents: 9000, owner: 'alice', close: '2026-10-10' },
  { id: 'a4', stage: 'lost', cents: 3000, owner: 'alice', close: '2026-10-12' },
  { id: 'a5', stage: 'discovery', cents: 1500, owner: 'bob', close: null },
];

const ORIGINS = [
  { system: 'whatsapp', week: '2026-10-05', count: 3 },
  { system: 'whatsapp', week: '2026-10-12', count: 2 },
  { system: 'instagram', week: '2026-10-05', count: 1 },
];

/** @param {any} database @param {any} [origins] */
function reportingModel(database, origins = ORIGINS) {
  const compiled = dashboardCompilations(QUERY);
  const results = {
    byStage: runReport(database, compiled.byStage),
    schedule: runReport(database, compiled.schedule),
  };
  return buildDashboardModel(results, [], QUERY, TS, origins);
}

test('weekKeyOf pins the Monday of the week', () => {
  assert.equal(weekKeyOf(MONDAY), '2026-11-02');
  assert.equal(weekKeyOf('2026-11-08T23:59:59.000Z'), '2026-11-02');
  assert.equal(weekLabelOf('2026-11-02'), 'settimana del 2 novembre 2026');
});

test('weekly run publishes version 1 with the Reporting numbers', (t) => {
  const database = fixtureDatabase(t, FIXTURE);
  const dashboard = reportingModel(database);
  const report = buildWeeklyReport({ dashboard, appointments: APPOINTMENTS, nowIso: MONDAY });

  assert.equal(report.artifact, WEEKLY_REPORT_ARTIFACT);
  assert.equal(report.version, 1);
  assert.equal(report.previousVersion, null);
  assert.equal(report.weekKey, '2026-11-02');
  assert.equal(report.updatedAt, MONDAY);
  assert.equal(report.numbers.period, '2026-10');
  assert.equal(report.numbers.currency, 'EUR');
  assert.deepEqual(report.numbers.sales, { count: 1, minor: 9000 });
  assert.deepEqual(report.numbers.lost, { count: 1 });
  assert.deepEqual(report.numbers.pipeline, { count: 3, minor: 15500 });
  assert.deepEqual(report.numbers.appointments, { ...APPOINTMENTS });
  assert.equal(report.numbers.channels.total, 6);
  assert.equal(report.numbers.truncated, false);
  assert.ok(report.summary.includes('1 chiusure'));
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.numbers));
  assert.ok(Object.isFrozen(report.observations));

  assert.ok(report.observations.length >= 2 && report.observations.length <= 3);
  const ids = report.observations.map((entry) => entry.id);
  assert.ok(ids.includes('lost-rate'));
  for (const entry of report.observations) {
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.length > 0);
    assert.equal(typeof entry.action, 'string');
    assert.ok(entry.action.length > 0);
  }
});

test('next weekly run publishes version 2 from the previous one', (t) => {
  const database = fixtureDatabase(t, FIXTURE);
  const dashboard = reportingModel(database);
  const first = buildWeeklyReport({ dashboard, appointments: APPOINTMENTS, nowIso: MONDAY });
  const second = buildWeeklyReport({
    dashboard, appointments: APPOINTMENTS, previous: first, nowIso: '2026-11-09T08:00:00.000Z',
  });
  assert.equal(second.version, 2);
  assert.equal(second.previousVersion, 1);
  assert.equal(second.weekKey, '2026-11-09');
  assert.deepEqual(second.numbers.sales, first.numbers.sales);
  assert.deepEqual(second.numbers.pipeline, first.numbers.pipeline);
});

test('same input twice is the same report', (t) => {
  const database = fixtureDatabase(t, FIXTURE);
  const dashboard = reportingModel(database);
  const first = buildWeeklyReport({ dashboard, appointments: APPOINTMENTS, nowIso: MONDAY });
  const second = buildWeeklyReport({ dashboard, appointments: APPOINTMENTS, nowIso: MONDAY });
  assert.deepEqual(second, first);
});

test('empty Reporting still publishes two honest observations', (t) => {
  const database = fixtureDatabase(t, []);
  const dashboard = reportingModel(database, []);
  const report = buildWeeklyReport({ dashboard, appointments: { upcoming: 0, done: 0, noShow: 0, cancelled: 0 }, nowIso: MONDAY });
  assert.equal(report.version, 1);
  assert.deepEqual(report.numbers.sales, { count: 0, minor: 0 });
  assert.equal(report.observations.length, 2);
  assert.equal(report.observations[0].id, 'no-data');
});

test('missing appointments fails closed instead of a report without them', (t) => {
  const database = fixtureDatabase(t, FIXTURE);
  const dashboard = reportingModel(database);
  assert.throws(
    () => buildWeeklyReport({ dashboard, appointments: null, nowIso: MONDAY }),
    ValidationError,
  );
  assert.throws(
    () => buildWeeklyReport({ dashboard: null, appointments: APPOINTMENTS, nowIso: MONDAY }),
    ValidationError,
  );
});
