// @ts-check

/**
 * Backoffice BO-F5-02 Reporting (backlog:c3e66b36ddb7) — dashboard numbers.
 *
 * What it must prove:
 * - every pipeline number on the dashboard is read through the declared
 *   metric registry (compileReport/runReport over pipeline_value_by_stage
 *   and pipeline_close_schedule), never an ad-hoc storage query;
 * - periodo/persona filters recalculate every number;
 * - the forecast is labelled heuristic and the "Cosa noto" proposal never
 *   reassigns (there is no write surface: POST answers 404);
 * - the CSV bytes are pinned exactly.
 *
 * Real sqlite (`:memory:`) with hand-computed fixture sums, plus the live
 * HTTP route through createAccordoApp/createHttpServer like tests/api.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../packages/core/src/database.js';
import { ValidationError } from '../packages/core/src/errors.js';
import { compileReport, runReport } from '../packages/analytics/src/compiler.js';
import { METRIC_DEFINITIONS } from '../packages/analytics/src/metric-definitions.js';
import {
  buildChannelBreakdown,
  buildDashboardCsv,
  buildDashboardModel,
  channelWeeksOf,
  dashboardCompilations,
  formatMinor,
  formatMonth,
  monthOf,
  parseDashboardQuery,
  pickTarget,
  shiftMonth,
} from '../packages/analytics/src/dashboard.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

const TS = '2026-09-01T00:00:00.000Z';

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
 * @param {{id: string, stage: string, cents: number, currency: string, owner: string, close: string | null, type?: string}} opportunity
 */
function opportunityRow({ id, stage, cents, currency, owner, close, type = 'new_business' }) {
  return {
    kind: 'insert', table: 'opportunities', values: [
      { column: 'id', value: id }, { column: 'company_id', value: 'c1' },
      { column: 'contact_id', value: null }, { column: 'name', value: id },
      { column: 'type', value: type }, { column: 'value_cents', value: cents },
      { column: 'currency', value: currency }, { column: 'stage', value: stage },
      { column: 'owner', value: owner }, { column: 'expected_close_date', value: close },
      { column: 'created_at', value: TS }, { column: 'updated_at', value: TS },
    ],
  };
}

// Hand-computed fixture (EUR unless noted; expected totals in the header):
// open EUR 26000/6 · won EUR 14000/2 · lost EUR 3000/1 · rate 2/3 ·
// open expected in 2026-10: 14000/2 · won expected in 2026-10: 14000/2 ·
// stale open (past or undated): 3 rows, of which undated 1.
const FIXTURE = [
  { id: 'a1', stage: 'qualification', cents: 10000, currency: 'EUR', owner: 'alice', close: '2026-10-15' },
  { id: 'a2', stage: 'negotiation', cents: 4000, currency: 'EUR', owner: 'alice', close: '2026-10-20' },
  { id: 'a3', stage: 'qualification', cents: 2500, currency: 'EUR', owner: 'bob', close: '2026-09-05' },
  { id: 'a4', stage: 'won', cents: 9000, currency: 'EUR', owner: 'alice', close: '2026-10-10' },
  { id: 'a5', stage: 'lost', cents: 3000, currency: 'EUR', owner: 'alice', close: '2026-10-12' },
  { id: 'a6', stage: 'proposal', cents: 5000, currency: 'USD', owner: 'bob', close: '2026-10-18' },
  { id: 'a7', stage: 'discovery', cents: 1500, currency: 'EUR', owner: 'bob', close: null },
  { id: 'a8', stage: 'negotiation', cents: 6000, currency: 'EUR', owner: 'alice', close: '2026-11-02' },
  { id: 'a9', stage: 'qualification', cents: 2000, currency: 'EUR', owner: 'alice', close: '2026-08-01' },
  { id: 'a10', stage: 'won', cents: 5000, currency: 'EUR', owner: 'bob', close: '2026-10-05' },
];

/** @param {import('node:test').TestContext} t */
function fixtureDatabase(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.storage.sync.execute(companyRow());
  for (const opportunity of FIXTURE) database.storage.sync.execute(opportunityRow(opportunity));
  return database;
}

/** @param {any} database @param {{period: string, owner: string | null, currency: string}} query */
function dashboardResults(database, query) {
  const compiled = dashboardCompilations(query);
  return {
    byStage: runReport(database, compiled.byStage),
    schedule: runReport(database, compiled.schedule),
  };
}

const QUERY_OCT = Object.freeze({ period: '2026-10', owner: null, currency: 'EUR' });

test('pipeline_close_schedule is declared with exact groups and compiles closed', () => {
  const definition = METRIC_DEFINITIONS.pipeline_close_schedule;
  assert.equal(definition.version, 1);
  assert.deepEqual([...definition.groupBy], ['opportunity.owner', 'opportunity.stage', 'opportunity.expectedCloseDate']);
  assert.deepEqual([...definition.partitionBy], ['opportunity.currency']);
  const compiled = dashboardCompilations(QUERY_OCT).schedule;
  assert.equal(compiled.metric, 'pipeline_close_schedule');
  assert.deepEqual(
    [...compiled.descriptor.columns].sort(),
    ['currency', 'expected_close_date', 'owner', 'stage', 'value_cents'],
  );
  assert.deepEqual(compiled.descriptor.where, []);
});

test('schedule fixture sums match hand-computed owner/stage/date groups', (t) => {
  const database = fixtureDatabase(t);
  const result = dashboardResults(database, QUERY_OCT).schedule;
  assert.equal(result.truncated, false);
  const rows = [...result.rows];
  const aliceOct = rows.filter(
    (row) => row['opportunity.owner'] === 'alice' && row['opportunity.expectedCloseDate'] === '2026-10-15',
  );
  assert.equal(aliceOct.length, 1);
  assert.equal(aliceOct[0].totalMinor, 10000);
  assert.equal(aliceOct[0].count, 1);
  const eurRows = rows.filter((row) => row['opportunity.currency'] === 'EUR');
  assert.equal(eurRows.reduce((total, row) => total + row.totalMinor, 0), 26000 + 14000 + 3000);
  assert.equal(eurRows.reduce((total, row) => total + row.count, 0), 9);
});

test('persona filter narrows both reports through the declared owner filter', (t) => {
  const database = fixtureDatabase(t);
  const alice = dashboardResults(database, { period: '2026-10', owner: 'alice', currency: 'EUR' });
  const byStageOwners = new Set([...alice.byStage.rows].map((row) => row['opportunity.stage']));
  assert.ok(byStageOwners.size > 0);
  for (const row of alice.schedule.rows) {
    assert.equal(row['opportunity.owner'], 'alice');
  }
  const model = buildDashboardModel(alice, [], { period: '2026-10', owner: 'alice', currency: 'EUR' }, TS);
  assert.deepEqual(model.owners, ['alice']);
  assert.equal(model.kpis[0].display, formatMinor(22000, 'EUR'));
});

test('undeclared schedule dimensions and hostile filters fail closed', () => {
  const fails = [
    () => compileReport({ metric: 'pipeline_close_schedule', dimensions: ['opportunity.owner'] }),
    () => compileReport({
      metric: 'pipeline_close_schedule',
      dimensions: ['opportunity.owner', 'opportunity.stage', 'opportunity.expectedCloseDate'],
      filters: { 'opportunity.amountMinor': 5 },
    }),
    () => parseDashboardQuery({ period: 'ottobre' }),
    () => parseDashboardQuery({ period: '2026-13' }),
    () => parseDashboardQuery({ period: '2026-10', currency: 'eur' }),
    () => parseDashboardQuery({ period: '2026-10', currency: 'EURO' }),
    // Well-shaped but not ISO: Intl formatting would throw RangeError and
    // turn hostile input into a 500, so the query refuses it as a 400.
    () => parseDashboardQuery({ period: '2026-10', currency: 'ZZZ' }),
    () => parseDashboardQuery({ period: '2026-10', owner: 7 }),
    () => parseDashboardQuery({ period: '2026-10', owner: 'x'.repeat(201) }),
    () => parseDashboardQuery({ period: '2026-10', owner: { eq: 'alice' } }),
  ];
  for (const fn of fails) assert.throws(fn, ValidationError);
});

test('hostile owner travels as a bound value and matches nothing', (t) => {
  const database = fixtureDatabase(t);
  const hostile = 'alice"; DROP TABLE opportunities; --';
  const compiled = dashboardCompilations({ period: '2026-10', owner: hostile, currency: 'EUR' });
  const result = runReport(database, compiled.schedule);
  assert.deepEqual([...result.rows], []);
  assert.equal(
    database.storage.sync.maybeOne({ kind: 'count', table: 'opportunities', where: [] }).n, 10,
    'the opportunities table survives the hostile owner',
  );
});

test('dashboard KPIs match hand-computed totals for 2026-10 EUR', (t) => {
  const database = fixtureDatabase(t);
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.equal(model.period, '2026-10');
  assert.equal(model.owner, null);
  assert.equal(model.currency, 'EUR');
  assert.equal(model.kpis.length, 5);
  const [openValue, openCount, wonPeriod, winRate, closing] = model.kpis;
  assert.equal(openValue.display, formatMinor(26000, 'EUR'));
  assert.equal(openValue.sub, '6 preventivi aperti');
  assert.equal(openCount.display, '6');
  assert.equal(wonPeriod.display, formatMinor(14000, 'EUR'));
  assert.equal(wonPeriod.sub, '2 chiusure');
  assert.equal(winRate.display, '67%');
  assert.equal(winRate.sub, '2 vinte, 1 perse');
  assert.equal(closing.display, formatMinor(14000, 'EUR'));
  assert.equal(closing.sub, '2 preventivi, 1 senza data attesa');
  assert.deepEqual(model.currencies.others, ['USD']);
  assert.equal(model.truncated, false);
  assert.ok(Object.isFrozen(model) && Object.isFrozen(model.kpis) && Object.isFrozen(model.team));
});

test('funnel, monthly chart and team table match hand-computed rows', (t) => {
  const database = fixtureDatabase(t);
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  const funnel = Object.fromEntries(model.funnel.map((entry) => [entry.stage, entry]));
  assert.deepEqual([funnel.discovery.count, funnel.discovery.minor], [1, 1500]);
  assert.deepEqual([funnel.qualification.count, funnel.qualification.minor], [3, 14500]);
  assert.deepEqual([funnel.proposal.count, funnel.proposal.minor], [0, 0]);
  assert.deepEqual([funnel.negotiation.count, funnel.negotiation.minor], [2, 10000]);
  assert.deepEqual([funnel.won.count, funnel.won.minor], [2, 14000]);
  const october = model.monthly.find((entry) => entry.month === '2026-10');
  assert.deepEqual([october.openCount, october.expectedMinor], [2, 14000]);
  assert.deepEqual([october.wonCount, october.wonMinor], [2, 14000]);
  const september = model.monthly.find((entry) => entry.month === '2026-09');
  assert.deepEqual([september.openCount, september.expectedMinor], [1, 2500]);
  assert.equal(model.monthly.length, 6);
  assert.deepEqual(model.owners, ['alice', 'bob']);
  const alice = model.team.find((entry) => entry.owner === 'alice');
  assert.deepEqual([alice.openCount, alice.openMinor], [2, 14000]);
  assert.deepEqual([alice.wonCount, alice.wonMinor], [1, 9000]);
  assert.equal(alice.winRateDisplay, '50%');
  const bob = model.team.find((entry) => entry.owner === 'bob');
  assert.deepEqual([bob.openCount, bob.openMinor], [0, 0]);
  assert.deepEqual([bob.wonCount, bob.wonMinor], [1, 5000]);
  assert.equal(bob.winRateDisplay, '100%');
});

test('team table recalculates with periodo: September differs from October', (t) => {
  const database = fixtureDatabase(t);
  const october = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  const september = buildDashboardModel(
    dashboardResults(database, { period: '2026-09', owner: null, currency: 'EUR' }),
    [],
    { period: '2026-09', owner: null, currency: 'EUR' },
    TS,
  );
  const octoberAlice = october.team.find((entry) => entry.owner === 'alice');
  const septemberAlice = september.team.find((entry) => entry.owner === 'alice');
  assert.deepEqual([octoberAlice.openCount, octoberAlice.openMinor], [2, 14000]);
  // In September alice holds no expected row: zeros, but her stale backlog
  // (one past-dated open row) still names her as its holder.
  assert.deepEqual([septemberAlice.openCount, septemberAlice.openMinor], [0, 0]);
  assert.equal(septemberAlice.staleCount, 1);
  const septemberBob = september.team.find((entry) => entry.owner === 'bob');
  assert.deepEqual([septemberBob.openCount, septemberBob.openMinor], [1, 2500]);
  assert.deepEqual(september.team.map((entry) => entry.owner), ['bob', 'alice']);
});

test('forecast is labelled heuristic with history-weighted probabili', (t) => {
  const database = fixtureDatabase(t);
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.equal(model.forecast.heuristic, true);
  assert.equal(model.forecast.label, 'Stima euristica');
  assert.match(model.forecast.method, /non è una promessa/);
  assert.equal(model.forecast.closedMinor, 14000);
  // 14000 open-in-period × 2/3 historical win rate, rounded.
  assert.equal(model.forecast.probableMinor, 9333);
  assert.equal(model.forecast.bestMinor, 14000);
  assert.equal(model.forecast.targetMinor, null);
  assert.match(model.forecast.note, /Obiettivo non impostato/);
});

test('obiettivo row from the bundle sets the target, never an invented one', (t) => {
  const database = fixtureDatabase(t);
  const results = dashboardResults(database, QUERY_OCT);
  const without = buildDashboardModel(results, [], QUERY_OCT, TS);
  assert.equal(without.forecast.targetMinor, null);
  const rows = [
    { id: 'r1', metric: 'obiettivo', period: '2026-10', value: 2000000, unit: 'EUR' },
    { id: 'r2', metric: 'obiettivo', period: '2026-09', value: 999, unit: 'EUR' },
    { id: 'r3', metric: 'chiamate', period: '2026-10', value: 20, unit: 'call' },
  ];
  const model = buildDashboardModel(results, rows, QUERY_OCT, TS);
  assert.equal(model.forecast.targetMinor, 2000000);
  assert.match(model.forecast.note, /dal bundle reporting/);
  assert.equal(pickTarget('nope', QUERY_OCT), null);
  assert.equal(pickTarget([{ metric: 'obiettivo', period: '2026-10', value: -5, unit: 'EUR' }], QUERY_OCT), null);
});

test('Cosa noto proposes a redistribution that never reassigns by itself', (t) => {
  const database = fixtureDatabase(t);
  const before = database.storage.sync.maybeOne({ kind: 'count', table: 'opportunities', where: [] }).n;
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.ok(model.proposal !== null, 'the fixture earns a redistribution proposal');
  assert.equal(model.proposal.title, 'Proposta di ridistribuzione lead');
  assert.deepEqual(model.proposal.moves.map((move) => [move.from, move.to, move.count]), [['alice', 'bob', 1]]);
  assert.match(model.proposal.note, /non sposta nulla da sola/);
  assert.ok(model.insights.some((entry) => entry.id === 'redistribute'));
  assert.ok(model.insights.some((entry) => entry.id === 'lost-rate'));
  assert.ok(model.insights.some((entry) => entry.id === 'stale'));
  assert.equal(
    database.storage.sync.maybeOne({ kind: 'count', table: 'opportunities', where: [] }).n, before,
    'building the model writes nothing',
  );
});

test('empty space answers honestly: zeros, no-data insight, no proposal', (t) => {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.storage.sync.execute(companyRow());
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.equal(model.kpis[0].display, formatMinor(0, 'EUR'));
  assert.equal(model.kpis[3].display, 'n.d.');
  assert.deepEqual(model.team, []);
  assert.deepEqual(model.owners, []);
  assert.equal(model.proposal, null);
  assert.ok(model.insights.some((entry) => entry.id === 'no-data'));
  assert.equal(model.forecast.probableMinor, 0);
});

test('truncation is disclosed, never a silent partial sum', (t) => {
  const database = fixtureDatabase(t);
  const compiled = dashboardCompilations(QUERY_OCT);
  const byStage = runReport(database, { ...compiled.byStage, descriptor: { ...compiled.byStage.descriptor, limit: 1 } });
  assert.equal(byStage.truncated, true);
  const model = buildDashboardModel({ byStage, schedule: dashboardResults(database, QUERY_OCT).schedule }, [], QUERY_OCT, TS);
  assert.equal(model.truncated, true);
});

test('CSV bytes are pinned exactly', (t) => {
  const database = fixtureDatabase(t);
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.equal(model.csv.filename, 'reporting-2026-10.csv');
  const lines = model.csv.content.split('\n');
  assert.equal(lines[0], 'reporting;2026-10;tutti;EUR');
  assert.ok(lines.includes('persona;preventivi_aperti;valore_aperto_minor;vinte;vinte_minor;perse;tasso'));
  assert.ok(lines.includes('alice;2;14000;1;9000;1;50%'));
  assert.ok(lines.includes('bob;0;0;1;5000;0;100%'));
  assert.ok(lines.includes('qualification;3;14500'));
  assert.ok(lines.includes('probabili_euristica;9333'));
  assert.ok(lines.includes('obiettivo;non_impostato'));
  const hostile = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.equal(hostile.csv.content.endsWith('\n'), true);
});

test('CSV escapes hostile owner keys and persona names the file', (t) => {
  const database = fixtureDatabase(t);
  const model = buildDashboardModel(
    dashboardResults(database, { period: '2026-10', owner: 'alice', currency: 'EUR' }),
    [],
    { period: '2026-10', owner: 'alice', currency: 'EUR' },
    TS,
  );
  assert.equal(model.csv.filename, 'reporting-2026-10-alice.csv');
  const csv = buildDashboardCsv({
    kpis: [], forecast: { closedMinor: 0, probableMinor: 0, bestMinor: 0, targetMinor: null },
    funnel: [{ stage: 'won', count: 1, minor: 5 }],
    team: [{ owner: 'a";b', openCount: 1, openMinor: 1, wonCount: 0, wonMinor: 0, lostCount: 0, winRate: null }],
    query: { period: '2026-10', owner: null, currency: 'EUR' },
  });
  assert.ok(csv.content.includes('"a"";b";1;1;0;0;0;n.d.'), `hostile owner is quoted, got: ${csv.content}`);
});

test('CSV neutralizes formula leaders with a text marker, not just quotes', () => {
  // Quoting alone still exports an executable formula: the spreadsheet
  // strips quotes before interpreting the cell. A hostile owner must decode
  // to text that starts with the `'` marker, never to a bare formula.
  const base = {
    kpis: [], forecast: { closedMinor: 0, probableMinor: 0, bestMinor: 0, targetMinor: null },
    funnel: [{ stage: 'won', count: 1, minor: 5 }],
    query: { period: '2026-10', owner: null, currency: 'EUR' },
  };
  const row = (owner) => ({
    owner, openCount: 1, openMinor: 1, wonCount: 0, wonMinor: 0, lostCount: 0, winRate: null,
  });
  // Decode the first CSV field like a spreadsheet import does: the quotes
  // come off first, so the assertion sees what Excel would interpret.
  const firstField = (line) => {
    if (!line.startsWith('"')) return line.split(';')[0];
    let out = '';
    let index = 1;
    while (index < line.length) {
      if (line[index] === '"') {
        if (line[index + 1] === '"') { out += '"'; index += 2; } else break;
      } else { out += line[index]; index += 1; }
    }
    return out;
  };
  for (const hostile of ['=2+2', '+cmd', '-1+1', '@sum', '\tindented', '\rreturn']) {
    const csv = buildDashboardCsv({ ...base, team: [row(hostile)] });
    const matches = csv.content.split('\n').filter((entry) => entry.includes('1;1;0;0;0'));
    assert.equal(matches.length, 1, `one row survives, got: ${csv.content}`);
    assert.equal(firstField(matches[0]), `'${hostile}`, `hostile owner decodes to text, got: ${csv.content}`);
  }
});

test('CSV header neutralizes the hostile persona echo like any other cell', () => {
  // Regression (rev-agent-crm-343-ed481e78ea29 P1): team/funnel cells went
  // through cell(), but the header interpolated model.query.owner raw, so a
  // hostile owner still exported an executable spreadsheet formula.
  const base = {
    kpis: [], forecast: { closedMinor: 0, probableMinor: 0, bestMinor: 0, targetMinor: null },
    funnel: [], team: [],
  };
  const headerFields = (line) => {
    const fields = [];
    let current = '';
    let index = 0;
    while (index < line.length) {
      if (line[index] === '"') {
        index += 1;
        while (index < line.length) {
          if (line[index] === '"') {
            if (line[index + 1] === '"') { current += '"'; index += 2; } else { index += 1; break; }
          } else { current += line[index]; index += 1; }
        }
      } else if (line[index] === ';') {
        fields.push(current); current = ''; index += 1;
      } else { current += line[index]; index += 1; }
    }
    fields.push(current);
    return fields;
  };
  const hostile = buildDashboardCsv({ ...base, query: { period: '2026-10', owner: '=2+2', currency: 'EUR' } });
  assert.deepEqual(
    headerFields(hostile.content.split('\n')[0]),
    ['reporting', '2026-10', "'=2+2", 'EUR'],
    `hostile persona decodes to text in the header, got: ${hostile.content}`,
  );
  const tricky = buildDashboardCsv({ ...base, query: { period: '2026-10', owner: 'a";b', currency: 'EUR' } });
  assert.deepEqual(
    headerFields(tricky.content.split('\n')[0]),
    ['reporting', '2026-10', 'a";b', 'EUR'],
    `persona with separator and quote stays one column, got: ${tricky.content}`,
  );
});

test('proposal baseline is period-scoped: equal in-period rates propose nothing', () => {
  // Regression: the team rates are accumulated for the queried month, but
  // the baseline was lifetime. With both owners at 90% lifetime and 50% in
  // October, the old mix recommended alice → bob with the nonsense
  // explanation `tasso 50% contro 50%`. The month's own close rate (2/4)
  // matches both owners, so no one is flagged.
  const stage = (stageName, totalMinor, count) => ({
    'opportunity.stage': stageName, 'opportunity.currency': 'EUR', totalMinor, count,
  });
  const dated = (owner, stageName, expectedCloseDate, totalMinor, count) => ({
    'opportunity.owner': owner, 'opportunity.stage': stageName,
    'opportunity.expectedCloseDate': expectedCloseDate, 'opportunity.currency': 'EUR', totalMinor, count,
  });
  const results = {
    byStage: {
      metric: 'pipeline_value_by_stage', metricVersion: 1, truncated: false,
      rows: [stage('won', 180000, 18), stage('lost', 4000, 2)],
    },
    schedule: {
      metric: 'pipeline_close_schedule', metricVersion: 1, truncated: false,
      rows: [
        dated('alice', 'qualification', '2026-10-15', 10000, 2),
        dated('alice', 'won', '2026-10-10', 9000, 1),
        dated('alice', 'lost', '2026-10-12', 3000, 1),
        dated('alice', 'won', '2026-08-05', 80000, 8),
        dated('alice', 'discovery', null, 500, 1),
        dated('bob', 'won', '2026-10-05', 5000, 1),
        dated('bob', 'lost', '2026-10-06', 1000, 1),
        dated('bob', 'won', '2026-08-05', 80000, 8),
      ],
    },
  };
  const model = buildDashboardModel(results, [], { period: '2026-10', owner: null, currency: 'EUR' }, TS);
  const alice = model.team.find((entry) => entry.owner === 'alice');
  const bob = model.team.find((entry) => entry.owner === 'bob');
  assert.deepEqual([alice.openCount, alice.winRateDisplay, alice.staleCount], [2, '50%', 1]);
  assert.deepEqual([bob.openCount, bob.winRateDisplay], [0, '50%']);
  assert.equal(model.proposal, null, 'matching the period baseline proposes nothing');
  assert.ok(model.insights.every((entry) => entry.id !== 'redistribute'));
});

test('query, month and target helpers behave', () => {
  assert.deepEqual({ ...parseDashboardQuery({ period: '2026-10' }) }, { period: '2026-10', owner: null, currency: 'EUR' });
  assert.equal(parseDashboardQuery({ period: '2026-10', owner: '' }).owner, null);
  // A pollution carrier cannot pollute: only the three known keys are read
  // into a fresh frozen object, never copied.
  const carried = parseDashboardQuery(JSON.parse('{"period":"2026-10","__proto__":{"x":1}}'));
  assert.equal(carried.period, '2026-10');
  assert.equal(/** @type {any} */ ({}).x, undefined);
  assert.equal(parseDashboardQuery({ period: '2026-10', owner: 'bob', currency: 'USD' }).owner, 'bob');
  assert.match(parseDashboardQuery({}).period, /^\d{4}-\d{2}$/);
  assert.equal(monthOf('2026-10-15T10:00:00.000Z'), '2026-10');
  assert.equal(monthOf('2026-10'), '2026-10');
  assert.equal(monthOf(null), null);
  assert.equal(monthOf('ieri'), null);
  assert.equal(shiftMonth('2026-10', -1), '2026-09');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(formatMonth('2026-10'), 'ottobre 2026');
  assert.throws(() => formatMinor(100, 'ZZZ'), ValidationError);
});

/** @param {import('node:test').TestContext} t */
async function dashboardServer(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  app.database.storage.sync.execute(companyRow());
  for (const opportunity of FIXTURE) app.database.storage.sync.execute(opportunityRow(opportunity));
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  return { app, baseUrl };
}

/** @param {any} database */
function tableCounts(database) {
  return database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => [
      row.name,
      database.raw.prepare(`SELECT COUNT(*) AS n FROM "${String(row.name).replace(/"/g, '""')}"`).get().n,
    ]);
}

test('GET /api/reporting/dashboard serves the registry model and writes nothing', async (t) => {
  const { app, baseUrl } = await dashboardServer(t);
  const before = tableCounts(app.database);
  const response = await fetch(`${baseUrl}/api/reporting/dashboard?period=2026-10`);
  assert.equal(response.status, 200);
  const model = await response.json();
  assert.equal(model.period, '2026-10');
  assert.equal(model.owner, null);
  assert.equal(model.currency, 'EUR');
  assert.equal(model.kpis.length, 5);
  assert.equal(model.kpis[0].display, formatMinor(26000, 'EUR'));
  assert.equal(model.forecast.heuristic, true);
  assert.equal(model.forecast.label, 'Stima euristica');
  assert.equal(model.forecast.probableMinor, 9333);
  assert.deepEqual(model.owners, ['alice', 'bob']);
  assert.ok(Array.isArray(model.insights) && model.insights.length > 0);
  assert.equal(model.csv.filename, 'reporting-2026-10.csv');
  assert.deepEqual(tableCounts(app.database), before, 'a dashboard read writes nothing');
});

test('dashboard filters recalculate: persona and currency narrow the model', async (t) => {
  const { baseUrl } = await dashboardServer(t);
  const alice = await (await fetch(`${baseUrl}/api/reporting/dashboard?period=2026-10&owner=alice`)).json();
  assert.equal(alice.kpis[0].display, formatMinor(22000, 'EUR'));
  assert.deepEqual(alice.owners, ['alice']);
  const usd = await (await fetch(`${baseUrl}/api/reporting/dashboard?period=2026-10&currency=USD`)).json();
  assert.equal(usd.kpis[0].display, formatMinor(5000, 'USD'));
  assert.deepEqual(usd.owners, ['bob']);
});

test('dashboard query refuses hostile input with a 400 and has no write surface', async (t) => {
  const { baseUrl } = await dashboardServer(t);
  for (const bad of ['period=ottobre', 'period=2026-13', 'currency=eur', 'currency=ZZZ', 'owner=' + 'x'.repeat(201)]) {
    const response = await fetch(`${baseUrl}/api/reporting/dashboard?${bad}`);
    assert.equal(response.status, 400, `query ${bad} must be a 400`);
  }
  const post = await fetch(`${baseUrl}/api/reporting/dashboard?period=2026-10`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 404, 'no POST under /api/reporting/*: the proposal cannot reassign by itself');
});

test('channel weeks open the period month on the Monday of the week with the 1st', () => {
  assert.deepEqual(channelWeeksOf('2026-10'), [
    { week: '2026-09-28', label: '28 set' },
    { week: '2026-10-05', label: '5 ott' },
    { week: '2026-10-12', label: '12 ott' },
    { week: '2026-10-19', label: '19 ott' },
  ]);
  assert.deepEqual(
    channelWeeksOf('2026-06').map((slot) => slot.week),
    ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'],
  );
});

test('channel breakdown counts per channel and week, totals over the shown weeks', () => {
  const breakdown = buildChannelBreakdown(
    [
      { system: 'instagram', week: '2026-10-05', count: 5 },
      { system: 'instagram', week: '2026-10-12', count: 6 },
      { system: 'whatsapp', week: '2026-10-05', count: 3 },
      { system: 'tiktok', week: '2026-11-02', count: 9 },
      { system: 'email', week: null, count: 2 },
    ],
    { period: '2026-10' },
  );
  assert.equal(breakdown.total, 14, 'only the four shown weeks count');
  assert.equal(breakdown.undated, 2, 'dateless identities are named, not dropped');
  const instagram = breakdown.channels.find((entry) => entry.channel === 'instagram');
  assert.deepEqual(instagram.weeks, [0, 5, 6, 0]);
  assert.equal(instagram.total, 11);
  assert.ok(breakdown.channels[0].total >= breakdown.channels[1].total, 'legend sorts by total');
  assert.ok(breakdown.channels.every((entry) => entry.channel !== 'tiktok'), 'outside weeks stay out');
  assert.ok(Object.isFrozen(breakdown) && Object.isFrozen(breakdown.channels));
});

test('the dashboard model carries the channel breakdown, empty when no origins', (t) => {
  const database = fixtureDatabase(t);
  const withOrigins = buildDashboardModel(
    dashboardResults(database, QUERY_OCT),
    [],
    QUERY_OCT,
    TS,
    [
      { system: 'whatsapp', week: '2026-10-05', count: 4 },
      { system: 'instagram', week: '2026-10-12', count: 7 },
    ],
  );
  assert.equal(withOrigins.channels.total, 11);
  assert.deepEqual(
    withOrigins.channels.channels.map((entry) => entry.channel),
    ['instagram', 'whatsapp'],
  );
  const without = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.equal(without.channels.total, 0);
  assert.deepEqual(without.channels.channels, []);
});
