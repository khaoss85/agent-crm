import test from 'node:test';
import assert from 'node:assert/strict';
// Namespace imports: on the code before this voice the file still loads, so
// every test fails on its own assertion (the behaviour), never on a
// missing export.
import * as pipelineModule from '../apps/admin/public/admin-pipeline.js';
import * as ui from '../apps/admin/public/admin-ui.js';

const { createPipelineBoard } = pipelineModule;
const MOVE_SLOW_MS = pipelineModule.MOVE_SLOW_MS ?? 3000;
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:3d811389bb4c (verifica sul pilota 4f44cd5):
 * - «Spostata in …» compare solo con la card ferma nella colonna nuova
 *   (anche da «Sposta» e da «Cambia fase», non solo dal trascinamento);
 * - con «Annulla» card e messaggio tornano subito insieme;
 * - dopo 3 s di attesa la card lo dice; il 503 «spazio in avvio» è detto in
 *   parole semplici, mai «Riprova più tardi»;
 * - i messaggi della Pipeline si chiudono cambiando pagina;
 * - mentre carica, uno scheletro di colonne e card.
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

function server(initial, { readGate = null } = {}) {
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
            answer: () => { records = records.map((item) => (item.id === id ? { ...item, pipelineStage: toStage } : item)); resolve({ ok: true }); },
            fail: (error) => reject(error),
          });
        });
      }
      if (readGate) await readGate();
      return { items: records };
    },
  };
}

const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const where = (mount, id) => cardOf(mount, id)?.parentNode?.getAttribute('data-stage') ?? null;

async function board(records, { wait, readGate } = {}) {
  const mount = createMount();
  const client = server(records, { readGate });
  const events = [];
  const view = createPipelineBoard({
    doc: createFakeDocument(), mount, client,
    // Every toast records where the card was at that moment.
    toast: (message, error, options) => events.push({ message: String(message), error: Boolean(error), options, cardAt: where(mount, 'a') }),
    navigate: () => {},
    wait: wait ?? (() => new Promise(() => {})),
  });
  await view.renderBoard('b2b-sales');
  return { mount, client, events, view };
}

test('3d811389bb4c: «Spostata» from Sposta shows only once the card sits in its new column', async () => {
  const { mount, events } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  const moved = events.find((item) => item.message === 'Spostata in Prova.');
  assert.ok(moved, 'the message shows');
  assert.equal(moved.cardAt, 'demo', 'and the card was already in Prova when it did');
  assert.equal(where(mount, 'a'), 'demo');
});

test('3d811389bb4c: «Annulla» brings card and message back at the click, even while the write runs', async () => {
  const { mount, client, events } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  events.find((item) => item.message === 'Spostata in Prova.').options.action.run();
  const back = events.find((item) => item.message === 'Riportata in Richiesta info.');
  assert.ok(back, '«Riportata» at the click');
  assert.equal(back.cardAt, 'discovery', 'with the card already back');
  assert.equal(client.posts.length, 1, 'the first write is still running');
  client.posts[0].answer();
  await tick(8);
  assert.equal(client.posts.length, 2, 'then the reverse write follows');
  assert.equal(where(mount, 'a'), 'discovery', 'the card never jumped back to Prova');
  client.posts[1].answer();
  await tick(8);
  assert.equal(where(mount, 'a'), 'discovery');
});

test('3d811389bb4c: a move still running after 3 s says so on its card', async () => {
  let slow = () => {};
  const { mount } = await board([record('a', 'discovery')], {
    wait: (ms) => (ms === MOVE_SLOW_MS ? new Promise((resolve) => { slow = resolve; }) : new Promise(() => {})),
  });
  assert.equal(pipelineModule.MOVE_SLOW_MS, 3000, 'the slow signal comes after 3 s');
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  assert.ok(cardOf(mount, 'a').textContent.includes('Spostamento in corso…'));
  slow();
  await tick();
  assert.ok(cardOf(mount, 'a').textContent.includes('Ancora un momento: il salvataggio è lento.'), 'the slow signal');
});

test('3d811389bb4c: a 503 «spazio in avvio» reads as a wait in plain words, never «Riprova più tardi»', async () => {
  const { mount, client, events } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  client.posts[0].fail(Object.assign(new Error('Spazio di lavoro in avvio'), { status: 503, code: 'WORKSPACE_STARTING' }));
  await tick();
  const last = events[events.length - 1];
  assert.equal(last.message, 'Il servizio si sta avviando: attendi qualche secondo e riprova.');
  assert.ok(!events.some((item) => item.message.includes('Riprova più tardi')));
  assert.equal(where(mount, 'a'), 'discovery', 'the card is back where it was');
});

test('3d811389bb4c: a Pipeline toast closes when the person leaves the page; others stay', () => {
  const doc = createFakeDocument();
  const node = createMount();
  node.setAttribute('class', 'toast hidden');
  const toaster = ui.createToastController(doc, node, { setTimer: () => ({}), clearTimer: () => {}, now: () => 0 });
  assert.equal(typeof toaster.hideScope, 'function', 'the toast knows which screen raised it');
  toaster.show('Spostata in Prova.', false, { scope: 'pipeline', action: { label: 'Annulla', run: () => {} } });
  toaster.hideScope('clienti');
  assert.ok(!node.classList.contains('hidden'), 'another screen\'s close leaves it');
  toaster.hideScope('pipeline');
  assert.ok(node.classList.contains('hidden'), 'leaving the Pipeline closes it');
  toaster.show('Salvato.');
  toaster.hideScope('pipeline');
  assert.ok(!node.classList.contains('hidden'), 'a toast of no screen stays');
});

test('3d811389bb4c: the shell closes the Pipeline\'s messages on a route change', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes("scope: 'pipeline'"), 'the Pipeline toasts carry their screen');
  assert.ok(/addEventListener\('hashchange', \(\) => \{\s*if \(toaster !== null && !\/\^#\\\/pipelines\?/.test(app),
    'a route change away from the Pipeline closes them');
});

test('3d811389bb4c: while the board loads, a skeleton of columns and cards — the words only for a screen reader', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const mount = createMount();
  const client = server([record('a', 'discovery')], { readGate: () => gate });
  const view = createPipelineBoard({ doc: createFakeDocument(), mount, client, toast: () => {}, wait: () => new Promise(() => {}) });
  const loading = view.renderBoard('b2b-sales');
  await tick();
  const skeleton = mount.findAll('section').find((n) => n.getAttribute('data-skeleton') === 'board');
  assert.ok(skeleton, 'a skeleton paints');
  assert.equal(skeleton.getAttribute('aria-busy'), 'true');
  assert.equal(skeleton.findAll('div').filter((n) => classes(n).includes('pipeline-skeleton-column')).length, 4, 'columns');
  assert.ok(skeleton.findAll('div').filter((n) => classes(n).includes('pipeline-skeleton-card')).length >= 4, 'cards');
  const status = skeleton.findAll('p').find((n) => n.getAttribute('role') === 'status');
  assert.equal(status.textContent, 'Caricamento…');
  assert.ok(classes(status).includes('sr-only'), 'the words are for a screen reader only');
  release();
  await loading;
  assert.equal(mount.findAll('section').find((n) => n.getAttribute('data-skeleton') === 'board'), undefined, 'the board replaces it');
});

test('3d811389bb4c: an undo the server refuses puts card and numbers back in the new column, with a clear message', async () => {
  const { mount, client, events } = await board([record('a', 'discovery'), record('b', 'demo')]);
  const count = (stage) => mount.findAll('span').find((n) => n.getAttribute('data-count') === stage).textContent;
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  client.posts[0].answer();
  await tick(8);
  assert.deepEqual([where(mount, 'a'), count('discovery'), count('demo')], ['demo', '0', '2'], 'moved');
  events.find((item) => item.message === 'Spostata in Prova.').options.action.run();
  await tick(8);
  assert.deepEqual([where(mount, 'a'), count('discovery'), count('demo')], ['discovery', '1', '1'], 'undone on screen at once');
  client.posts[1].fail(Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' }));
  await tick(8);
  assert.deepEqual([where(mount, 'a'), count('discovery'), count('demo')], ['demo', '0', '2'], 'card and numbers back where the server has them');
  const last = events[events.length - 1];
  assert.equal(last.error, true);
  assert.equal(last.message, 'Non sono riuscito a riportarla in Richiesta info: resta in Prova.');
});

test('3d811389bb4c: an undo refused by a waking workspace says so in plain words', async () => {
  const { mount, client, events } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  client.posts[0].answer();
  await tick(8);
  events.find((item) => item.message === 'Spostata in Prova.').options.action.run();
  await tick(8);
  client.posts[1].fail(Object.assign(new Error('Spazio di lavoro in avvio'), { status: 503, code: 'WORKSPACE_STARTING' }));
  await tick(8);
  assert.equal(where(mount, 'a'), 'demo');
  assert.equal(events[events.length - 1].message,
    'Non sono riuscito a riportarla in Richiesta info: resta in Prova. Il servizio si sta avviando: riprova tra qualche secondo.');
});
