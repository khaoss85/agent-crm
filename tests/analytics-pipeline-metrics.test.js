// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../packages/core/src/database.js';
import { ValidationError } from '../packages/core/src/errors.js';
import { compileReport, runReport } from '../packages/analytics/src/compiler.js';
import { PIPELINE_SEMANTIC_MODEL } from '../packages/analytics/src/semantic-model.js';
import { METRIC_DEFINITIONS } from '../packages/analytics/src/metric-definitions.js';

/**
 * Analytics Studio M16, first increment: declared pipeline metrics on M8 data
 * plus the safe query compiler, with fixture correctness tests.
 *
 * The fixture is six opportunities across two currencies and five stages with
 * hand-computed sums. The metric contract under test: sums in integer minor
 * units, partitioned by currency (never mixed), grouped by stage, every row
 * explainable by definition version, truncation disclosed, and every
 * undeclared name refused before storage is touched.
 */

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

/** @param {{id: string, stage: string, cents: number, currency: string, owner?: string, type?: string}} opportunity */
function opportunityRow({ id, stage, cents, currency, owner = 'alice', type = 'new_business' }) {
  return {
    kind: 'insert', table: 'opportunities', values: [
      { column: 'id', value: id }, { column: 'company_id', value: 'c1' },
      { column: 'contact_id', value: null }, { column: 'name', value: id },
      { column: 'type', value: type }, { column: 'value_cents', value: cents },
      { column: 'currency', value: currency }, { column: 'stage', value: stage },
      { column: 'owner', value: owner }, { column: 'expected_close_date', value: null },
      { column: 'created_at', value: TS }, { column: 'updated_at', value: TS },
    ],
  };
}

const FIXTURE = [
  { id: 'o1', stage: 'qualification', cents: 10000, currency: 'EUR', owner: 'alice' },
  { id: 'o2', stage: 'qualification', cents: 2500, currency: 'EUR', owner: 'bob', type: 'renewal' },
  { id: 'o3', stage: 'negotiation', cents: 4000, currency: 'EUR', owner: 'alice' },
  { id: 'o4', stage: 'won', cents: 9000, currency: 'EUR', owner: 'alice' },
  { id: 'o5', stage: 'proposal', cents: 5000, currency: 'USD', owner: 'alice' },
  { id: 'o6', stage: 'lost', cents: 7000, currency: 'USD', owner: 'bob' },
];

const EXPECTED_ALL = [
  { 'opportunity.currency': 'EUR', 'opportunity.stage': 'negotiation', totalMinor: 4000, count: 1 },
  { 'opportunity.currency': 'EUR', 'opportunity.stage': 'qualification', totalMinor: 12500, count: 2 },
  { 'opportunity.currency': 'EUR', 'opportunity.stage': 'won', totalMinor: 9000, count: 1 },
  { 'opportunity.currency': 'USD', 'opportunity.stage': 'lost', totalMinor: 7000, count: 1 },
  { 'opportunity.currency': 'USD', 'opportunity.stage': 'proposal', totalMinor: 5000, count: 1 },
];

/** @param {import('node:test').TestContext} t */
function fixtureDatabase(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.storage.sync.execute(companyRow());
  for (const opportunity of FIXTURE) database.storage.sync.execute(opportunityRow(opportunity));
  return database;
}

test('pipeline_value_by_stage compiles to a closed descriptor with a row bound', () => {
  const compiled = compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'] });
  assert.equal(compiled.metric, 'pipeline_value_by_stage');
  assert.equal(compiled.metricVersion, 1);
  assert.equal(compiled.modelVersion, PIPELINE_SEMANTIC_MODEL.version);
  assert.equal(compiled.descriptor.kind, 'select');
  assert.equal(compiled.descriptor.table, 'opportunities');
  assert.deepEqual([...compiled.descriptor.columns].sort(), ['currency', 'stage', 'value_cents']);
  assert.deepEqual(compiled.descriptor.where, []);
  assert.equal(compiled.descriptor.limit, METRIC_DEFINITIONS.pipeline_value_by_stage.rowCap);
  assert.ok(compiled.descriptor.orderBy.length > 0, 'fetch order is declared, never physical');
  // The descriptor is data: no functions, and agent input travels as values.
  assert.equal(JSON.stringify(compiled.descriptor).includes('function'), false);
});

test('fixture sums match hand-computed totals, partitioned by currency', (t) => {
  const database = fixtureDatabase(t);
  const result = runReport(database, compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'] }));
  assert.equal(result.metricVersion, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual([...result.rows], EXPECTED_ALL);
});

test('filters narrow the fetch: currency eq, type in-list, owner scalar', (t) => {
  const database = fixtureDatabase(t);
  const eur = runReport(database, compileReport({
    metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
    filters: { 'opportunity.currency': 'EUR' },
  }));
  assert.deepEqual([...eur.rows], EXPECTED_ALL.filter((row) => row['opportunity.currency'] === 'EUR'));

  const renewals = runReport(database, compileReport({
    metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
    filters: { 'opportunity.type': { in: ['renewal'] } },
  }));
  assert.deepEqual([...renewals.rows], [
    { 'opportunity.currency': 'EUR', 'opportunity.stage': 'qualification', totalMinor: 2500, count: 1 },
  ]);

  const bobs = runReport(database, compileReport({
    metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
    filters: { 'opportunity.owner': { eq: 'bob' } },
  }));
  assert.deepEqual([...bobs.rows], [
    { 'opportunity.currency': 'EUR', 'opportunity.stage': 'qualification', totalMinor: 2500, count: 1 },
    { 'opportunity.currency': 'USD', 'opportunity.stage': 'lost', totalMinor: 7000, count: 1 },
  ]);
});

test('the row bound discloses truncation instead of silently partial sums', (t) => {
  const database = fixtureDatabase(t);
  const result = runReport(database, compileReport({
    metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'], limit: 2,
  }));
  assert.equal(result.truncated, true);
  // The bound slices fetched rows, not groups: EUR/negotiation (whole) plus
  // the first EUR/qualification row in fetch order — a disclosed partial sum.
  assert.deepEqual([...result.rows], [
    { 'opportunity.currency': 'EUR', 'opportunity.stage': 'negotiation', totalMinor: 4000, count: 1 },
    { 'opportunity.currency': 'EUR', 'opportunity.stage': 'qualification', totalMinor: 10000, count: 1 },
  ]);
});

test('hostile input travels as a bound value, never as SQL text', (t) => {
  const database = fixtureDatabase(t);
  const hostile = 'qualification"; DROP TABLE opportunities; --';
  const compiled = compileReport({
    metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
    filters: { 'opportunity.stage': hostile },
  });
  assert.deepEqual(compiled.descriptor.where, [{ column: 'stage', op: 'eq', value: hostile }]);
  const result = runReport(database, compiled);
  assert.deepEqual([...result.rows], []);
  assert.equal(
    database.storage.sync.maybeOne({ kind: 'count', table: 'opportunities', where: [] }).n, 6,
    'the opportunities table survives the hostile filter',
  );
});

test('undeclared names fail closed before storage is touched', () => {
  const fails = [
    () => compileReport({ metric: 'win_rate', dimensions: ['opportunity.stage'] }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.owner'] }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: [] }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage', 'opportunity.stage'] }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage; DROP TABLE x'] }),
    () => compileReport({
      metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
      filters: { 'opportunity.amountMinor': 5 },
    }),

    () => compileReport({
      metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
      filters: { 'opportunity.currency': 'eur' },
    }),
    () => compileReport({
      metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
      filters: { 'opportunity.owner': null },
    }),
    () => compileReport({
      metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'],
      filters: JSON.parse('{"__proto__": {"polluted": true}}'),
    }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'], limit: 0 }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'], limit: 1001 }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'], filters: [1] }),
    () => compileReport({ metric: 'pipeline_value_by_stage', dimensions: ['opportunity.stage'], sql: 'SELECT 1' }),
    () => compileReport(null),
  ];
  for (const fn of fails) assert.throws(fn, ValidationError);
});
