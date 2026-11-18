import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { READ_STALE_CODE, WAKING_TEXT, apiFailure, isStaleRead, isWakeTransient, readWhileWaking, withWakeRetry } from '../apps/admin/public/admin-core.js';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:2b62c771f1f9 — on top of the wake rule of #673 (isWakeTransient,
 * withWakeRetry). Prod 11/11 21:58Z: the scheda of a clean contact read «La
 * cronologia non si è potuta leggere» on a 502 no application log explains,
 * 200 a minute later: the Render gateway in front of the sleeping free web
 * answers 502/504 by itself. A read meeting that page retries once like a
 * 503, the shell says the server is waking, and nothing else changes.
 */

const RENDER_PAGE = undefined; // Render's HTML page parses as no JSON at all
const answer = (status, payload) => apiFailure(status, payload);

function scripted(steps) {
  const calls = [];
  return {
    calls,
    run: async () => {
      const step = steps[calls.length];
      calls.push(step);
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

test('a GET the gateway failed with a 502/504 page is a waking host: read once more, the data arrives', async () => {
  for (const status of [502, 504]) {
    const { calls, run } = scripted([answer(status, RENDER_PAGE), { ok: 'dato' }]);
    const waking = [];
    const result = await withWakeRetry(run, { method: 'GET', wait: async () => {}, onWaking: (on) => waking.push(on) });
    assert.deepEqual(result, { ok: 'dato' }, `${status}`);
    assert.equal(calls.length, 2);
    assert.deepEqual(waking, [true, false], `${status}: the notice opens and closes`);
  }
  assert.equal(WAKING_TEXT, 'Il server si sta svegliando…');
});

test('a 502/504 the application named stays its verdict, and a write never replays a gateway page', () => {
  assert.equal(isWakeTransient(answer(502, { error: { code: 'LLM_SPACE_DISABLED' } })), false);
  assert.equal(isWakeTransient(answer(504, { error: { code: 'BO_SEND_PENDING' } })), false);
  assert.equal(isWakeTransient(answer(500, RENDER_PAGE)), false, 'a 500 is not the gateway');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isWakeTransient(answer(502, RENDER_PAGE), { method }), false, method);
    assert.equal(isWakeTransient(answer(504, RENDER_PAGE), { method }), false, method);
  }
});

test('a POST meeting the gateway page is sent once, with no waking notice', async () => {
  const { calls, run } = scripted([answer(502, RENDER_PAGE), 'dato']);
  const waking = [];
  await assert.rejects(withWakeRetry(run, { method: 'POST', wait: async () => {}, onWaking: (on) => waking.push(on) }));
  assert.equal(calls.length, 1);
  assert.deepEqual(waking, []);
});

test('a throwing waking notice never masks the read: it still retries, ends, and a failure is the read’s own', async () => {
  const { calls, run } = scripted([answer(502, RENDER_PAGE), 'dato']);
  const seen = [];
  assert.equal(await withWakeRetry(run, { wait: async () => {}, onWaking: (on) => { seen.push(on); throw new TypeError('no toast'); } }), 'dato');
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, [true, false]);
  const second = answer(502, RENDER_PAGE);
  const failing = scripted([answer(502, RENDER_PAGE), second]);
  await assert.rejects(withWakeRetry(failing.run, { wait: async () => {}, onWaking: () => { throw new Error('boom'); } }), (error) => error === second);
});

test('a /bo screen whose first read hit the gateway page shows its data, not the error', async () => {
  const record = { id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', valueCents: 1000, currency: 'EUR', owner: 'maria' };
  let sleeping = true;
  const once = async (path, options = {}) => {
    enforceAdminWriteGate(path, options);
    if (sleeping) { sleeping = false; throw answer(502, RENDER_PAGE); }
    if (path === '/api/schema') return { pipelines: [] };
    if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return record;
    return { items: [] };
  };
  const client = { request: (path, options = {}) => withWakeRetry(() => once(path, options), { method: options.method ?? 'GET', wait: async () => {} }) };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  await view.renderOfferDetail('off1');
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the data is on screen');
  assert.ok(!mount.textContent.includes('non trovata o non leggibile'), 'never the error');
});

test('the /bo client says the wake once per screen, on both the module and the dashboard reads', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if \(isMutation\(method\)\) return withWakeRetry\(once, \{ method, onWaking: wakingNotice \}\);/, 'module screens: writes keep the single retry');
  assert.match(app, /return readWhileWaking\(once, \{ method, stale: \(\) => navToken !== navSeq, onWaking: spaceWakingNotice \}\);/, 'module screens: reads poll until the space answers, and die with the screen');
  assert.match(app, /if \(isMutation\(method\)\) return withWakeRetry\(run, \{ method, onWaking: wakingNotice \}\);/, 'dashboard api(): writes keep the single retry');
  assert.match(app, /return readWhileWaking\(run, \{ method, stale: \(\) => navToken !== navSeq, onWaking: spaceWakingNotice \}\);/, 'dashboard api(): reads poll until the space answers, and die with the screen');
  assert.match(app, /const navToken = navSeq;/, 'both readers capture the navigation token at call time');
  assert.match(app, /if \(isStaleRead\(error\)\) return;/, 'the router drops a stale read silently: no toast, no failure paint');
  assert.match(app, /if \(wakingReads === 1 && elements\.toast\) toast\(WAKING_TEXT\)/, 'one notice for the parallel reads; no toast, no throw');
  assert.match(app, /if \(spaceWakingReads === 1 && elements\.toast\) toast\(SPACE_WAKING_TEXT, false, \{ duration: 65000, scope: 'space-waking' \}\)/, 'the long wait names itself once and outlives the 3.2 s toast clock (backlog:0d25ed7dc34f)');
  assert.match(app, /if \(spaceWakingReads === 0 && toaster !== null\) toaster\.hideScope\('space-waking'\)/, 'the wait leaves with the last waiting read, only when it still shows ours');
});

/**
 * backlog:0d25ed7dc34f (review Muse #1009 on agent-crm#1009): the three
 * P2 findings — the abort path the unit tests proved was dead in
 * production (stale never reached the poll), the INVALID_RESPONSE a late
 * answer would paint, and a wiring test that only greps. These run the
 * production code (readWhileWaking over pollWhileWaking, the same function
 * api() and moduleClient.rawRequest() call) instead of grepping it.
 */

const STARTING = () => apiFailure(503, { error: { code: 'WORKSPACE_STARTING' } });

test('a waking read polls through the production helper until the space answers', async () => {
  const { calls, run } = scripted([STARTING(), STARTING(), { ok: 'dato' }]);
  const waking = [];
  const data = await readWhileWaking(run, { method: 'GET', wait: async () => {}, rounds: 5, onWaking: (on) => waking.push(on) });
  assert.deepEqual(data, { ok: 'dato' });
  assert.equal(calls.length, 3);
  assert.deepEqual(waking, [true, false]);
});

test('a read whose screen moved on stops without stray requests, and never throws INVALID_RESPONSE', async () => {
  let navigated = false;
  const { calls, run } = scripted([STARTING(), { ok: 'dato' }]);
  await assert.rejects(
    readWhileWaking(run, { method: 'GET', wait: async () => { navigated = true; }, stale: () => navigated, rounds: 5 }),
    (error) => isStaleRead(error) && error.code !== 'INVALID_RESPONSE',
  );
  assert.equal(calls.length, 1, 'no fetch after the navigation');
});

test('a success landing after the navigation is dropped as stale, never data and never INVALID_RESPONSE', async () => {
  let checks = 0;
  await assert.rejects(
    readWhileWaking(async () => ({ ok: 'tardi' }), { method: 'GET', wait: async () => {}, stale: () => (++checks > 1) }),
    (error) => error.code === READ_STALE_CODE && error.code !== 'INVALID_RESPONSE',
  );
  assert.equal(checks, 2);
});

test('a final refusal throws the read’s own error, never INVALID_RESPONSE', async () => {
  const refused = apiFailure(401, null);
  const { calls, run } = scripted([refused]);
  await assert.rejects(readWhileWaking(run, { method: 'GET', wait: async () => {} }), (error) => error === refused);
  assert.equal(calls.length, 1);
});

test('an exhausted wake throws the last refusal, never INVALID_RESPONSE', async () => {
  const last = STARTING();
  const { calls, run } = scripted([STARTING(), last]);
  await assert.rejects(
    readWhileWaking(run, { method: 'GET', wait: async () => {}, rounds: 2 }),
    (error) => error === last && error.code !== 'INVALID_RESPONSE',
  );
  assert.equal(calls.length, 2);
});
