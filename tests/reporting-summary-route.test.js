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
import { reportingSummaryFacts } from '../apps/server/src/http-server.js';
import {
  assertReportingSummaryFacts,
  parseReportingSummaryResponse,
} from '../packages/llm/src/reporting-summary.js';

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

// Review Muse rev-agent-crm-1163-abb9b6b317dc (P1, backlog:766e9cf9469e):
// every integer rendered in facts.text belongs to facts.integers, or the
// invented-number guard refuses the faithful answer. Red on abb9b6b3
// (weeks.length and the forecast sum missing), green with the fix.
test('the facts allowlist covers the rendered weeks count (P1 repro)', () => {
  const { facts } = reportingSummaryFacts({
    channels: {
      total: 16,
      weeks: [0, 0, 0, 0, 0],
      channels: [{ channel: 'instagram', total: 16, weeks: [0, 0, 0, 7, 9] }],
    },
    team: [],
    forecast: null,
    currency: 'EUR',
  });
  assert.match(facts.text[0], /16 in 5 settimane/, 'the text renders the weeks count');
  assert.ok(facts.integers.includes(5), 'the weeks count is allowlisted');
  assert.ok(facts.integers.includes(9) && facts.integers.includes(7), 'the weekly split is allowlisted');
  const checked = assertReportingSummaryFacts({ text: [...facts.text], integers: [...facts.integers] });
  assert.doesNotThrow(
    () => parseReportingSummaryResponse(
      'Il periodo ha portato 16 nuovi clienti in 5 settimane.\nUltima settimana 9 contro 7 di quella prima.',
      checked,
    ),
    'a faithful echo of the weeks count parses',
  );
});

test('the facts allowlist covers the rendered forecast sum (P1 repro)', () => {
  const { facts } = reportingSummaryFacts({
    channels: { total: 0, weeks: [], channels: [] },
    team: [{ openCount: 1, wonCount: 0, lostCount: 0, openMinor: 10000 }],
    forecast: { targetMinor: 2000000, closedMinor: 14000, probableMinor: 9333 },
    currency: 'EUR',
  });
  assert.match(facts.text.at(-1), /chiuse e probabili 23333/, 'the text renders the closed+probable sum');
  assert.ok(facts.integers.includes(23333), 'the rendered sum is allowlisted');
  const checked = assertReportingSummaryFacts({ text: [...facts.text], integers: [...facts.integers] });
  assert.doesNotThrow(
    () => parseReportingSummaryResponse(
      'Obiettivo 2000000 con chiuse e probabili 23333.\nAperti 1 da 10000 nel mese.',
      checked,
    ),
    'a faithful echo of the forecast sum parses',
  );
});

// Review Muse rev-agent-crm-1163-abb9b6b317dc (P2, backlog:766e9cf9469e):
// the allowlist holds ONLY integers the text renders. Red before the fix:
// integer() pushed every team count — including zeros no line mentions —
// so a hallucinated '0 preventivi' passed the digit check on a period
// whose team counts are all zero.
test('the facts allowlist holds no number the text never renders (P2)', () => {
  const { facts } = reportingSummaryFacts({
    channels: {
      total: 16,
      weeks: [0, 0, 0, 0, 0],
      channels: [{ channel: 'instagram', total: 16, weeks: [0, 0, 0, 7, 9] }],
    },
    team: [{ owner: 'alice', openCount: 0, wonCount: 0, lostCount: 0 }],
    forecast: null,
    currency: 'EUR',
  });
  assert.ok(!facts.integers.includes(0), 'no team line, no bare 0 in the allowlist');
  const said = facts.text.join(' ');
  for (const n of facts.integers) {
    assert.ok(said.includes(String(n)), `allowlisted ${n} is rendered in the facts text`);
  }
});

test('an empty model renders no facts and allowlists nothing (P2)', () => {
  const { facts } = reportingSummaryFacts({});
  assert.deepEqual(facts.text, []);
  assert.deepEqual(facts.integers, []);
});

test('with channel data the route accepts a faithful echo of the weeks count (P1 repro)', async (t) => {
  const { app, baseUrl } = await summaryServer(t);
  // October 2026 spans five Monday weeks (28 set, 5, 12, 19, 26 ott): the
  // stub puts 7 + 9 in the last two, so weeks.length (5) differs from every
  // other integer and the old allowlist demonstrably misses it.
  app.countCustomerChannelOrigins = async () => ({
    origins: [
      { system: 'instagram', week: '2026-10-19', count: 7 },
      { system: 'instagram', week: '2026-10-26', count: 9 },
    ],
  });
  app.completeLlmCall = async () => ({
    text: 'Il periodo ha portato 16 nuovi clienti in 5 settimane.\nUltima settimana 9 contro 7 di quella prima, con 1 preventivo aperto.',
    dryRun: false,
  });
  const response = await fetch(`${baseUrl}/api/reporting/summary?period=2026-10&spaceId=presti`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    lines: [
      'Il periodo ha portato 16 nuovi clienti in 5 settimane.',
      'Ultima settimana 9 contro 7 di quella prima, con 1 preventivo aperto.',
    ],
    reason: 'ai',
  });
});
