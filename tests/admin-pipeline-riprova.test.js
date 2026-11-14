import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Namespace import: on the code before this voice the file still loads, so
// every test fails on its own assertion (the behaviour).
import * as pipelineModule from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const { createPipelineBoard } = pipelineModule;

/**
 * backlog:85630aa14a4f (verifica 14/11 03:45Z, pilota 8057b69 con agent-crm
 * aba3ec3, punto d): dopo uno spostamento fallito (500, 409) il «Riprova»
 * della card apriva il pannello dell'offerta e non mandava nessuna POST.
 * Nel browser vero: la pressione su Riprova dava il focus alla card, la riga
 * «Sposta in» (solo tastiera) compariva con :focus-within, la card si
 * allungava sotto il puntatore e il clic finiva sulla card.
 * Nella stessa zona:
 * - dopo un 409 STALE_STAGE niente Riprova, e il messaggio sparisce con la
 *   card al posto giusto (admin-pipeline.test.js);
 * - un solo messaggio, coerente con il pulsante: «Spostamento non riuscito.»
 *   + Riprova, non anche un toast rosso;
 * - chiudendo il pannello col mouse il focus torna sulla card aperta, senza
 *   anello;
 * - la card aperta si riconosce bene.
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

/** POSTs wait for the test: answer() lands the move, fail(error) refuses it. */
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
        const body = JSON.parse(options.body);
        return new Promise((resolve, reject) => {
          posts.push({
            id, body,
            answer: () => { records = records.map((item) => (item.id === id ? { ...item, pipelineStage: body.toStage } : item)); resolve({ ok: true }); },
            fail: (error = Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' })) => reject(error),
          });
        });
      }
      return { items: records };
    },
  };
}

function listeningDocument() {
  const doc = createFakeDocument();
  const listeners = Object.create(null);
  doc.addEventListener = (type, handler) => { (listeners[type] ??= []).push(handler); };
  doc.removeEventListener = (type, handler) => { listeners[type] = (listeners[type] ?? []).filter((item) => item !== handler); };
  doc.dispatch = (type, event = {}) => { for (const handler of [...(listeners[type] ?? [])]) handler(event); };
  return doc;
}

const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const columnOf = (mount, stage) => mount.findAll('div').find((n) => n.getAttribute('data-stage') === stage);
const panelOf = (mount) => mount.findAll('div').find((n) => n.getAttribute('data-offer-drawer') !== null);
const retryOf = (card) => card.findAll('button').find((n) => n.getAttribute('data-action') === 'move-retry');
const apriOf = (card) => card.findAll('button').find((n) => n.getAttribute('data-action') === 'open-offer');
const errorOf = (card) => card.childNodes.find((n) => classes(n).includes('field-error'));
const where = (mount, id) => cardOf(mount, id)?.parentNode?.getAttribute('data-stage') ?? null;
const order = (mount, stage) => columnOf(mount, stage).childNodes
  .filter((n) => classes(n).includes('pipeline-card')).map((n) => n.getAttribute('data-record'));

async function board(records, { doc = createFakeDocument(), wait } = {}) {
  const mount = createMount();
  const client = server(records);
  const toasts = [];
  let hidden = 0;
  const view = createPipelineBoard({
    doc, mount, client,
    toast: (message, error, options) => toasts.push({ message: String(message), error: Boolean(error), options }),
    hideToast: () => { hidden += 1; },
    navigate: () => {},
    wait: wait ?? (() => new Promise(() => {})),
  });
  await view.renderBoard('b2b-sales');
  return { mount, client, toasts, view, hidden: () => hidden };
}

/** A drop of card `id` onto `stage`, under the card `afterId` (null: on top). */
function drop(mount, id, stage, afterId) {
  const store = {};
  const transfer = { setData(type, value) { store[type] = value; }, getData(type) { return store[type] ?? ''; } };
  cardOf(mount, id).dispatch('dragstart', { dataTransfer: transfer });
  const column = columnOf(mount, stage);
  // The slot sits under the pointer: below the middle of `afterId`.
  for (const node of column.childNodes) {
    if (!classes(node).includes('pipeline-card')) continue;
    const at = order(mount, stage).indexOf(node.getAttribute('data-record'));
    node.getBoundingClientRect = () => ({ top: at * 100, height: 80, left: 0, width: 200 });
  }
  const y = afterId === null ? 10 : order(mount, stage).indexOf(afterId) * 100 + 70;
  column.dispatch('dragover', { preventDefault() {}, clientY: y });
  column.dispatch('drop', { preventDefault() {}, clientY: y, dataTransfer: transfer });
}

// ---- d) Riprova sends the same move again ----------------------------------

test('85630aa14a4f: after a failed drop, Riprova sends the same move again — same column, same place — as a new POST', async () => {
  const { mount, client } = await board([record('a', 'discovery'), record('b', 'demo'), record('c', 'demo')]);
  drop(mount, 'a', 'demo', 'b');
  await tick();
  assert.deepEqual(client.posts[0].body, { toStage: 'demo', fromStage: 'discovery', afterId: 'b' });
  client.posts[0].fail();
  await tick();
  assert.equal(where(mount, 'a'), 'discovery', 'the card went back');
  const card = cardOf(mount, 'a');
  const retry = retryOf(card);
  assert.ok(!classes(retry).includes('hidden'), 'Riprova shows');
  let stopped = false;
  retry.dispatch('click', { stopPropagation() { stopped = true; } });
  assert.ok(stopped, 'the click is Riprova\'s alone: it never reaches the card');
  assert.equal(retry.getAttribute('aria-busy'), 'true', 'Riprova waits (uiBusy) while the move is sent again');
  await tick();
  assert.equal(client.posts.length, 2, 'a second POST — not a board read');
  assert.deepEqual(client.posts[1].body, { toStage: 'demo', fromStage: 'discovery', afterId: 'b' }, 'the same move, to the same place');
  assert.deepEqual(order(mount, 'demo'), ['b', 'a', 'c'], 'the card is seated there again at once');
  assert.equal(panelOf(mount), undefined, 'no offer panel opened');
  client.posts[1].answer();
  await tick();
  assert.equal(where(mount, 'a'), 'demo', 'the move landed');
  assert.ok(!mount.textContent.includes('Spostamento non riuscito'), 'and the failure line is gone');
});

test('85630aa14a4f: Riprova from Sposta too, and a second failure keeps Riprova', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  client.posts[0].fail(Object.assign(new Error('conflict'), { status: 409, code: 'CONFLICT' }));
  await tick();
  // A lost 409 is a superseded move: no Riprova (see below). A 500 next.
  const fresh = cardOf(mount, 'a');
  fresh.__select.value = 'demo';
  void fresh.__move();
  await tick();
  client.posts[1].fail();
  await tick();
  retryOf(cardOf(mount, 'a')).dispatch('click', { stopPropagation() {} });
  await tick();
  assert.equal(client.posts.length, 3);
  assert.deepEqual(client.posts[2].body, { toStage: 'demo', fromStage: 'discovery' });
  client.posts[2].fail();
  await tick();
  const again = retryOf(cardOf(mount, 'a'));
  assert.ok(!classes(again).includes('hidden'), 'failed again: Riprova is there again');
  assert.notEqual(again.getAttribute('aria-busy'), 'true', 'and ready');
  assert.equal(errorOf(cardOf(mount, 'a')).textContent, 'Spostamento non riuscito.');
});

test('85630aa14a4f: a press that starts on Riprova never opens the panel, even if the click lands on the card', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  client.posts[0].fail();
  await tick();
  const failed = cardOf(mount, 'a');
  const retry = retryOf(failed);
  // The real browser on 14/11: pointerdown on Riprova, the card grew under
  // the pointer, the click arrived on the card itself.
  failed.dispatch('pointerdown', { target: { closest: (selector) => (selector.includes('button') ? retry : null) } });
  failed.dispatch('click', { target: failed });
  assert.equal(panelOf(mount), undefined, 'no offer panel');
  // A plain press on the card still opens it.
  failed.dispatch('pointerdown', { target: { closest: () => null } });
  failed.dispatch('click', { target: failed });
  assert.ok(panelOf(mount), 'a click on the card body opens the panel as before');
});

test('85630aa14a4f: the «Sposta in» row opens on keyboard focus only, never on a mouse press inside the card', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(!/\.pipeline-card:focus-within \.card-move/.test(css), 'no :focus-within reveal (a mouse press on Riprova moved the card under the pointer)');
  assert.match(css, /\.pipeline-card:has\(:focus-visible\) \.card-move \{[^}]*position: static/, 'the keyboard still reveals it');
});

// ---- One message, matching the button --------------------------------------

test('85630aa14a4f: a failure on a card says it once — on the card, beside Riprova — and the waiting toast goes away', async () => {
  const { mount, client, toasts, hidden } = await board([record('a', 'discovery')]);
  drop(mount, 'a', 'demo', null);
  await tick();
  client.posts[0].fail();
  await tick();
  const card = cardOf(mount, 'a');
  assert.equal(errorOf(card).textContent, 'Spostamento non riuscito.', 'the words match the Riprova next to them');
  assert.ok(!mount.textContent.includes('Riprova più tardi'), 'never «Riprova più tardi» beside a Riprova');
  assert.ok(!toasts.some((item) => item.error), 'no red toast repeating it');
  assert.equal(hidden(), 1, 'the «Spostamento in Prova…» toast is taken down');
});

test('85630aa14a4f: a card no one sees (filtered out) still hears it — one toast, with the same Riprova', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'discovery')]);
  const stati = mount.findAll('div').find((n) => n.getAttribute('data-filtermenu') === 'stage');
  stati.findAll('button').find((n) => n.getAttribute('data-value') === 'discovery').dispatch('click');
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  // The filtered board drops the card from view while the write runs.
  const search = mount.findAll('input').find((n) => n.getAttribute('data-filter') === 'q');
  search.value = 'Offerta b';
  search.dispatch('input');
  assert.equal(cardOf(mount, 'a'), undefined, 'card a is not on screen');
  client.posts[0].fail();
  await tick();
  const said = toasts.filter((item) => item.error);
  assert.equal(said.length, 1, 'said once');
  assert.equal(said[0].message, 'Spostamento non riuscito.');
  assert.equal(said[0].options?.action?.label, 'Riprova', 'with Riprova');
  said[0].options.action.run();
  await tick();
  assert.equal(client.posts.length, 2, 'which sends the move again');
  assert.deepEqual(client.posts[1].body, { toStage: 'demo', fromStage: 'discovery' });
});

test('85630aa14a4f: a refusal that would only repeat (TERMINAL_STAGE) shows its line without Riprova', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  void card.__move();
  await tick();
  client.posts[0].fail(Object.assign(new Error('closed'), { status: 409, code: 'TERMINAL_STAGE' }));
  await tick();
  const failed = cardOf(mount, 'a');
  assert.equal(errorOf(failed).textContent, "Un'offerta chiusa non cambia più fase.");
  assert.ok(classes(retryOf(failed)).includes('hidden'), 'no Riprova: sending it again would be refused again');
});

// ---- Closing the panel with the mouse ---------------------------------------

test('85630aa14a4f: a press on empty board closes the panel and gives focus back to the card, with no ring', async () => {
  const doc = listeningDocument();
  const { mount } = await board([record('a', 'discovery'), record('b', 'demo')], {
    doc, wait: (ms) => (ms === 0 ? Promise.resolve() : new Promise(() => {})),
  });
  const apri = apriOf(cardOf(mount, 'a'));
  const focusCalls = [];
  apri.focus = (options) => { focusCalls.push(options ?? null); };
  apri.dispatch('click');
  assert.ok(panelOf(mount));
  doc.activeElement = doc.body;
  doc.dispatch('pointerdown', { target: columnOf(mount, 'demo') });
  assert.equal(panelOf(mount), undefined, 'the panel closed');
  await tick();
  assert.equal(focusCalls.length, 1, 'focus is back on the open card (its Apri)');
  assert.deepEqual(focusCalls[0], { preventScroll: true, focusVisible: false }, 'without the ring, without a jump');
});

test('85630aa14a4f: a press outside on a field keeps focus there', async () => {
  const doc = listeningDocument();
  const { mount } = await board([record('a', 'discovery')], {
    doc, wait: (ms) => (ms === 0 ? Promise.resolve() : new Promise(() => {})),
  });
  const apri = apriOf(cardOf(mount, 'a'));
  const focusCalls = [];
  apri.focus = (options) => { focusCalls.push(options ?? null); };
  apri.dispatch('click');
  const search = mount.findAll('input').find((n) => n.getAttribute('data-filter') === 'q');
  doc.activeElement = search; // the browser focused the pressed field
  doc.dispatch('pointerdown', { target: search });
  await tick();
  assert.equal(panelOf(mount), undefined, 'the panel closed');
  assert.equal(focusCalls.length, 0, 'the field keeps the focus');
});

// ---- The open card's mark ----------------------------------------------------

test('85630aa14a4f: the open card wears a full accent ring, kept under the pointer', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const rule = /\.pipeline-card\.is-open, \.pipeline-card\[data-openable="true"\]\.is-open:hover \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'one rule for the open card, hover included (the hover rule must not take the mark away)');
  assert.match(rule[1], /border-color: var\(--accent\)/);
  assert.match(rule[1], /box-shadow: 0 0 0 2px var\(--accent\)/, 'a 2 px accent ring around the border, not a hint');
});
