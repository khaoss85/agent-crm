// @ts-check

/**
 * Trace redaction on PostgreSQL (backlog:a3b394dd, P0 giro 3).
 *
 * The SQLite A5-0 test proves the quote-share Bearer [REDACTED] rests in
 * `workflow_runs`/`trace_spans` on the sync runner. This test proves the same
 * contract on the PostgreSQL envelope: the idempotent write path persists the
 * input (pending run, outcome scope, settled trace) and the result (outcome
 * response, settled trace, span outputs) through `runIdempotentWrite`, so the
 * redaction must cover those copies too — while the live return keeps the raw
 * value. A synthetic Bearer [REDACTED] action exercises the mechanism every
 * redacted action (quote share-link, accept-link, link-info) relies on.
 *
 * Skips cleanly without a database (the helper returns null); set
 * ACCORDO_PG_TEST_URL at a real PostgreSQL 16 to execute — CI always does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { POSTGRES_SCHEMA_NAME } from '../packages/core/src/physical-name.js';

const { bootPostgresqlApp } = await import('./helpers/postgresql-application.js');

const { Client } = pg;

function probeManifest() {
  return {
    manifestVersion: 1,
    name: 'redact-probe',
    description: 'P0 probe: an action whose input and result carry a bearer.',
    table: 'port_test_redact_probe',
    fields: [{ name: 'title', type: 'string' }],
  };
}

const SECRET = 'bearer-probe-ONLY-THE-LIVE-RESULT-HOLDS-THIS-9f8e7d6c5b4a';

function probeAction() {
  return {
    module: 'redact-probe',
    name: 'issue-secret',
    actionContract: 2,
    input: [{ name: 'secret', type: 'string', required: true }],
    traceRedact: {
      input: (input) => ({ ...input, secret: '[redacted]' }),
      output: (result) => ({ ...result, secret: null, secretHash: 'sha256:probe' }),
    },
    async execute({ input }) {
      return { ok: true, secret: input.secret };
    },
  };
}

test('a redacted Bearer [REDACTED] rests in pg outcomes and traces', { timeout: 120_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, {
    selected: {
      packageContract: 2,
      packages: [],
      actions: [probeAction()],
      modules: [{ name: 'redact-probe', manifest: probeManifest() }],
    },
  });
  if (!booted) return;
  const { app, planes } = booted;
  const actor = { type: 'user', id: 'probe-runner' };

  const created = await app.modules.get('redact-probe').service.create({ title: 'probe' });
  const key = `v1.20261108.${randomBytes(16).toString('hex')}`;
  const ran = await app.runAction({
    module: 'redact-probe',
    action: 'issue-secret',
    recordId: created.id,
    input: { secret: SECRET },
    actor,
    idempotencyKey: key,
  });
  assert.equal(ran.result.secret, SECRET, 'the live return keeps the raw bearer');

  const client = new Client({ ...planes.data, connectionTimeoutMillis: 5000 });
  await client.connect();
  // Closed explicitly before the helper teardown drops the databases (which
  // terminates every remaining backend); a t.after hook would race it.
  const schema = POSTGRES_SCHEMA_NAME;
  const readJson = async () => {
    const runs = await client.query(
      `SELECT id, input_json::text AS input, output_json::text AS output FROM ${schema}.workflow_runs WHERE workflow_name = 'redact-probe.issue-secret'`,
    );
    const spans = await client.query(
      `SELECT output_json::text AS output FROM ${schema}.trace_spans WHERE run_id = ANY($1)`,
      [runs.rows.map((row) => row.id)],
    );
    const outcomes = await client.query(
      `SELECT response_json::text AS response, trace_intent_json::text AS intent FROM ${schema}.write_outcomes WHERE raw_key = $1`,
      [key],
    );
    return { runs: runs.rows, spans: spans.rows, outcomes: outcomes.rows };
  };
  const seen = await readJson();
  await client.end();

  assert.ok(seen.runs.length >= 1, 'the pg trace row exists');
  const traceJson = JSON.stringify(seen.runs);
  assert.ok(!traceJson.includes(SECRET), 'no pg trace row holds the raw bearer');
  assert.ok(traceJson.includes('[redacted]'), 'the pg trace input holds the redacted copy');
  assert.ok(traceJson.includes('sha256:probe'), 'the pg trace output holds the redacted copy');

  assert.ok(seen.spans.length >= 1, 'the pg spans exist');
  const spansJson = JSON.stringify(seen.spans);
  assert.ok(!spansJson.includes(SECRET), 'no pg span holds the raw bearer');

  assert.ok(seen.outcomes.length >= 1, 'the pg outcome row exists');
  const outcomesJson = JSON.stringify(seen.outcomes);
  assert.ok(!outcomesJson.includes(SECRET), 'no pg outcome copy holds the raw bearer');
  assert.ok(outcomesJson.includes('sha256:probe'), 'the pg outcome holds the redacted copy');
});
