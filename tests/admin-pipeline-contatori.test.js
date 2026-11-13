import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:07d29c0d1b06 — Pipeline: durante «Spostamento in corso…» il
 * contatore e i totali di colonna cambiano insieme alla card, mai prima né
 * dopo; con un errore o con «Annulla» tornano indietro insieme.
 */

const PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  stages: [
    { key: 'discovery', label: 'Richiesta info', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Prova', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Vinta', order: 50, type: 'won', probability: 100 },
  ],
};

function record(id, stage, extra = {}) {
  return {
    id, name: `Offerta ${id}`, companyName: 'Palestra Esempio', valueCents: 100_000,
    currency: 'EUR', pipelineKey: 'b2b-sales', pipelineStage: stage, ...extra,
  };
}

/** A server whose POST answers when the test says so. */
function server(initial) {
  let records = initial.map((item) => ({ ...item }));
  const posts = [];
  return {
    posts,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (options.method === 'POST') {
        const id = decodeURIComponent(path.split('/records/')[1].split('/')[0]);
        const { toStage } = JSON.parse(options.body);
        return new Promise((resolve, reject) => {
          posts.push({
            body: JSON.parse(options.body),
            answer: () => {
              records = records.map((item) => (item.id === id ? { ...item, pipelineStage: toStage } : item));
              resolve({ ok: true });
            },
            fail: () => reject(Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' })),
          });
        });
      }
      return { items: records };
    },
  };
}

const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const columnOf = (mount, stage) => mount.findAll('div').find((n) => n.getAttribute('data-stage') === stage);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const countOf = (mount, stage) => mount.findAll('span').find((n) => n.getAttribute('data-count') === stage).textContent;
const totalsOf = (mount, stage) => columnOf(mount, stage).findAll('p')
  .filter((n) => classes(n).includes('stage-total')).map((n) => n.textContent);
const where = (mount, id) => cardOf(mount, id)?.parentNode?.getAttribute('data-stage') ?? null;

async function board(records) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = server(records);
  const toasts = [];
  const view = createPipelineBoard({
    doc, mount, client,
    toast: (message, error, options) => toasts.push({ message: String(message), error: Boolean(error), options }),
    navigate: () => {},
    wait: () => new Promise(() => {}),
  });
  await view.renderBoard('b2b-sales');
  return { mount, client, toasts };
}

function drop(mount, id, stage) {
  const store = {};
  const transfer = { setData(type, value) { store[type] = value; }, getData(type) { return store[type] ?? ''; } };
  cardOf(mount, id).dispatch('dragstart', { dataTransfer: transfer });
  const column = columnOf(mount, stage);
  column.dispatch('dragover', { preventDefault() {} });
  column.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
}

const snapshot = (mount) => ({
  discovery: [countOf(mount, 'discovery'), ...totalsOf(mount, 'discovery')],
  demo: [countOf(mount, 'demo'), ...totalsOf(mount, 'demo')],
});

test('07d29c0d1b06: while the move is being written, the counts and totals already sit with the card', async () => {
  const { mount, client } = await board([
    record('a', 'discovery', { valueCents: 250_000 }),
    record('b', 'discovery'),
    record('c', 'demo'),
  ]);
  const before = snapshot(mount);
  drop(mount, 'a', 'demo');
  await tick();
  assert.equal(client.posts.length, 1, 'the write is still running');
  assert.equal(where(mount, 'a'), 'demo', 'the card is in Prova');
  assert.equal(countOf(mount, 'discovery'), '1', 'Richiesta info counts one card fewer, with the card');
  assert.equal(countOf(mount, 'demo'), '2', 'Prova counts one more, with the card');
  assert.notDeepEqual(totalsOf(mount, 'discovery'), before.discovery.slice(1), 'the value left Richiesta info');
  assert.ok(totalsOf(mount, 'demo')[0].includes('3.500'), `Prova adds the card's value (${totalsOf(mount, 'demo')})`);
  assert.ok(totalsOf(mount, 'discovery')[0].includes('1.000'), `Richiesta info keeps the other card (${totalsOf(mount, 'discovery')})`);
  client.posts[0].answer();
  await tick();
  assert.equal(where(mount, 'a'), 'demo');
  assert.deepEqual(snapshot(mount), { discovery: ['1', totalsOf(mount, 'discovery')[0]], demo: ['2', totalsOf(mount, 'demo')[0]] },
    'the re-read confirms the same numbers');
});

test('07d29c0d1b06: a failed move brings card, counts and totals back together', async () => {
  const { mount, client } = await board([record('a', 'discovery'), record('c', 'demo')]);
  const before = snapshot(mount);
  drop(mount, 'a', 'demo');
  await tick();
  client.posts[0].fail();
  await tick();
  assert.equal(where(mount, 'a'), 'discovery', 'the card is back');
  assert.deepEqual(snapshot(mount), before, 'and so are the numbers');
});

test('07d29c0d1b06: «Annulla» moves card and numbers back at once; a refused undo puts both where they were', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('c', 'demo')]);
  const before = snapshot(mount);
  drop(mount, 'a', 'demo');
  await tick();
  client.posts[0].answer();
  await tick();
  const moved = snapshot(mount);
  toasts.find((item) => item.message === 'Spostata in Prova.').options.action.run();
  await tick();
  assert.equal(client.posts.length, 2, 'the reverse write is running');
  assert.equal(where(mount, 'a'), 'discovery', 'the card is back already');
  assert.deepEqual(snapshot(mount), before, 'with its numbers');
  client.posts[1].fail();
  await tick();
  assert.equal(where(mount, 'a'), 'demo', 'the refused undo leaves the card where the server has it');
  assert.deepEqual(snapshot(mount), moved, 'and the numbers with it');
});

test('07d29c0d1b06: an empty column keeps its count and totals honest when a card arrives and leaves', async () => {
  const { mount, client } = await board([record('a', 'discovery', { currency: 'USD', valueCents: 2_500 })]);
  assert.equal(countOf(mount, 'demo'), '0');
  assert.deepEqual(totalsOf(mount, 'demo'), [], 'no total line for an empty column');
  drop(mount, 'a', 'demo');
  await tick();
  assert.equal(countOf(mount, 'demo'), '1');
  assert.equal(totalsOf(mount, 'demo').length, 1, 'one line per currency');
  assert.deepEqual(totalsOf(mount, 'discovery'), [], 'the emptied column drops its total line');
  client.posts[0].fail();
  await tick();
  assert.equal(countOf(mount, 'demo'), '0');
  assert.deepEqual(totalsOf(mount, 'demo'), []);
});
