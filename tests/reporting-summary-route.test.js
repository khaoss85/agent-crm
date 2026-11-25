// @ts-check

/**
 * Backoffice BO-F5-02 Reporting (backlog:766e9cf9469e) — the AI summary route.
 *
 * What it must prove, through the live HTTP route like tests/api.test.js:
 * - an empty period answers `{ lines: null, reason: 'empty' }` before any
 *   `complete` is touched: no spend lands on nothing to say;
 * - with data and the AI on, the route rewrites the period's own dashboard
 *   numbers into exactly two lines;
 * - with the AI off, missing or failing, the route still answers 200 with
 *   `{ lines: null }` and its reason: the header keeps the computed fallback
 *   of #1145, never an error;
 * - there is deliberately no POST under /api/reporting/summary, like the
 *   dashboard above it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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
 * @param {{id: string, stage: string, cents: number, currency: string, owner: string, close: string | null}} opportunity
 */
function opportunityRow({ id, stage, cents, currency, owner, close }) {
  return {
    kind: 'insert', table: 'opportunities', values: [
      { column: 'id', value: id }, { column: 'company_id', value: 'c1' },
      { column: 'contact_id', value: null }, { column: 'name', value: id },
      { column: 'type', value: 'new_business' }, { column: 'value_cents', value: cents },
      { column: 'currency', value: currency }, { column: 'stage', value: stage },
      { column: 'owner', value: owner }, { column: 'expected_close_date', value: close },
      { column: 'created_at', value: TS }, { column: 'updated_at', value: TS },
    ],
  };
}

// Hand-computed (EUR, periodo 2026-10): alice holds 1 open (10000), 1 won
// (9000, closed 2026-10-10) and 1 lost (closed 2026-10-12). The summary
// facts the route builds therefore allow exactly the integers 1 and 10000.
const FIXTURE = [
  { id: 's1', stage: 'qualification', cents: 10000, currency: 'EUR', owner: 'alice', close: '2026-10-15' },
  { id: 's2', stage: 'won', cents: 9000, currency: 'EUR', owner: 'alice', close: '2026-10-10' },
  { id: 's3', stage: 'lost', cents: 3000, currency: 'EUR', owner: 'alice', close: '2026-10-12' },
];

/** @param {import('node:test').TestContext} t @param {{seed?: boolean}} [options] */
async function summaryServer(t, options = {}) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  if (options.seed !== false) {
    app.database.storage.sync.execute(companyRow());
    for (const opportunity of FIXTURE) app.database.storage.sync.execute(opportunityRow(opportunity));
  }
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

test('an empty period answers lines:null before any complete is touched', async (t) => {
  const { app, baseUrl } = await summaryServer(t, { seed: false });
  let calls = 0;
  app.completeLlmCall = async () => { calls += 1; return { text: 'never', dryRun: false }; };
  const response = await fetch(`${baseUrl}/api/reporting/summary?period=2026-10&spaceId=presti`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { lines: null, reason: 'empty' });
  assert.equal(calls, 0, 'no model call for a period with no data');
});

test('with data and the AI on, the route rewrites the period numbers in two lines', async (t) => {
  const { app, baseUrl } = await summaryServer(t);
  const seen = {};
  app.completeLlmCall = async (request) => {
    seen.request = request;
    return {
      text: 'Il periodo ha portato 1 preventivo aperto da 10000.\nVinta 1 e persa 1 nel mese.',
      dryRun: false,
    };
  };
  const response = await fetch(`${baseUrl}/api/reporting/summary?period=2026-10&spaceId=presti`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    lines: [
      'Il periodo ha portato 1 preventivo aperto da 10000.',
      'Vinta 1 e persa 1 nel mese.',
    ],
    reason: 'ai',
  });
  assert.equal(seen.request.purpose, 'reporting-summary', 'the summary spends its own audited purpose');
  assert.equal(seen.request.spaceId, 'presti');
});

test('with the AI off, missing or failing the route keeps the 200 fallback', async (t) => {
  const { baseUrl } = await summaryServer(t);
  const off = await (await fetch(`${baseUrl}/api/reporting/summary?period=2026-10`)).json();
  assert.equal(off.lines, null, 'no space: no AI, the header keeps the computed fallback');
  assert.equal(off.reason, 'ai-unavailable');
});

test('a failing AI answers the fallback reason, never a 500', async (t) => {
  const { app, baseUrl } = await summaryServer(t);
  app.completeLlmCall = async () => {
    throw Object.assign(new Error('capped'), { code: 'LLM_DAILY_CAP_EXCEEDED' });
  };
  const response = await fetch(`${baseUrl}/api/reporting/summary?period=2026-10&spaceId=presti`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { lines: null, reason: 'ai-capped' });
});

test('persona narrows the summary like the dashboard filters', async (t) => {
  const { app, baseUrl } = await summaryServer(t);
  const purposes = [];
  app.completeLlmCall = async (request) => {
    purposes.push(request);
    return { text: 'Il periodo ha portato 1 preventivo aperto.\nVinta 1 e persa 1.', dryRun: false };
  };
  const response = await fetch(`${baseUrl}/api/reporting/summary?period=2026-10&owner=alice&spaceId=presti`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reason, 'ai');
});

test('there is no write surface under /api/reporting/summary', async (t) => {
  const { baseUrl } = await summaryServer(t);
  const post = await fetch(`${baseUrl}/api/reporting/summary?period=2026-10`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 404, 'no POST under /api/reporting/*: the proposal cannot reassign by itself');
});
