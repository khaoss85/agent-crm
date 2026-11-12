import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WAKING_TEXT, apiFailure, isWakeTransient, withWakeRetry } from '../apps/admin/public/admin-core.js';
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
    if (path.startsWith('/api/modules/opportunity/records/')) return record;
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
  assert.match(app, /return withWakeRetry\(once, \{ method, onWaking: wakingNotice \}\);/, 'module screens');
  assert.match(app, /\}, \{ method, onWaking: wakingNotice \}\);\n\}/, 'dashboard api()');
  assert.match(app, /if \(wakingReads === 1 && elements\.toast\) toast\(WAKING_TEXT\)/, 'one notice for the parallel reads; no toast, no throw');
});
