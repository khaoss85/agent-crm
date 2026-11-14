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
  channelWeekLabel,
  channelWeeksOf,
  dashboardCompilations,
  dashboardSpecs,
  formatMinor,
  formatMonth,
  monthOf,
  parseDashboardQuery,
  pickTarget,
  shiftMonth,
} from '../packages/analytics/src/dashboard.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { accordoSalesPipeline } from '../packages/pipelines/accordo-sales.js';

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
  // backlog:48993bed7294: version 2 groups by the close date too.
  assert.equal(definition.version, 2);
  assert.deepEqual([...definition.groupBy], ['opportunity.owner', 'opportunity.stage', 'opportunity.expectedCloseDate', 'opportunity.closedAt']);
  assert.deepEqual([...definition.partitionBy], ['opportunity.currency']);
  const compiled = dashboardCompilations(QUERY_OCT).schedule;
  assert.equal(compiled.metric, 'pipeline_close_schedule');
  assert.deepEqual(
    [...compiled.descriptor.columns].sort(),
    ['closed_at', 'currency', 'expected_close_date', 'owner', 'stage', 'value_cents'],
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
  assert.equal(winRate.sub, '2 vinte, 1 persa', 'one lost reads «1 persa» (review #761)');
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
  const november = model.monthly.find((entry) => entry.month === '2026-11');
  assert.deepEqual([november.openCount, november.expectedMinor], [1, 6000]);
  assert.equal(model.monthly.length, 6);
  assert.deepEqual(model.owners, ['alice', 'bob']);
  const alice = model.team.find((entry) => entry.owner === 'alice');
  // backlog:48993bed7294: the open value follows the referente like the
  // Pipeline board — every open offer alice holds (a1, a2, a8, a9) — while
  // won and lost count in the month they closed.
  assert.deepEqual([alice.openCount, alice.openMinor], [4, 22000]);
  assert.deepEqual([alice.wonCount, alice.wonMinor], [1, 9000]);
  assert.equal(alice.winRateDisplay, '50%');
  const bob = model.team.find((entry) => entry.owner === 'bob');
  assert.deepEqual([bob.openCount, bob.openMinor], [2, 4000], 'a3 and the undated a7 (a6 is USD)');
  assert.deepEqual([bob.wonCount, bob.wonMinor], [1, 5000]);
  assert.equal(bob.winRateDisplay, '100%');
});

test('expected closures run from the selected period onward, never the past (backlog:b3d88f6e38ef)', (t) => {
  const database = fixtureDatabase(t);
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.deepEqual(model.monthly.map((entry) => entry.month), [
    '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
  ]);
  for (const entry of model.monthly) {
    assert.ok(entry.month >= '2026-10', `no past bucket, found ${entry.month}`);
  }
  const november = model.monthly.find((entry) => entry.month === '2026-11');
  assert.deepEqual([november.openCount, november.expectedMinor], [1, 6000]);
  const october = model.monthly.find((entry) => entry.month === '2026-10');
  assert.deepEqual([october.openCount, october.expectedMinor], [2, 14000]);
  assert.deepEqual([october.wonCount, october.wonMinor], [2, 14000]);
});

test('team table: the open value follows the referente in every period; won and lost follow the month they closed', (t) => {
  // backlog:48993bed7294 (verifica 13/11: «0 · 0,00 €» for everyone while
  // the Pipeline showed a referente with three open offers, none dated): the
  // open column no longer depends on the expected date.
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
  assert.deepEqual([octoberAlice.openCount, octoberAlice.openMinor], [4, 22000]);
  assert.deepEqual([septemberAlice.openCount, septemberAlice.openMinor], [4, 22000], 'the same open offers in every period');
  assert.deepEqual([octoberAlice.wonCount, octoberAlice.lostCount], [1, 1]);
  assert.deepEqual([septemberAlice.wonCount, septemberAlice.lostCount], [0, 0], 'nothing closed in September');
  assert.equal(septemberAlice.staleCount, 1);
  const septemberBob = september.team.find((entry) => entry.owner === 'bob');
  assert.deepEqual([septemberBob.openCount, septemberBob.openMinor], [2, 4000]);
  // 35c3c897d696: bob's undated offer is in the forecast window, never
  // stale — staleCount shares the global past-dates definition.
  assert.equal(septemberBob.staleCount, 0);
  assert.deepEqual(september.team.map((entry) => entry.owner), ['alice', 'bob']);
});

test('forecast is labelled stima with history-weighted probabili', (t) => {
  const database = fixtureDatabase(t);
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  assert.equal(model.forecast.heuristic, true);
  assert.equal(model.forecast.label, 'Stima');
  assert.match(model.forecast.method, /Non è una promessa/);
  // Review lead #896: 3 decided offers are fewer than 5 — the declared 60%
  // fallback, said, never a «67%» that looks precise.
  assert.match(model.forecast.method, /60% \(stima: poche offerte chiuse, 3 su almeno 5\)/, 'the rate it used, said');
  assert.equal(model.forecast.closedMinor, 14000);
  // backlog:48993bed7294: the open value the month may still close is the
  // open expected in October (14000) plus the undated a7 (1500) — the same
  // window as the Pipeline forecast; × the 60% fallback (3 decided < 5).
  assert.equal(model.forecast.probableMinor, 9300);
  assert.equal(model.forecast.bestMinor, 15500);
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
  assert.equal(model.forecast.note, `Obiettivo ${formatMinor(2000000, 'EUR')}.`);
  assert.match(model.forecast.note, /Obiettivo 20\.000,00\s€\./);
  assert.ok(!/2\.000\.000/.test(model.forecast.note), 'cents are never shown as euros (backlog:1ce3a1f0)');
  assert.ok(!/bundle|kernel|euristica/i.test(model.forecast.note), 'the note speaks user words (backlog:1ce3a1f0)');
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
  assert.ok(lines.includes('alice;4;22000;1;9000;1;50%'));
  assert.ok(lines.includes('bob;2;4000;1;5000;0;100%'));
  assert.ok(lines.includes('qualification;3;14500'));
  assert.ok(lines.includes('probabili_euristica;9300'));
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
  // backlog:48993bed7294: open follows the referente (two in October plus the undated one).
  // 35c3c897d696: stale is past-dated only — the same past-dates definition
  // as the global stale rows — so the undated discovery row is in the
  // forecast window, never stale.
  assert.deepEqual([alice.openCount, alice.winRateDisplay, alice.staleCount], [3, '50%', 0]);
  assert.deepEqual([bob.openCount, bob.winRateDisplay], [0, '50%']);
  assert.equal(model.proposal, null, 'matching the period baseline proposes nothing');
  assert.ok(model.insights.every((entry) => entry.id !== 'redistribute'));
});

test('query, month and target helpers behave', () => {
  assert.deepEqual({ ...parseDashboardQuery({ period: '2026-10' }) }, { period: '2026-10', owner: null, currency: 'EUR', pipeline: null });
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
  // 35c3c897d696: same month validation as the Pipeline board — an
  // impossible calendar month is no date, like an absent one.
  assert.equal(monthOf('2026-13-15'), null);
  assert.equal(monthOf('2026-00-10'), null);
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
  assert.equal(model.forecast.label, 'Stima');
  assert.equal(model.forecast.probableMinor, 9300);
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

test('776cf3469e64: nel mese in corso le settimane del grafico finiscono a oggi', () => {
  // Sabato 14 novembre 2026: niente settimana futura 16–22 nov in coda.
  assert.deepEqual(
    channelWeeksOf('2026-11', '2026-11-14T10:00:00.000Z').map((slot) => slot.week),
    ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'],
  );
  // A inizio mese la quarta è la settimana di oggi, a fine mese anche.
  assert.deepEqual(
    channelWeeksOf('2026-11', '2026-11-02T10:00:00.000Z').map((slot) => slot.week),
    ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'],
  );
  assert.deepEqual(
    channelWeeksOf('2026-11', '2026-11-30T10:00:00.000Z').map((slot) => slot.week),
    ['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'],
  );
  // Un mese passato tiene le settimane di apertura, anche con oggi fissato.
  assert.deepEqual(
    channelWeeksOf('2026-10', '2026-11-14T10:00:00.000Z').map((slot) => slot.week),
    ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'],
  );
  // Senza oggi, o con un oggi illeggibile: le settimane di apertura, come prima.
  assert.deepEqual(
    channelWeeksOf('2026-11').map((slot) => slot.week),
    ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'],
  );
  assert.deepEqual(
    channelWeeksOf('2026-11', 'non-una-data').map((slot) => slot.week),
    ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'],
  );
});

test('776cf3469e64: la ripartizione conta solo le settimane fino a oggi nel mese in corso', () => {
  const breakdown = buildChannelBreakdown(
    [
      { system: 'instagram', week: '2026-11-16', count: 5 },
      { system: 'whatsapp', week: '2026-11-09', count: 3 },
    ],
    { period: '2026-11' },
    '2026-11-14T10:00:00.000Z',
  );
  assert.deepEqual(breakdown.weeks.map((slot) => slot.week), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
  assert.equal(breakdown.total, 3, 'la settimana futura non si conta');
  assert.deepEqual(breakdown.channels.map((entry) => entry.channel), ['whatsapp']);
});

test('channel week labels pin UTC so a western timezone keeps the Monday', () => {
  assert.equal(channelWeekLabel('2026-09-28'), '28 set');
  assert.equal(channelWeekLabel('2026-10-05'), '5 ott');
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

// Backlog 099c41c32355 — Reporting like the Pipeline board. Production
// offers carry the legacy core `stage` (create defaults it to
// `qualification`, a move-stage never touches it) next to the placement the
// board shows. The fixture below mirrors that split: every core stage reads
// `qualification`, the placement spreads over accordo-sales. The dashboard in
// pipeline mode must answer with the board's phases, open count and total —
// never with the legacy pile-up.

/**
 * @param {{id: string, stage?: string, pipelineKey?: string | null, pipelineStage?: string | null, cents: number, currency: string, owner: string, close: string | null}} opportunity
 */
function placedOpportunityRow({ id, stage = 'qualification', pipelineKey = 'accordo-sales', pipelineStage = 'richiesta-info', cents, currency, owner, close }) {
  return {
    kind: 'insert', table: 'opportunities', values: [
      { column: 'id', value: id }, { column: 'company_id', value: 'c1' },
      { column: 'contact_id', value: null }, { column: 'name', value: id },
      { column: 'type', value: 'new_business' }, { column: 'value_cents', value: cents },
      { column: 'currency', value: currency }, { column: 'stage', value: stage },
      { column: 'pipeline_key', value: pipelineKey }, { column: 'pipeline_stage', value: pipelineStage },
      { column: 'owner', value: owner }, { column: 'expected_close_date', value: close },
      { column: 'created_at', value: TS }, { column: 'updated_at', value: TS },
    ],
  };
}

// Hand-computed (EUR): placed and on-definition p1..p5 hold 32000/5; open
// (richiesta-info, prova, proposta) p1..p3 hold 20000/3; pagato p4 9000/1;
// perso p5 3000/1; rate 1/2. p6 is USD, p7 never placed, p8 drifted off the
// definition — the board shows none of the three in its columns or totals.
const PLACED_FIXTURE = [
  { id: 'p1', pipelineStage: 'richiesta-info', cents: 10000, currency: 'EUR', owner: 'alice', close: '2026-10-15' },
  { id: 'p2', pipelineStage: 'prova', cents: 4000, currency: 'EUR', owner: 'alice', close: '2026-10-20' },
  { id: 'p3', pipelineStage: 'proposta', cents: 6000, currency: 'EUR', owner: 'bob', close: '2026-11-02' },
  { id: 'p4', pipelineStage: 'pagato', cents: 9000, currency: 'EUR', owner: 'alice', close: '2026-10-10' },
  { id: 'p5', pipelineStage: 'perso', cents: 3000, currency: 'EUR', owner: 'alice', close: '2026-10-12' },
  { id: 'p6', pipelineStage: 'richiesta-info', cents: 5000, currency: 'USD', owner: 'bob', close: '2026-10-18' },
  { id: 'p7', pipelineKey: null, pipelineStage: null, cents: 7000, currency: 'EUR', owner: 'bob', close: '2026-10-19' },
  { id: 'p8', pipelineStage: 'sopralluogo', cents: 8000, currency: 'EUR', owner: 'alice', close: '2026-10-21' },
];

const QUERY_PIPELINE_OCT = Object.freeze({ period: '2026-10', owner: null, currency: 'EUR', pipeline: 'accordo-sales' });

/** @param {import('node:test').TestContext} t */
function placedFixtureDatabase(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.storage.sync.execute(companyRow());
  for (const opportunity of PLACED_FIXTURE) database.storage.sync.execute(placedOpportunityRow(opportunity));
  return database;
}

/** @param {any} database @param {{period: string, owner: string | null, currency: string, pipeline?: string | null}} query */
function pipelineDashboardResults(database, query) {
  const compiled = dashboardCompilations(query);
  return {
    byStage: runReport(database, compiled.byStage),
    schedule: runReport(database, compiled.schedule),
  };
}

test('pipeline specs group by placement, scoped to the pipeline key', () => {
  const specs = dashboardSpecs(QUERY_PIPELINE_OCT);
  assert.equal(specs.byStage.metric, 'pipeline_value_by_pipeline_stage');
  assert.deepEqual([...specs.byStage.dimensions], ['opportunity.pipelineStage']);
  assert.deepEqual({ ...specs.byStage.filters }, { 'opportunity.pipelineKey': 'accordo-sales' });
  assert.equal(specs.schedule.metric, 'pipeline_close_schedule_by_pipeline');
  assert.deepEqual(
    [...specs.schedule.dimensions],
    ['opportunity.owner', 'opportunity.pipelineStage', 'opportunity.expectedCloseDate', 'opportunity.closedAt'],
  );
  const compiled = dashboardCompilations(QUERY_PIPELINE_OCT);
  assert.equal(compiled.byStage.metric, 'pipeline_value_by_pipeline_stage');
  assert.deepEqual(
    [...compiled.byStage.descriptor.columns].sort(),
    ['currency', 'pipeline_stage', 'value_cents'],
  );
  assert.deepEqual(
    [...compiled.schedule.descriptor.columns].sort(),
    ['closed_at', 'currency', 'expected_close_date', 'owner', 'pipeline_stage', 'value_cents'],
  );
  assert.deepEqual(compiled.schedule.descriptor.where, [
    { column: 'pipeline_key', op: 'eq', value: 'accordo-sales' },
  ]);
});

test('pipeline dashboard names the board phases with the board counts and total', (t) => {
  const database = placedFixtureDatabase(t);
  const results = pipelineDashboardResults(database, QUERY_PIPELINE_OCT);
  assert.equal(results.byStage.truncated, false);
  assert.equal(results.schedule.truncated, false);
  const model = buildDashboardModel(results, [], QUERY_PIPELINE_OCT, TS, [], [accordoSalesPipeline]);
  // Same phase names as the board columns, in board order (open, then paid).
  assert.deepEqual(model.funnel.map((entry) => [entry.stage, entry.label, entry.count, entry.minor]), [
    ['richiesta-info', 'Richiesta info', 1, 10000],
    ['prova', 'Prova', 1, 4000],
    ['proposta', 'Proposta', 1, 6000],
    ['pagato', 'Pagato', 1, 9000],
  ]);
  assert.deepEqual(model.valueByStage.map((entry) => [entry.stage, entry.label, entry.count, entry.minor]), [
    ['richiesta-info', 'Richiesta info', 1, 10000],
    ['prova', 'Prova', 1, 4000],
    ['proposta', 'Proposta', 1, 6000],
  ]);
  // Same open offers and total as the board's working columns (USD, the
  // never-placed row and the drifted row stay out, like on the board).
  const [openValue, openCount, wonPeriod, winRate] = model.kpis;
  assert.equal(openValue.display, formatMinor(20000, 'EUR'));
  assert.equal(openValue.sub, '3 preventivi aperti');
  assert.equal(openCount.display, '3');
  assert.equal(openCount.sub, formatMinor(20000, 'EUR'));
  assert.equal(wonPeriod.display, formatMinor(9000, 'EUR'));
  assert.equal(winRate.display, '50%');
  assert.equal(winRate.sub, '1 vinta, 1 persa');
  assert.deepEqual(model.currencies.others, ['USD']);
  // Parity with the board's own counting rule over the same rows: placed on
  // this pipeline, on-definition, open type.
  const stageKeys = new Set(accordoSalesPipeline.stages.map((stage) => stage.key));
  const openTypes = new Set(
    accordoSalesPipeline.stages.filter((stage) => stage.type === 'open' || stage.type === 'renewal').map((stage) => stage.key),
  );
  const boardOpen = PLACED_FIXTURE.filter(
    (row) => row.currency === 'EUR'
      && (row.pipelineKey ?? 'accordo-sales') === 'accordo-sales'
      && typeof row.pipelineStage === 'string'
      && stageKeys.has(row.pipelineStage)
      && openTypes.has(row.pipelineStage),
  );
  assert.equal(openCount.display, String(boardOpen.length));
  assert.equal(openValue.display, formatMinor(boardOpen.reduce((total, row) => total + row.cents, 0), 'EUR'));
});

test('pipeline dashboard recalculates with persona, like the board filters', (t) => {
  const database = placedFixtureDatabase(t);
  const query = { period: '2026-10', owner: 'alice', currency: 'EUR', pipeline: 'accordo-sales' };
  const model = buildDashboardModel(pipelineDashboardResults(database, query), [], query, TS, [], [accordoSalesPipeline]);
  const [, openCount, , winRate] = model.kpis;
  assert.equal(openCount.display, '2');
  assert.equal(openCount.sub, formatMinor(14000, 'EUR'));
  assert.deepEqual(model.owners, ['alice']);
  assert.equal(winRate.display, '50%');
  const funnel = Object.fromEntries(model.funnel.map((entry) => [entry.stage, entry]));
  assert.deepEqual([funnel['richiesta-info'].count, funnel.prova.count, funnel.proposta.count, funnel.pagato.count], [1, 1, 0, 1]);
});

test('without a pipeline the legacy core grouping still answers as before', (t) => {
  const database = placedFixtureDatabase(t);
  // Same rows, no pipeline: every core stage reads `qualification`, so the
  // dashboard piles all 7 EUR offers (placed, unplaced and drifted) under one
  // legacy label — the pile-up the pipeline mode above replaces.
  const model = buildDashboardModel(dashboardResults(database, QUERY_OCT), [], QUERY_OCT, TS);
  const [openValue, openCount] = model.kpis;
  assert.equal(openCount.display, '7');
  assert.equal(openValue.display, formatMinor(47000, 'EUR'));
  const funnel = Object.fromEntries(model.funnel.map((entry) => [entry.stage, entry]));
  assert.equal(funnel.qualification.label, 'Qualifica');
  assert.deepEqual([funnel.qualification.count, funnel.qualification.minor], [7, 47000]);
});

test('dashboard query refuses a hostile pipeline name with a 400', () => {
  assert.equal(parseDashboardQuery({ period: '2026-10', pipeline: null }).pipeline, null);
  assert.equal(parseDashboardQuery({ period: '2026-10', pipeline: '' }).pipeline, null);
  assert.equal(parseDashboardQuery({ period: '2026-10', pipeline: 'accordo-sales' }).pipeline, 'accordo-sales');
  for (const bad of ['Accordo-Sales', '../x', 'a b', 'x'.repeat(201)]) {
    assert.throws(() => parseDashboardQuery({ period: '2026-10', pipeline: bad }), ValidationError);
  }
});

// backlog:48993bed7294 (verifica 13/11 16:47Z e 20:49Z, spazio di test,
// novembre 2026): the pilot's offers carry no expected date; the paid one
// and the lost one closed on 7 nov. Reporting read «Vinte in novembre
// 0,00 €», «Chiuse 0,00 €», «0 · 0,00 €» for every person and «1
// preventivi persi»: every number was windowed on the expected date. The
// rows below are the pilot's, in the registry's shape.
test('48993bed7294: the pilot month — won by close date, open by referente, one rule with the Pipeline forecast', () => {
  const query = Object.freeze({ period: '2026-11', owner: null, currency: 'EUR', pipeline: 'accordo-sales' });
  const row = (owner, stage, totalMinor, closedAt = null) => ({
    'opportunity.owner': owner, 'opportunity.pipelineStage': stage, 'opportunity.expectedCloseDate': null,
    'opportunity.closedAt': closedAt, 'opportunity.currency': 'EUR', totalMinor, count: 1,
  });
  const schedule = [
    row('daniele', 'proposta', 100), row('daniele', 'prova', 1500), row('daniele', 'richiesta-info', 1500),
    row('daniele', 'richiesta-info', 1500), row('marco', 'proposta', 1500), row('marco', 'proposta', 35000),
    row('marco', 'richiesta-info', 1500),
    row('marco', 'perso', 35000, '2026-11-07T10:00:00.000Z'), row('marco', 'pagato', 35000, '2026-11-07T11:00:00.000Z'),
    row('', 'prova', 2500),
  ];
  const byStage = [];
  for (const entry of schedule) {
    const found = byStage.find((item) => item['opportunity.pipelineStage'] === entry['opportunity.pipelineStage']);
    if (found) { found.totalMinor += entry.totalMinor; found.count += 1; } else {
      byStage.push({ 'opportunity.pipelineStage': entry['opportunity.pipelineStage'], 'opportunity.currency': 'EUR', totalMinor: entry.totalMinor, count: 1 });
    }
  }
  const model = buildDashboardModel(
    { byStage: { rows: byStage }, schedule: { rows: schedule } }, [], query, TS, [], [accordoSalesPipeline],
  );
  const kpi = (id) => model.kpis.find((entry) => entry.id === id);
  assert.equal(kpi('won-period').display, formatMinor(35000, 'EUR'), '«Vinte in novembre» counts the offer paid on 7 nov');
  assert.equal(model.forecast.closedMinor, 35000, '«Chiuse» too');
  // Open, undated: 100 + 1500×4 + 35000 + 1500 + 2500 (no referente) = 45100; rate 1 won / 2 decided.
  assert.equal(model.forecast.bestMinor, 45100);
  // Review lead #896: 2 decided offers are too few for a rate — the 60%
  // fallback, said, the same the Pipeline prints (350 + 60% × 426 on the board).
  assert.equal(model.forecast.probableMinor, 27060, '60% of the open expected this month or undated');
  assert.match(model.forecast.method, /più il 60% \(stima: poche offerte chiuse, 2 su almeno 5\)/);
  const marco = model.team.find((entry) => entry.owner === 'marco');
  assert.deepEqual([marco.openCount, marco.openMinor, marco.wonCount, marco.wonMinor, marco.lostCount], [3, 38000, 1, 35000, 1],
    'the referente holds his three open offers (15+350+15 €), like the Pipeline');
  const nobody = model.team.at(-1);
  assert.deepEqual([nobody.owner, nobody.openCount, nobody.openMinor], ['', 1, 2500], 'offers without a referente close the table');
  assert.deepEqual(model.owners, ['marco', 'daniele'], '«senza referente» is no persona to filter by');
  const lostRate = model.insights.find((entry) => entry.id === 'lost-rate');
  assert.match(lostRate.text, /^1 preventivo perso su 2 chiusi \(50%\)/, '«1 preventivo perso», never «1 preventivi persi»');
  const monthly = model.monthly.find((entry) => entry.month === '2026-11');
  assert.deepEqual([monthly.wonCount, monthly.wonMinor], [1, 35000], 'the month chart counts the paid offer in November');
});

test('48993bed7294 (review lead #896): from five decided offers the historical rate drives the forecast', () => {
  const query = Object.freeze({ period: '2026-11', owner: null, currency: 'EUR', pipeline: 'accordo-sales' });
  const row = (stage, totalMinor, closedAt = null) => ({
    'opportunity.owner': 'marco', 'opportunity.pipelineStage': stage, 'opportunity.expectedCloseDate': null,
    'opportunity.closedAt': closedAt, 'opportunity.currency': 'EUR', totalMinor, count: 1,
  });
  const at = '2026-10-02T10:00:00.000Z';
  const schedule = [row('proposta', 10000), row('pagato', 1, at), row('pagato', 1, at), row('pagato', 1, at), row('pagato', 1, at), row('perso', 1, at)];
  const byStage = [
    { 'opportunity.pipelineStage': 'proposta', 'opportunity.currency': 'EUR', totalMinor: 10000, count: 1 },
    { 'opportunity.pipelineStage': 'pagato', 'opportunity.currency': 'EUR', totalMinor: 4, count: 4 },
    { 'opportunity.pipelineStage': 'perso', 'opportunity.currency': 'EUR', totalMinor: 1, count: 1 },
  ];
  const model = buildDashboardModel({ byStage: { rows: byStage }, schedule: { rows: schedule } }, [], query, TS, [], [accordoSalesPipeline]);
  assert.equal(model.forecast.rateSource, 'history');
  assert.equal(model.forecast.probableMinor, 8000, '4 won of 5 decided: 80% of 100 €');
  assert.match(model.forecast.method, /più il 80% \(tasso di chiusura storico\)/);
  const four = buildDashboardModel({ byStage: { rows: byStage.slice(0, 2) }, schedule: { rows: schedule.slice(0, 5) } }, [], query, TS, [], [accordoSalesPipeline]);
  assert.equal(four.forecast.rateSource, 'fallback', 'four decided are still too few');
  assert.equal(four.forecast.probableMinor, 6000);
});

// Review Muse #896 giro 1: «senza referente» is nobody to redistribute from
// or to; undated open offers are in the forecast, so only past-dated ones
// are called stale.
test('48993bed7294: no proposal from or to «senza referente»; only past-dated offers are stale', () => {
  const query = Object.freeze({ period: '2026-11', owner: null, currency: 'EUR', pipeline: 'accordo-sales' });
  const row = (owner, stage, totalMinor, { closedAt = null, expected = null } = {}) => ({
    'opportunity.owner': owner, 'opportunity.pipelineStage': stage, 'opportunity.expectedCloseDate': expected,
    'opportunity.closedAt': closedAt, 'opportunity.currency': 'EUR', totalMinor, count: 1,
  });
  const at = '2026-11-03T10:00:00.000Z';
  const schedule = [
    row('', 'proposta', 1000), row('', 'proposta', 1000), row('', 'perso', 1, { closedAt: at }),
    row('marco', 'proposta', 1000, { expected: '2026-09-10' }), row('marco', 'pagato', 1, { closedAt: at }),
  ];
  const byStage = [
    { 'opportunity.pipelineStage': 'proposta', 'opportunity.currency': 'EUR', totalMinor: 3000, count: 3 },
    { 'opportunity.pipelineStage': 'perso', 'opportunity.currency': 'EUR', totalMinor: 1, count: 1 },
    { 'opportunity.pipelineStage': 'pagato', 'opportunity.currency': 'EUR', totalMinor: 1, count: 1 },
  ];
  const model = buildDashboardModel({ byStage: { rows: byStage }, schedule: { rows: schedule } }, [], query, TS, [], [accordoSalesPipeline]);
  assert.equal(model.proposal, null, 'never a move from or to nobody');
  assert.ok(model.insights.every((entry) => entry.id !== 'redistribute'));
  const stale = model.insights.find((entry) => entry.id === 'stale');
  assert.match(stale.text, /^1 preventivo aperto con la data di chiusura attesa già passata/, 'the two undated offers are in the forecast, not stale');
  assert.equal(model.forecast.bestMinor, 2000, 'the undated ones are the forecast window');
});
