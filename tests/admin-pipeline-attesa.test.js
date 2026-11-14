import test from 'node:test';
import assert from 'node:assert/strict';
// Namespace import: on the code before this voice the file still loads, so
// every test fails on its own assertion (the behaviour).
import * as pipelineModule from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const { createPipelineBoard } = pipelineModule;
const MOVE_SLOW_MS = pipelineModule.MOVE_SLOW_MS ?? 3000;

/**
 * backlog:fd0adcded1c3 (verifica in produzione 13/11, pilota 5ee01ac con
 * agent-crm 0b16c43):
 * 1) «Spostata in …» solo dopo la conferma del server (vedi anche
 *    admin-pipeline-toast e admin-pipeline-feedback);
 * 3) la colonna vuota perde «Trascina qui un'offerta» appena la card è
 *    posata, non dopo il salvataggio;
 * 4) un caricamento della Pipeline oltre 3 s lo dice a parole, come uno
 *    spostamento lento.
 * Il punto 2 (pannello a 1024 e 1280 px) è provato nel browser vero:
 * admin-pipeline-panel-room-browser.test.js.
 */

const PIPELINE = {
  pipelineContract: 1, name: 'b2b-sales', label: 'B2B', module: 'opportunity', defaultStage: 'discovery',
  stages: [
    { key: 'discovery', label: 'Richiesta info', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Prova', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Vinta', order: 50, type: 'won', probability: 100 },
  ],
};

const record = (id, stage) => ({
  id, name: `Offerta ${id}`, companyName: 'Palestra Esempio', valueCents: 100_000, currency: 'EUR',
  pipelineKey: 'b2b-sales', pipelineStage: stage,
});

function server(initial) {
  let records = initial.map((item) => ({ ...item }));
  const posts = [];
  let gate = null;
  return {
    posts,
    holdReads() { let release = () => {}; gate = new Promise((resolve) => { release = resolve; }); return () => { gate = null; release(); }; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (options.method === 'POST') {
        const id = decodeURIComponent(path.split('/records/')[1].split('/')[0]);
        const { toStage } = JSON.parse(options.body);
        return new Promise((resolve, reject) => {
          posts.push({
            answer: () => { records = records.map((item) => (item.id === id ? { ...item, pipelineStage: toStage } : item)); resolve({ ok: true }); },
            fail: () => reject(Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' })),
          });
        });
      }
      if (gate) await gate;
      return { items: records };
    },
  };
}

const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const columnOf = (mount, stage) => mount.findAll('div').find((n) => n.getAttribute('data-stage') === stage);
/** The «Trascina qui» lines a person sees in a column (hidden ones do not count). */
const shownEmpty = (mount, stage) => [...columnOf(mount, stage).childNodes]
  .filter((node) => typeof node.getAttribute === 'function' && node.textContent === "Trascina qui un'offerta" && !classes(node).includes('hidden'));

async function board(records, { wait } = {}) {
  const mount = createMount();
  const client = server(records);
  const toasts = [];
  const view = createPipelineBoard({
    doc: createFakeDocument(), mount, client,
    toast: (message, error, options) => toasts.push({ message: String(message), error: Boolean(error), options }),
    navigate: () => {},
    wait: wait ?? (() => new Promise(() => {})),
  });
  await view.renderBoard('b2b-sales');
  return { mount, client, toasts, view };
}

function drop(mount, id, stage) {
  const store = {};
  const transfer = { setData(type, value) { store[type] = value; }, getData(type) { return store[type] ?? ''; } };
  cardOf(mount, id).dispatch('dragstart', { dataTransfer: transfer });
  const column = columnOf(mount, stage);
  column.dispatch('dragover', { preventDefault() {} });
  column.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
}

// ---- 3. The empty column line ----------------------------------------------

test('fd0adcded1c3: a card dropped on an empty column takes the «Trascina qui» line away at once, while the save runs', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  assert.equal(shownEmpty(mount, 'demo').length, 1, 'Prova starts empty, with its line');
  drop(mount, 'a', 'demo');
  await tick();
  assert.equal(client.posts.length, 1, 'the write is still running');
  assert.equal(cardOf(mount, 'a').parentNode.getAttribute('data-stage'), 'demo', 'the card is posed in Prova');
  assert.equal(shownEmpty(mount, 'demo').length, 0, 'no «Trascina qui un\'offerta» under the card');
  assert.equal(shownEmpty(mount, 'discovery').length, 1, 'the column it left is empty now, and says so');
  client.posts[0].answer();
  await tick(8);
  assert.equal(shownEmpty(mount, 'demo').length, 0, 'after the save, still none');
  assert.equal(shownEmpty(mount, 'discovery').length, 1);
});

test('fd0adcded1c3: a failed drop puts the card and both lines back', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  drop(mount, 'a', 'demo');
  await tick();
  client.posts[0].fail();
  await tick(8);
  assert.equal(cardOf(mount, 'a').parentNode.getAttribute('data-stage'), 'discovery', 'the card is back');
  assert.equal(shownEmpty(mount, 'demo').length, 1, 'Prova is empty again, with its line');
  assert.equal(shownEmpty(mount, 'discovery').length, 0, 'and the card\'s column has none');
});

// ---- 4. A long board load --------------------------------------------------

test('fd0adcded1c3: a board read still running after 3 s says so in words, like a slow move', async () => {
  let slow = () => {};
  const { mount, client, view } = await board([record('a', 'discovery')], {
    wait: (ms) => (ms === MOVE_SLOW_MS ? new Promise((resolve) => { slow = resolve; }) : new Promise(() => {})),
  });
  const release = client.holdReads();
  const loading = view.renderBoard('b2b-sales');
  await tick();
  const status = mount.findAll('p').find((node) => node.getAttribute('role') === 'status');
  assert.ok(status, 'the skeleton is on screen');
  assert.ok(classes(status).includes('sr-only'), 'before 3 s: the words are for a screen reader only');
  slow();
  await tick();
  assert.equal(status.textContent, 'Ancora un momento: il caricamento è lento.');
  assert.ok(!classes(status).includes('sr-only'), 'after 3 s the words show');
  release();
  await loading;
  assert.ok(cardOf(mount, 'a'), 'the board comes');
  assert.ok(!mount.textContent.includes('il caricamento è lento'), 'and the slow words go with the skeleton');
});

test('85630aa14a4f: a slow move keeps saying the wait while it flags the slowness', async () => {
  let slow = () => {};
  const { mount, client } = await board([record('a', 'discovery')], {
    wait: (ms) => (ms === MOVE_SLOW_MS ? new Promise((resolve) => { slow = resolve; }) : new Promise(() => {})),
  });
  drop(mount, 'a', 'demo');
  await tick();
  assert.equal(client.posts.length, 1, 'the write is still running');
  const status = cardOf(mount, 'a').findAll('small').find((node) => node.getAttribute('role') === 'status');
  assert.ok(status.textContent.includes('Spostamento in corso…'), 'the wait is said at once');
  slow();
  await tick();
  assert.ok(status.textContent.includes('Spostamento in corso…'), 'and still said after 3 s');
  assert.ok(status.textContent.includes('Ancora un momento: il salvataggio è lento.'), 'with the slow note beside it');
  client.posts[0].answer();
  await tick(8);
  assert.ok(!mount.textContent.includes('Spostamento in corso'), 'the wait leaves with the answer');
});

test('fd0adcded1c3: a fast read never shows the slow words, even when its 3 s timer fires later', async () => {
  let slow = () => {};
  const { mount } = await board([record('a', 'discovery')], {
    wait: (ms) => (ms === MOVE_SLOW_MS ? new Promise((resolve) => { slow = resolve; }) : new Promise(() => {})),
  });
  slow();
  await tick();
  assert.ok(cardOf(mount, 'a'), 'the board is on screen');
  assert.ok(!mount.textContent.includes('il caricamento è lento'), 'no slow words on a painted board');
});
