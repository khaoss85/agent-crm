import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Production 07/11: on the pilot a stage move rides the operation queue and
 * the card sat aria-busy for minutes, «Sposta» disabled, no word. The card
 * now says «Spostamento in corso…» at once and, once the pending read times
 * out (or the server answers 504 pending), «Non ancora confermato» with
 * Riprova — a board re-read, never a second POST.
 */

const PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  movePath: '/api/modules/opportunity/records/:id/actions/move-stage',
  stages: [
    { key: 'discovery', label: 'Discovery', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
    { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
  ],
};

const RECORDS = [{
  id: 'a',
  name: 'Deal a',
  companyName: 'Acme',
  valueCents: 100_000,
  currency: 'EUR',
  pipelineKey: 'b2b-sales',
  pipelineStage: 'discovery',
}];

/** @param {(path: string, options: any) => any} onPost */
function stubClient(onPost) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (options.method === 'POST') return onPost(path, options);
      return { items: RECORDS };
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const cardOf = (mount) => mount.findAll('div').find((n) => n.getAttribute('data-record') === 'a');
const statusOf = (card) => card.findAll('small').find((n) => n.getAttribute('role') === 'status');
const retryOf = (card) => card.findAll('button').find((n) => n.getAttribute('data-action') === 'move-retry');
const hidden = (node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('hidden');

test('a queued move says so on the card, then offers Riprova after the pending timeout', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let releaseTimeout = () => {};
  const timeout = new Promise((resolve) => { releaseTimeout = resolve; });
  const client = stubClient(() => new Promise(() => {})); // the queue never answers
  const board = createPipelineBoard({ doc, mount, client, wait: () => timeout });
  await board.renderBoard('b2b-sales');
  const card = cardOf(mount);
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  assert.equal(statusOf(card).textContent, 'Spostamento in corso…', 'the card says the move is in flight');
  assert.ok(!hidden(statusOf(card)));
  const move = card.findAll('button').find((n) => n.textContent === 'Sposta');
  assert.equal(move.getAttribute('aria-busy'), 'true');
  assert.ok(hidden(retryOf(card)), 'no Riprova while the move is fresh');

  releaseTimeout();
  await tick();
  assert.equal(statusOf(card).textContent, 'Non ancora confermato', 'the pending read timed out');
  assert.ok(!hidden(retryOf(card)), 'Riprova shows');
  assert.equal(retryOf(card).textContent, 'Riprova');
  const posts = client.calls.filter((call) => call.method === 'POST').length;
  const reads = client.calls.filter((call) => call.path === '/api/schema').length;
  retryOf(card).dispatch('click');
  await tick();
  await tick();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, posts, 'Riprova never posts the move again');
  assert.equal(client.calls.filter((call) => call.path === '/api/schema').length, reads + 1, 'Riprova re-reads the board');
});

test('85630aa14a4f: while the move is in flight the menu names the column on screen', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const client = stubClient(() => gate.then(() => ({ ok: true })));
  const board = createPipelineBoard({ doc, mount, client, wait: () => new Promise(() => {}) });
  await board.renderBoard('b2b-sales');
  const card = cardOf(mount);
  const menu = () => card.__select.childNodes.map((option) => option.getAttribute('value'));
  assert.deepEqual(menu(), ['demo', 'won', 'lost'], 'at rest the menu skips the card\'s own column');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  assert.equal(card.parentNode.getAttribute('data-stage'), 'demo', 'the card waits in its new column');
  assert.deepEqual(menu(), ['discovery', 'won', 'lost'], 'the menu follows the card, not the pending write');
  release();
  await tick();
  await tick();
  const fresh = cardOf(mount);
  // The stub never applies the move server-side: the re-read truth is the
  // old column, and the fresh menu follows it again.
  assert.equal(fresh.parentNode.getAttribute('data-stage'), 'discovery', 'the re-read truth wins');
  assert.deepEqual(fresh.__select.childNodes.map((option) => option.getAttribute('value')), ['demo', 'won', 'lost']);
});

test('a move answered in time never shows the pending line', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let releaseTimeout = () => {};
  const timeout = new Promise((resolve) => { releaseTimeout = resolve; });
  const client = stubClient(() => ({ ok: true }));
  const board = createPipelineBoard({ doc, mount, client, wait: () => timeout });
  await board.renderBoard('b2b-sales');
  const card = cardOf(mount);
  card.__select.value = 'demo';
  await card.__move();
  releaseTimeout();
  await tick();
  assert.ok(!mount.textContent.includes('Non ancora confermato'), 'a settled move never reads as pending');
});

// Review #657 round 4 P1: a drop rode its own path and read a queued move
// as «Spostamento non riuscito».
test('a dropped card whose move is queued reads «Non ancora confermato», never a failure', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const client = stubClient(() => {
    throw Object.assign(new Error('Scrittura in attesa'), { status: 504, code: 'BO_CRM_PENDING', requestId: 'r1' });
  });
  const board = createPipelineBoard({ doc, mount, client, toast: (message) => toasts.push(String(message)), wait: () => new Promise(() => {}) });
  await board.renderBoard('b2b-sales');
  const card = cardOf(mount);
  const demo = mount.findAll('div').find((n) => n.getAttribute('data-stage') === 'demo');
  await demo.__drop(JSON.stringify({ id: 'a', fromStage: 'discovery' }));
  assert.ok(!toasts.some((message) => message.includes('non riuscito')), `no failure toast (${toasts.join(' | ')})`);
  assert.equal(statusOf(card).textContent, 'Non ancora confermato');
  assert.ok(!hidden(retryOf(card)), 'Riprova shows');
  const move = card.findAll('button').find((n) => n.textContent === 'Sposta');
  assert.equal(move.disabled, true, 'the card stays locked while the move is queued');
});

// Review #657 (second round) P2: only BO_CRM_PENDING is a queued move; a
// bare 504 (gateway) is a failure the operator can retry.
test('a bare 504 without the pending code is a failure, never a locked pending card', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(() => {
    throw Object.assign(new Error('Gateway Timeout'), { status: 504, code: 'UNKNOWN' });
  });
  const board = createPipelineBoard({ doc, mount, client, wait: () => new Promise(() => {}) });
  await board.renderBoard('b2b-sales');
  const card = cardOf(mount);
  card.__select.value = 'demo';
  await card.__move();
  const error = card.findAll('small').find((n) => (n.getAttribute('class') ?? '') === 'field-error');
  assert.ok(error && error.textContent.includes('Spostamento non riuscito'), 'the failure line shows');
  assert.ok(!mount.textContent.includes('Non ancora confermato'));
  const move = card.findAll('button').find((n) => n.textContent === 'Sposta');
  assert.equal(move.disabled, false, 'Sposta is usable again');
  assert.equal(move.getAttribute('aria-busy'), 'false');
});

test('a 504 pending answer reads «Non ancora confermato», never «non riuscito»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(() => {
    throw Object.assign(new Error('Scrittura in attesa'), { status: 504, code: 'BO_CRM_PENDING', requestId: 'r1' });
  });
  const board = createPipelineBoard({ doc, mount, client, wait: () => new Promise(() => {}) });
  await board.renderBoard('b2b-sales');
  const card = cardOf(mount);
  card.__select.value = 'demo';
  await card.__move();
  assert.equal(statusOf(card).textContent, 'Non ancora confermato');
  const error = card.findAll('small').find((n) => (n.getAttribute('class') ?? '') === 'field-error');
  assert.equal(error, undefined, 'no failure line for a move the server still holds');
  assert.ok(!hidden(retryOf(card)), 'Riprova shows');
  // Review #657 P1: the queued move stays locked — only Riprova (a board
  // re-read) is offered, never a second move POST.
  const move = card.findAll('button').find((n) => n.textContent === 'Sposta');
  assert.equal(move.disabled, true, 'Sposta stays disabled while the move is queued');
  assert.equal(move.getAttribute('aria-busy'), 'true');
  const posts = client.calls.filter((call) => call.method === 'POST').length;
  await card.__move();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, posts, 'no duplicate move POST');
});
