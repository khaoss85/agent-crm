import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTORS_FINISH_MAX_PAGES,
  CONNECTORS_FINISH_PAGE_LIMIT,
  createHttpServer,
} from '../apps/server/src/http-server.js';

/**
 * Backoffice BO-F1-02 — collegare un connettore in 3 passi.
 *
 * One finish request cannot pull an unbounded past: it advances at most
 * CONNECTORS_FINISH_MAX_PAGES pages and reports done:false with the progress
 * so far, so the fatto step resumes instead of the request outliving gateway
 * timeouts. A stub app keeps this test instant and deterministic — no sqlite,
 * no provider.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'connectors-finish-bounds',
};

async function postFinish(t, app, body) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/connectors/finish`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('finish advances at most a bounded number of pages per request', async (t) => {
  const advances = [];
  const app = {
    async startInitialImport() {
      return { started: true, resumed: false, state: { status: 'running', importedEvents: 0 } };
    },
    async advanceInitialImport(params) {
      advances.push(params);
      return { done: false, state: { status: 'running', importedEvents: advances.length } };
    },
  };
  const finished = await postFinish(t, app, {
    spaceId: 'presti', connectionKey: 'ch-conn:presti:whatsapp:x', history: true,
  });
  assert.equal(finished.done, false, 'a past larger than the page budget reports done:false, never a hang');
  assert.equal(advances.length, CONNECTORS_FINISH_MAX_PAGES);
  for (const params of advances) {
    assert.equal(params.limit, CONNECTORS_FINISH_PAGE_LIMIT, 'every advance carries the explicit page limit');
  }
  assert.equal(finished.import?.status, 'running');
  assert.equal(finished.import?.importedEvents, CONNECTORS_FINISH_MAX_PAGES);
});

test('finish reports done when the budget covers the past', async (t) => {
  const advances = [];
  const app = {
    async startInitialImport() {
      return { started: true, resumed: false, state: { status: 'running', importedEvents: 0 } };
    },
    async advanceInitialImport() {
      advances.push(1);
      return advances.length >= 2
        ? { done: true, state: { status: 'done', importedEvents: 2 } }
        : { done: false, state: { status: 'running', importedEvents: 1 } };
    },
  };
  const finished = await postFinish(t, app, {
    spaceId: 'presti', connectionKey: 'ch-conn:presti:whatsapp:x', history: true,
  });
  assert.equal(finished.done, true);
  assert.equal(advances.length, 2, 'the drive stops at done instead of spending the whole budget');
  assert.equal(finished.import?.status, 'done');
});

test('finish skips nothing when history is declined', async (t) => {
  let started = 0;
  const app = {
    async startInitialImport() {
      started += 1;
      return { started: true, resumed: false, state: null };
    },
    async advanceInitialImport() {
      throw new Error('must not advance a skipped import');
    },
  };
  const finished = await postFinish(t, app, { spaceId: 'presti', connectionKey: 'k', history: false });
  assert.deepEqual(finished, { started: false, skipped: 'history', connectionKey: 'k' });
  assert.equal(started, 0);
});
