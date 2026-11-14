import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineBoard, UNDO_TOAST_MS } from '../apps/admin/public/admin-pipeline.js';
import { createToastController } from '../apps/admin/public/admin-ui.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:2f72000d4a4d (verifica su pilota 6b886ee):
 * 1. il toast «Spostata in X · Annulla» arriva subito al rilascio, non dopo
 *    la scrittura (~4 s sul pilota), e resta almeno 10 s, o finché la
 *    persona ci sta sopra;
 * 2. «Cambia fase» nel pannello parte dalla fase attuale dell'offerta.
 * Più i seguiti della review Muse di #799: «Annulla» non è mai
 * fire-and-forget, e «Senza azienda» si riconosce in ogni forma.
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
    id, name: `Offerta ${id}`, companyId: 'co1', companyName: 'Palestra Esempio', valueCents: 100_000,
    currency: 'EUR', pipelineKey: 'b2b-sales', pipelineStage: stage, ...extra,
  };
}

/** A server whose POST answers when the test says so (`posts[i].answer()` / `.fail()`). */
function server(initial) {
  let records = initial.map((item) => ({ ...item }));
  const calls = [];
  const posts = [];
  return {
    calls,
    posts,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
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
            pend: () => reject(Object.assign(new Error('Scrittura in attesa'), { status: 504, code: 'BO_CRM_PENDING' })),
          });
        });
      }
      return { items: records };
    },
  };
}

const tick = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const panelOf = (mount) => mount.findAll('div').find((n) => n.getAttribute('data-offer-drawer') !== null);

async function board(records) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = server(records);
  const toasts = [];
  const view = createPipelineBoard({
    doc, mount, client,
    toast: (message, error, options) => toasts.push({ message: String(message), error: Boolean(error), options }),
    hideToast: () => toasts.push({ message: '<hidden>', error: false }),
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
  const column = mount.findAll('div').find((n) => n.getAttribute('data-stage') === stage);
  column.dispatch('dragover', { preventDefault() {} });
  column.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
}

// ---- 1. The toast comes at once and stays ---------------------------------

test('2f72000d4a4d + fd0adcded1c3: at the drop a neutral toast with «Annulla»; «Spostata» only after the server, for at least 10 s', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery')]);
  drop(mount, 'a', 'demo');
  await tick();
  assert.equal(client.posts.length, 1, 'the write is still running');
  const moving = toasts.find((item) => item.message === 'Spostamento in Prova…');
  assert.ok(moving, 'the toast is already there, and says the move is under way');
  assert.equal(moving.options?.action?.label, 'Annulla', '«Annulla» possible at once, as before');
  assert.ok(UNDO_TOAST_MS >= 10000 && moving.options.duration >= 10000, 'it asks to stay at least 10 s');
  assert.ok(!toasts.some((item) => item.message.startsWith('Spostata')), 'never «Spostata» while the write runs');
  client.posts[0].answer();
  await tick();
  const moved = toasts.filter((item) => item.message.startsWith('Spostata'));
  assert.equal(moved.length, 1, 'one «Spostata» when the write lands');
  assert.equal(moved[0].message, 'Spostata in Prova.');
  assert.equal(moved[0].options?.action?.label, 'Annulla');
  assert.ok(moved[0].options.duration >= 10000);
});

test('2f72000d4a4d: «Annulla» pressed while the move is being written undoes it as soon as it lands', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery')]);
  drop(mount, 'a', 'demo');
  await tick();
  toasts.find((item) => item.message === 'Spostamento in Prova…').options.action.run();
  await tick();
  assert.equal(client.posts.length, 1, 'no reverse POST before the first one lands');
  // backlog:3d811389bb4c: the card and «Riportata» come back at the click,
  // the reverse write follows once the first one lands.
  assert.ok(toasts.some((item) => item.message === 'Riportata in Richiesta info.'), 'the message is back at once');
  assert.equal(cardOf(mount, 'a').parentNode.getAttribute('data-stage'), 'discovery', 'and so is the card');
  client.posts[0].answer();
  await tick(6);
  assert.equal(client.posts.length, 2);
  assert.deepEqual(client.posts[1].body, { toStage: 'discovery', fromStage: 'demo', first: true }, 'the reverse move, back to the place it left');
  client.posts[1].answer();
  await tick(6);
  assert.ok(toasts.some((item) => item.message === 'Riportata in Richiesta info.'));
  assert.equal(cardOf(mount, 'a').parentNode.getAttribute('data-stage'), 'discovery');
});

test('2f72000d4a4d + fd0adcded1c3 + 85630aa14a4f: a failed move takes the waiting toast down, says why on the card, never «Spostata», and «Annulla» then does nothing', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery')]);
  drop(mount, 'a', 'demo');
  await tick();
  const moved = toasts.find((item) => item.message === 'Spostamento in Prova…');
  client.posts[0].fail();
  await tick();
  // backlog:85630aa14a4f: one message, on the card beside its Riprova; the
  // waiting toast goes away instead of turning into a red copy.
  assert.equal(toasts[toasts.length - 1].message, '<hidden>', 'the waiting toast is taken down');
  assert.ok(!toasts.some((item) => item.error), 'no red toast repeating the card');
  const error = cardOf(mount, 'a').childNodes.find((n) => classes(n).includes('field-error'));
  assert.equal(error.textContent, 'Spostamento non riuscito.');
  assert.ok(!toasts.some((item) => item.message.startsWith('Spostata')), 'the screen never said the move was saved');
  moved.options.action.run();
  await tick();
  assert.equal(client.posts.length, 1, 'nothing to undo');
});

test('review Muse #799: an undo that fails on a filtered-out card still says so', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'discovery')]);
  // Filter the board to Richiesta info: once moved, card a leaves the view.
  const stati = mount.findAll('div').find((n) => n.getAttribute('data-filtermenu') === 'stage');
  stati.findAll('button').find((n) => n.getAttribute('data-value') === 'discovery').dispatch('click');
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  const moving = card.__move();
  await tick();
  client.posts[0].answer();
  await moving;
  await tick();
  assert.equal(cardOf(mount, 'a'), undefined, 'the card left the filtered board');
  toasts.find((item) => item.message === 'Spostata in Prova.').options.action.run();
  await tick(6);
  client.posts[1].fail();
  await tick(6);
  const last = toasts[toasts.length - 1];
  assert.equal(last.error, true, 'the failed undo toasts');
  // backlog:3d811389bb4c: the toast says where the card stays.
  assert.equal(last.message, 'Non sono riuscito a riportarla in Richiesta info: resta in Prova.');
});

// ---- The shell toast's clock ----------------------------------------------

test('2f72000d4a4d: the shell toast keeps «Annulla» 10 s, never hides under the pointer, closes on the action', () => {
  const doc = createFakeDocument();
  const node = createMount();
  node.setAttribute('class', 'toast ui-toast hidden');
  const timers = [];
  let at = 0;
  const clock = {
    setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.live = false; },
    now: () => at,
  };
  const live = () => timers.filter((timer) => timer.live);
  const toaster = createToastController(doc, node, clock);
  let undone = 0;
  toaster.show('Spostata in Prova.', false, { action: { label: 'Annulla', run: () => { undone += 1; } } });
  assert.ok(!node.classList.contains('hidden'));
  assert.deepEqual(live().map((timer) => timer.ms), [10000], 'an action toast stays 10 s');

  at = 12000; // the pointer arrives after the minimum went by
  node.dispatch('mouseenter');
  assert.equal(live().length, 0, 'under the pointer it never hides');
  node.dispatch('mouseleave');
  assert.deepEqual(live().map((timer) => timer.ms), [4000], 'after the pointer leaves, 4 s more');
  live()[0].fn();
  assert.ok(node.classList.contains('hidden'));

  toaster.show('Spostata in Prova.', false, { action: { label: 'Annulla', run: () => { undone += 1; } } });
  node.dispatch('focusin');
  assert.equal(live().length, 0, 'keyboard focus holds it too');
  node.findAll('button')[0].dispatch('click');
  assert.equal(undone, 1);
  assert.ok(node.classList.contains('hidden'), 'the action closes it at once');

  node.dispatch('focusout');
  toaster.show('Salvato.');
  assert.deepEqual(live().map((timer) => timer.ms), [3200], 'a plain toast keeps its short life');
});

// ---- 2. Cambia fase starts on the current stage ----------------------------

test('2f72000d4a4d: «Cambia fase» starts on the offer\'s own stage, and Sposta waits for another one', async () => {
  const { mount, client } = await board([record('a', 'demo')]);
  cardOf(mount, 'a').__open();
  const panel = panelOf(mount);
  const select = panel.findAll('select')[0];
  assert.equal(select.value, 'demo', 'the menu shows Prova, the current stage — not Richiesta info');
  const current = select.findAll('option').find((n) => n.getAttribute('value') === 'demo');
  assert.equal(current.textContent, 'Prova (attuale)');
  const go = panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move');
  assert.equal(go.disabled, true, 'nothing to move to yet');
  go.dispatch('click');
  await tick();
  assert.equal(client.posts.length, 0);
  select.value = 'discovery';
  select.dispatch('change');
  assert.equal(go.disabled, false, 'another stage chosen: Sposta is ready');
  go.dispatch('click');
  await tick();
  assert.deepEqual(client.posts[0].body, { toStage: 'discovery', fromStage: 'demo' });
});

test('review Muse #799: «Senza azienda» is no customer in any case, spacing or Unicode form', async () => {
  const { mount } = await board([
    record('a', 'discovery', { companyName: ' SENZA  AZIENDA ' }),
    record('b', 'discovery', { companyName: 'senza azienda' }),
  ]);
  const company = (id) => cardOf(mount, id).findAll('p').find((n) => classes(n).includes('card-company')).textContent;
  assert.equal(company('a'), '—');
  assert.equal(company('b'), '—');
});

test('2f72000d4a4d: a failed move logs the shared write line, never «spostamento non riuscito»', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  const lines = [];
  const original = console.error;
  console.error = (text) => { lines.push(String(text)); };
  try {
    drop(mount, 'a', 'demo');
    await tick();
    client.posts[0].fail();
    await tick();
  } finally {
    console.error = original;
  }
  assert.ok(lines.includes('[bo] scrittura fallita POST /api/modules/opportunity/records/a/actions/move-stage · 500 INTERNAL: boom'),
    `the shared format (${lines.join(' | ')})`);
  assert.ok(!lines.some((line) => line.includes('spostamento non riuscito')), 'the old line is gone');
});

// ---- Review Muse #809, giro 2 ----------------------------------------------

function clockedToaster() {
  const doc = createFakeDocument();
  const node = createMount();
  node.setAttribute('class', 'toast ui-toast hidden');
  const timers = [];
  const state = { at: 0 };
  const toaster = createToastController(doc, node, {
    setTimer: (fn, ms) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.live = false; },
    now: () => state.at,
  });
  return { node, toaster, state, live: () => timers.filter((timer) => timer.live) };
}

test('review #809: a short hover early on never cuts the 10 s minimum short', () => {
  const { node, toaster, state, live } = clockedToaster();
  toaster.show('Spostata in Prova.', false, { action: { label: 'Annulla', run: () => {} } });
  state.at = 1000;
  node.dispatch('mouseenter');
  state.at = 2000;
  node.dispatch('mouseleave');
  assert.deepEqual(live().map((timer) => timer.ms), [8000], 'it still stays until t = 10 s');
});

test('review #809: pointer and keyboard hold the toast independently', () => {
  const { node, toaster, state, live } = clockedToaster();
  toaster.show('Spostata in Prova.', false, { action: { label: 'Annulla', run: () => {} } });
  state.at = 20000;
  node.dispatch('focusin');
  node.dispatch('mouseenter');
  node.dispatch('mouseleave');
  assert.equal(live().length, 0, 'focus is still inside: it stays');
  node.dispatch('mouseenter');
  node.dispatch('focusout');
  assert.equal(live().length, 0, 'the pointer is still on it: it stays');
  node.dispatch('mouseleave');
  assert.deepEqual(live().map((timer) => timer.ms), [4000], 'both gone: 4 s more');
});

test('review #809: «Annulla» on a move the server queued says it cannot undo yet, never silence', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery')]);
  drop(mount, 'a', 'demo');
  await tick();
  toasts.find((item) => item.message === 'Spostamento in Prova…').options.action.run();
  client.posts[0].pend();
  await tick(6);
  assert.equal(client.posts.length, 1, 'no reverse POST on a queued move');
  const last = toasts[toasts.length - 1];
  assert.equal(last.error, true);
  assert.match(last.message, /^Non ancora confermato: lo spostamento è ancora in coda, non posso annullarlo adesso/);
});

test('review #809: a queued undo is announced even when its card is on screen', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery')]);
  drop(mount, 'a', 'demo');
  await tick();
  client.posts[0].answer();
  await tick(6);
  assert.ok(cardOf(mount, 'a'), 'the card is on screen');
  toasts.find((item) => item.message === 'Spostata in Prova.').options.action.run();
  await tick(6);
  client.posts[1].pend();
  await tick(6);
  const last = toasts[toasts.length - 1];
  assert.equal(last.message, 'Non ancora confermato: ricarica la pipeline tra poco.');
  assert.equal(last.error, true);
});
