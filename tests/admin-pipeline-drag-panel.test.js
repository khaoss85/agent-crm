import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { createMountGate } from '../apps/admin/public/admin-navigation.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Dan 11/11, Pipeline:
 * 1. While a card is dragged, the column under the pointer shows a dashed
 *    placeholder as tall as the card, where the card lands. Offers carry no
 *    stored position (the list reads updated_at desc and a move bumps it),
 *    so the card lands on top of the new column and stays there after a
 *    reload: the placeholder sits there, and the source column offers none.
 *    Esc or a release outside a column moves nothing; during the write the
 *    card waits in its new place; a failure puts it back with the reason.
 * 2. Apri opens a side panel over the board (the scheda composer window):
 *    offer, customer, value, stage, Cambia fase, «Apri scheda cliente».
 *    ×, Esc and a click outside close it without re-rendering the board.
 */

const PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  movePath: '/api/modules/opportunity/records/:id/actions/move-stage',
  stages: [
    { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Vinta', order: 50, type: 'won', probability: 100 },
    { key: 'lost', label: 'Persa', order: 60, type: 'lost', probability: 0 },
  ],
};

function record(id, stage, extra = {}) {
  return {
    id,
    name: `Offerta ${id}`,
    companyId: 'co1',
    companyName: 'Palestra Esempio',
    valueCents: 100_000,
    currency: 'EUR',
    pipelineKey: 'b2b-sales',
    pipelineStage: stage,
    ...extra,
  };
}

/**
 * A server double: GET answers the current records (updated_at desc, like
 * OpportunityService.list), POST runs `onPost`. A successful move rewrites
 * the record's stage and puts it first, as the real list would.
 */
function server(initial, { onPost } = {}) {
  let records = initial.map((item) => ({ ...item }));
  const calls = [];
  return {
    calls,
    get records() { return records; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (options.method === 'POST') {
        if (onPost) await onPost(path, options);
        const id = decodeURIComponent(path.split('/records/')[1].split('/')[0]);
        const { toStage } = JSON.parse(options.body);
        const moved = records.find((item) => item.id === id);
        records = [{ ...moved, pipelineStage: toStage }, ...records.filter((item) => item.id !== id)];
        return { ok: true };
      }
      return { items: records };
    },
  };
}

/** A document that, like the real one, takes listeners (Esc, click outside). */
function listeningDocument() {
  const doc = createFakeDocument();
  const listeners = Object.create(null);
  doc.addEventListener = (type, handler) => { (listeners[type] ??= []).push(handler); };
  doc.removeEventListener = (type, handler) => {
    listeners[type] = (listeners[type] ?? []).filter((item) => item !== handler);
  };
  doc.dispatch = (type, event = {}) => { for (const handler of [...(listeners[type] ?? [])]) handler(event); };
  doc.listenerCount = (type) => (listeners[type] ?? []).length;
  return doc;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const columnOf = (mount, stage) => mount.findAll('div').find((n) => n.getAttribute('data-stage') === stage);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const slotsIn = (node) => node.findAll('div').filter((n) => classes(n).includes('pipeline-drop-slot'));
const cardIds = (column) => column.childNodes.filter((n) => classes(n).includes('pipeline-card')).map((n) => n.getAttribute('data-record'));
const panelOf = (mount) => mount.findAll('div').find((n) => n.getAttribute('data-offer-drawer') !== null);
const apriOf = (mount, id) => cardOf(mount, id).findAll('button').find((n) => n.getAttribute('data-action') === 'open-offer');
const dataTransfer = () => {
  const store = {};
  return { effectAllowed: 'all', setData(type, value) { store[type] = value; }, getData(type) { return store[type] ?? ''; } };
};

/** Start a drag on card `id`, as tall as `height`. */
function startDrag(mount, id, height = 92) {
  const card = cardOf(mount, id);
  card.getBoundingClientRect = () => ({ height, width: 240, top: 0, left: 0 });
  const transfer = dataTransfer();
  card.dispatch('dragstart', { dataTransfer: transfer });
  return { card, transfer };
}

async function board(records, options = {}) {
  const doc = options.doc ?? createFakeDocument();
  const mount = options.mount ?? createMount();
  const client = server(records, options);
  const toasts = [];
  const hashes = [];
  const view = createPipelineBoard({
    doc, mount, client,
    toast: (message, error) => toasts.push({ message: String(message), error: Boolean(error) }),
    navigate: (hash) => hashes.push(hash),
    wait: options.wait ?? (() => new Promise(() => {})),
  });
  await view.renderBoard('b2b-sales');
  return { doc, mount, client, toasts, hashes, view };
}

// ---- 1. Drag placeholder -------------------------------------------------

test('Dan 11/11: dragging over another column shows a dashed placeholder as tall as the card, on top', async () => {
  const { mount } = await board([record('a', 'discovery'), record('b', 'demo'), record('c', 'demo')]);
  startDrag(mount, 'a', 92);
  const demo = columnOf(mount, 'demo');
  let prevented = false;
  demo.dispatch('dragover', { preventDefault() { prevented = true; } });
  assert.ok(prevented, 'the column takes the drop');
  const slots = slotsIn(demo);
  assert.equal(slots.length, 1, 'one placeholder in the hovered column');
  assert.equal(slots[0].getAttribute('style'), 'height: 92px', 'as tall as the dragged card');
  assert.equal(slots[0].getAttribute('aria-hidden'), 'true', 'a visual cue only');
  const firstCard = demo.childNodes.findIndex((n) => classes(n).includes('pipeline-card'));
  assert.equal(demo.childNodes.indexOf(slots[0]), firstCard - 1, 'on top of the column, right before its first card');
  // Hovering again never duplicates it.
  demo.dispatch('dragover', { preventDefault() {} });
  assert.equal(slotsIn(mount).length, 1, 'still a single placeholder on the board');
  assert.deepEqual(cardIds(demo), ['b', 'c'], 'the placeholder is not a card: counts stay honest');
});

test('Dan 11/11: an empty column shows the placeholder too; it follows the pointer between columns', async () => {
  const { mount } = await board([record('a', 'discovery')]);
  startDrag(mount, 'a', 80);
  const demo = columnOf(mount, 'demo');
  const won = columnOf(mount, 'won');
  demo.dispatch('dragover', { preventDefault() {} });
  assert.equal(slotsIn(demo).length, 1, 'the empty column shows where the card lands');
  const empty = demo.childNodes.find((n) => classes(n).includes('empty'));
  assert.equal(demo.childNodes.indexOf(slotsIn(demo)[0]), demo.childNodes.indexOf(empty) - 1, 'above the «Trascina qui» line');
  won.dispatch('dragover', { preventDefault() {} });
  assert.equal(slotsIn(demo).length, 0, 'the old column lets it go');
  assert.equal(slotsIn(won).length, 1, 'the new column shows it');
  won.dispatch('dragleave', { relatedTarget: null });
  assert.equal(slotsIn(mount).length, 0, 'leaving the column removes it');
});

test('67a3116f4f65: with stored positions the source column takes the drop and shows the slot', async () => {
  const { mount } = await board([record('a', 'discovery'), record('b', 'discovery')]);
  startDrag(mount, 'a');
  const discovery = columnOf(mount, 'discovery');
  let prevented = false;
  discovery.dispatch('dragover', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'a reorder in the same column is a drop now');
  assert.equal(slotsIn(discovery).length, 1, 'the slot shows where the card would land');
});

test('Dan 11/11: Esc or a release outside a column (dragend alone) moves nothing and clears the placeholder', async () => {
  const { mount, client } = await board([record('a', 'discovery'), record('b', 'demo')]);
  const { card } = startDrag(mount, 'a');
  const demo = columnOf(mount, 'demo');
  demo.dispatch('dragover', { preventDefault() {} });
  assert.equal(slotsIn(mount).length, 1);
  card.dispatch('dragend', { dataTransfer: { dropEffect: 'none' } });
  assert.equal(slotsIn(mount).length, 0, 'the placeholder is gone');
  assert.ok(!classes(demo).includes('drop-target'), 'no column stays marked');
  assert.ok(!classes(card).includes('dragging'), 'the card is no longer flying');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing is written');
  assert.deepEqual(cardIds(columnOf(mount, 'discovery')), ['a'], 'the card stays in its column');
});

test('Dan 11/11: on drop the card sits where the placeholder was, waits for the write, and stays there after the reload', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const { mount, client, toasts } = await board(
    [record('a', 'discovery'), record('b', 'demo'), record('c', 'demo')],
    { onPost: () => gate },
  );
  const { card, transfer } = startDrag(mount, 'a');
  const demo = columnOf(mount, 'demo');
  demo.dispatch('dragover', { preventDefault() {} });
  demo.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
  await tick();
  assert.equal(slotsIn(mount).length, 0, 'the placeholder leaves on drop');
  assert.deepEqual(cardIds(demo), ['a', 'b', 'c'], 'the card is where the placeholder was: on top of Demo');
  assert.deepEqual(cardIds(columnOf(mount, 'discovery')), [], 'it left its old column');
  assert.equal(card.getAttribute('aria-busy'), 'true', 'the card waits while the write runs');
  assert.ok(card.textContent.includes('Spostamento in corso…'), 'and says so');
  const status = card.childNodes.find((n) => n.getAttribute('role') === 'status');
  assert.ok(status && !classes(status).includes('hidden'), 'the wait line sits on the card, outside the keyboard-only row');
  const post = client.calls.find((call) => call.method === 'POST');
  assert.ok(post.path.endsWith('/records/a/actions/move-stage'), 'the existing move-stage write');
  assert.deepEqual(JSON.parse(post.body), { toStage: 'demo', fromStage: 'discovery', first: true });
  release();
  await tick();
  await tick();
  // The re-read is the reload: the server's order puts the moved card on top.
  assert.deepEqual(cardIds(columnOf(mount, 'demo')), ['a', 'b', 'c'], 'after the reload the card is still where it was dropped');
  assert.ok(toasts.some((item) => item.message === 'Spostata in Demo.' && !item.error));
  // A fresh board from the same server, as after a page reload.
  const again = await board(client.records);
  assert.deepEqual(cardIds(columnOf(again.mount, 'demo')), ['a', 'b', 'c'], 'a page reload shows the same order');
});

test('giro UX 11/11: after a drop the board never blanks to «Caricamento…» while it re-reads', async () => {
  const { mount, client } = await board([record('a', 'discovery'), record('b', 'demo')]);
  // From now on every read waits: the pilot answers a list in 2,5-4 s.
  let releaseRead = () => {};
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const plain = client.request.bind(client);
  client.request = async (path, options = {}) => {
    if ((options.method ?? 'GET') === 'GET' && path !== '/api/schema') await readGate;
    return plain(path, options);
  };
  const { transfer } = startDrag(mount, 'a');
  const demo = columnOf(mount, 'demo');
  demo.dispatch('dragover', { preventDefault() {} });
  demo.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
  await tick();
  await tick();
  assert.ok(!mount.textContent.includes('Caricamento…'), 'the board stays on screen during the re-read');
  assert.deepEqual(cardIds(columnOf(mount, 'demo')), ['a', 'b'], 'with the card already in its new place');
  releaseRead();
  await tick();
  await tick();
  await tick();
  assert.deepEqual(cardIds(columnOf(mount, 'demo')), ['a', 'b'], 'and the re-read confirms it');
  assert.equal(cardOf(mount, 'a').getAttribute('aria-busy'), null, 'the fresh card is no longer waiting');
});

test('Dan 11/11: a failed drop puts the card back in its place with a clear message', async () => {
  const { mount, toasts } = await board(
    [record('x', 'discovery'), record('a', 'discovery'), record('y', 'discovery'), record('b', 'demo')],
    { onPost: () => { throw Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' }); } },
  );
  const { card, transfer } = startDrag(mount, 'a');
  const demo = columnOf(mount, 'demo');
  demo.dispatch('dragover', { preventDefault() {} });
  demo.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
  await tick();
  await tick();
  assert.deepEqual(cardIds(columnOf(mount, 'discovery')), ['x', 'a', 'y'], 'back in its old column, at its old place');
  assert.deepEqual(cardIds(demo), ['b'], 'gone from the target column');
  assert.equal(card.getAttribute('aria-busy'), 'false', 'no longer waiting');
  const error = card.childNodes.find((n) => classes(n).includes('field-error'));
  assert.ok(error && !classes(error).includes('hidden'), 'the reason shows on the card itself');
  // backlog:85630aa14a4f: one message, next to its Riprova — never a
  // second copy in a red toast.
  assert.equal(error.textContent, 'Spostamento non riuscito.');
  assert.ok(!classes(card.childNodes.find((n) => n.getAttribute?.('data-action') === 'move-retry')).includes('hidden'), 'with Riprova beside it');
  assert.ok(!toasts.some((item) => item.error), 'and no red toast repeating it');
});

test('Dan 11/11: a drop onto Vinta asks Conferma first and leaves the card in place', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  const { transfer } = startDrag(mount, 'a');
  const won = columnOf(mount, 'won');
  won.dispatch('dragover', { preventDefault() {} });
  won.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
  await tick();
  assert.equal(slotsIn(mount).length, 0, 'no placeholder left behind');
  assert.deepEqual(cardIds(columnOf(mount, 'discovery')), ['a'], 'the card waits in its column for Conferma');
  assert.ok(mount.textContent.includes('Segnare «Offerta a» come Vinta?'), 'Conferma shows');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing written before Conferma');
});

test('Dan 11/11: a card still being written cannot be dragged again', async () => {
  const { mount } = await board([record('a', 'discovery')], { onPost: () => new Promise(() => {}) });
  const { transfer } = startDrag(mount, 'a');
  const demo = columnOf(mount, 'demo');
  demo.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
  await tick();
  const card = cardOf(mount, 'a');
  card.dispatch('dragend', {});
  let prevented = false;
  card.dispatch('dragstart', { preventDefault() { prevented = true; }, dataTransfer: dataTransfer() });
  assert.ok(prevented, 'the busy card refuses a second drag');
});

// ---- 2. Apri panel -------------------------------------------------------

test('Dan 11/11: Apri opens a side panel over the board with offer, customer, value, stage and the scheda link', async () => {
  const { mount, hashes } = await board([record('a', 'discovery', {
    name: 'Cucina per Giulia', contactId: 'c1', contactName: 'Giulia Bianchi',
    valueCents: 2_750_000, expectedCloseDate: '2026-11-20T00:00:00.000Z',
  })]);
  const boardPanel = mount.childNodes[0];
  apriOf(mount, 'a').dispatch('click');
  const panel = panelOf(mount);
  assert.ok(panel, 'the panel opens');
  assert.deepEqual(hashes, [], 'the pipeline stays on screen');
  assert.equal(mount.childNodes[0], boardPanel, 'the board is not rebuilt');
  assert.ok(classes(panel).includes('bo-scheda-composer'), 'the scheda composer window, reused');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-label'), 'Offerta Cucina per Giulia');
  const text = panel.textContent;
  assert.ok(text.includes('Cucina per Giulia · Giulia Bianchi'), 'offer and customer in the head');
  assert.ok(text.includes('Cliente') && text.includes('Giulia Bianchi'));
  assert.ok(text.includes('Valore') && text.includes('27.500'), `the value (${text})`);
  assert.ok(text.includes('Fase') && text.includes('Scoperta'), 'the stage in the operator words');
  assert.ok(text.includes('Chiusura prevista') && text.includes('2026-11-20'));
  assert.ok(text.includes('Cambia fase'), 'the stage change is offered');
  const links = panel.findAll('a');
  const scheda = links.find((n) => n.textContent === 'Apri scheda cliente');
  assert.equal(scheda?.getAttribute('href'), '#/customer-card/contact/c1', 'the contact scheda');
  const page = links.find((n) => n.getAttribute('data-action') === 'open-offer-page');
  assert.equal(page?.getAttribute('href'), '#/offerte/a', 'the full offer stays one click away');
  const close = panel.findAll('button').find((n) => n.getAttribute('data-action') === 'offer-drawer-close');
  assert.ok(close.__focused, 'focus moves into the panel');
});

test('Dan 11/11: a company-only offer links the company scheda; no customer, no scheda link', async () => {
  const { mount } = await board([
    record('a', 'discovery'),
    record('b', 'discovery', { companyId: '', companyName: '', name: 'Senza cliente' }),
  ]);
  apriOf(mount, 'a').dispatch('click');
  let link = panelOf(mount).findAll('a').find((n) => n.textContent === 'Apri scheda cliente');
  assert.equal(link?.getAttribute('href'), '#/customer-card/company/co1');
  apriOf(mount, 'b').dispatch('click');
  assert.equal(mount.findAll('div').filter((n) => n.getAttribute('data-offer-drawer') !== null).length, 1, 'one panel at a time');
  link = panelOf(mount).findAll('a').find((n) => n.textContent === 'Apri scheda cliente');
  assert.equal(link, undefined, 'no dead link without a customer');
});

test('Dan 11/11: × closes the panel without re-rendering the board and hands focus back to Apri', async () => {
  const { mount, client } = await board([record('a', 'discovery')]);
  const boardPanel = mount.childNodes[0];
  const reads = client.calls.length;
  const apri = apriOf(mount, 'a');
  apri.dispatch('click');
  const panel = panelOf(mount);
  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'offer-drawer-close').dispatch('click', { detail: 0 });
  assert.equal(panelOf(mount), undefined, 'the panel is gone');
  assert.equal(mount.childNodes[0], boardPanel, 'the same board node: the scroll stays where it was');
  assert.equal(client.calls.length, reads, 'no re-read of the board');
  assert.ok(apri.__focused, 'focus goes back to Apri');
});

test('85630aa14a4f: a mouse × hands focus back to the open card, without the focus ring', async () => {
  const { mount } = await board([record('a', 'discovery')]);
  const apri = apriOf(mount, 'a');
  const focusCalls = [];
  apri.focus = (options) => { focusCalls.push(options ?? null); };
  apri.dispatch('click');
  const panel = panelOf(mount);
  assert.ok(panel, 'the panel is open');
  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'offer-drawer-close').dispatch('click', { detail: 1 });
  assert.equal(panelOf(mount), undefined, 'the panel is gone');
  assert.equal(focusCalls.length, 1, 'focus goes back to the open card (its Apri)');
  assert.equal(focusCalls[0]?.focusVisible, false, 'with no ring: a mouse closed it');
  assert.equal(focusCalls[0]?.preventScroll, true, 'and the page does not jump');
});

test('85630aa14a4f: closing the panel brings the board back to its pre-open scroll', async () => {
  const { mount } = await board([record('a', 'discovery'), record('b', 'demo')]);
  const boardEl = cardOf(mount, 'a').parentNode.parentNode;
  boardEl.scrollLeft = 130;
  apriOf(mount, 'a').dispatch('click');
  assert.ok(panelOf(mount), 'the panel is open');
  boardEl.scrollLeft = 260; // the panel made room: the board moved on
  panelOf(mount).findAll('button').find((n) => n.getAttribute('data-action') === 'offer-drawer-close').dispatch('click', { detail: 0 });
  assert.equal(panelOf(mount), undefined, 'the panel is gone');
  assert.equal(boardEl.scrollLeft, 130, 'the board is back where it was before the panel');
});

test('85630aa14a4f: the open card is marked, on screen and across a filter re-render', async () => {
  const { mount } = await board([record('a', 'discovery'), record('b', 'demo')]);
  apriOf(mount, 'a').dispatch('click');
  const card = cardOf(mount, 'a');
  assert.ok(classes(card).includes('is-open'), 'the open card carries the style hook');
  assert.equal(card.getAttribute('aria-current'), 'true', 'and names itself current');
  const other = cardOf(mount, 'b');
  assert.ok(!classes(other).includes('is-open'), 'the other card stays unmarked');
  assert.equal(other.getAttribute('aria-current'), null, 'and current nowhere else');
  const search = mount.findAll('input').find((n) => n.getAttribute('data-filter') === 'q');
  search.value = 'Offerta';
  search.dispatch('input');
  const fresh = cardOf(mount, 'a');
  assert.ok(classes(fresh).includes('is-open'), 'the fresh card keeps the style hook');
  assert.equal(fresh.getAttribute('aria-current'), 'true', 'and stays current');
  panelOf(mount).findAll('button').find((n) => n.getAttribute('data-action') === 'offer-drawer-close').dispatch('click', { detail: 0 });
  assert.ok(!classes(cardOf(mount, 'a')).includes('is-open'), 'closing the panel clears the mark');
  assert.equal(cardOf(mount, 'a').getAttribute('aria-current'), null, 'and current leaves with it');
});

test('Dan 11/11: Esc and a click outside close the panel; a click inside keeps it', async () => {
  const doc = listeningDocument();
  const { mount } = await board([record('a', 'discovery'), record('b', 'demo')], { doc });
  const boardPanel = mount.childNodes[0];
  apriOf(mount, 'a').dispatch('click');
  let panel = panelOf(mount);
  const inside = panel.findAll('span')[0];
  doc.dispatch('pointerdown', { target: inside });
  assert.ok(panelOf(mount), 'a click inside keeps the panel');
  doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(panelOf(mount), undefined, 'Esc closes it');
  assert.equal(doc.listenerCount('keydown') + doc.listenerCount('pointerdown'), 0, 'no listener left behind');

  apriOf(mount, 'b').dispatch('click');
  panel = panelOf(mount);
  assert.ok(panel);
  doc.dispatch('pointerdown', { target: cardOf(mount, 'a') });
  assert.equal(panelOf(mount), undefined, 'a click outside closes it');
  assert.equal(mount.childNodes[0], boardPanel, 'the board was never rebuilt');
  assert.equal(doc.listenerCount('keydown') + doc.listenerCount('pointerdown'), 0, 'no listener left behind');

  // Esc on the panel itself works where the document takes no listener.
  apriOf(mount, 'a').dispatch('click');
  panelOf(mount).dispatch('keydown', { key: 'Escape' });
  assert.equal(panelOf(mount), undefined, 'Esc from inside closes it too');
});

test('Dan 11/11: leaving the pipeline closes the panel; coming back shows the board without it', async () => {
  const doc = listeningDocument();
  const { mount, view } = await board([record('a', 'discovery')], { doc });
  apriOf(mount, 'a').dispatch('click');
  assert.ok(panelOf(mount));
  // The router empties the mount for another view (a keyboard Invio on a
  // menu voice: no pointerdown reaches the document).
  for (const child of [...mount.childNodes]) mount.removeChild(child);
  await view.renderBoard('b2b-sales');
  assert.equal(panelOf(mount), undefined, 'the panel does not come back on its own');
  assert.equal(doc.listenerCount('keydown') + doc.listenerCount('pointerdown'), 0, 'no listener left behind');
});

test('Dan 11/11: a filter re-render keeps the panel open over the new board', async () => {
  const { mount } = await board([record('a', 'discovery'), record('b', 'demo')]);
  apriOf(mount, 'a').dispatch('click');
  const panel = panelOf(mount);
  assert.ok(panel, 'the panel is open');
  const search = mount.findAll('input').find((n) => n.getAttribute('data-filter') === 'q');
  search.value = 'Offerta';
  search.dispatch('input');
  assert.equal(panelOf(mount), panel, 'the same panel is still open');
});

test('Dan 11/11: Cambia fase in the panel writes move-stage and the panel shows the new stage', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery')]);
  apriOf(mount, 'a').dispatch('click');
  const panel = panelOf(mount);
  const select = panel.findAll('select')[0];
  select.value = 'demo';
  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move').dispatch('click');
  await tick();
  await tick();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.deepEqual(JSON.parse(post.body), { toStage: 'demo', fromStage: 'discovery' });
  assert.ok(toasts.some((item) => item.message === 'Spostata in Demo.'));
  const after = panelOf(mount);
  assert.ok(after, 'the panel stays open');
  const stageFact = after.findAll('p').find((n) => n.textContent.startsWith('Fase'));
  assert.equal(stageFact.textContent, 'FaseDemo', 'the panel shows the new stage');
  assert.deepEqual(cardIds(columnOf(mount, 'demo')), ['a'], 'the board moved the card too');
});

test('Dan 11/11: Persa from the panel asks the reason; a failed move says why inside the panel', async () => {
  const { mount, client } = await board([record('a', 'discovery')], {
    onPost: () => { throw Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' }); },
  });
  apriOf(mount, 'a').dispatch('click');
  const panel = panelOf(mount);
  panel.findAll('select')[0].value = 'lost';
  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move').dispatch('click');
  assert.ok(panel.textContent.includes('Segnare «Offerta a» come Persa?'), 'Conferma names the offer');
  const yes = panel.findAll('button').find((n) => n.textContent === 'Conferma');
  yes.dispatch('click');
  await tick();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'no reason, no write');
  assert.ok(panel.textContent.includes('Scrivi il motivo della perdita'));
  panel.findAll('input').find((n) => n.getAttribute('aria-label') === 'Motivo di chiusura').value = 'Budget';
  yes.dispatch('click');
  await tick();
  await tick();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.deepEqual(JSON.parse(post.body), { toStage: 'lost', fromStage: 'discovery', reason: 'Budget' });
  const alert = panel.findAll('small').find((n) => n.getAttribute('role') === 'alert');
  assert.equal(alert.textContent, 'Spostamento non riuscito.', 'the failure reads inside the panel');
  assert.ok(!classes(alert).includes('hidden'));
  const retry = panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move-retry');
  assert.ok(retry && !classes(retry).includes('hidden'), 'Riprova shows beside the failure');
});

test('Dan 11/11: a closed offer (Vinta) shows no Cambia fase in the panel', async () => {
  const { mount } = await board([record('a', 'won')]);
  apriOf(mount, 'a').dispatch('click');
  const panel = panelOf(mount);
  assert.ok(panel.textContent.includes('Vinta'), 'the stage shows');
  assert.ok(!panel.textContent.includes('Cambia fase'), 'no move out of a closed stage');
});

// ---- Review #774 (Codex, giro 1) ------------------------------------------

test('review #774 P2: through the shell\'s gated mount, a stage change keeps the panel open with the new stage', async () => {
  const raw = createMount();
  const gate = createMountGate(raw);
  gate.activate('pipeline');
  const mount = gate.owned('pipeline');
  const { client } = await board([record('a', 'discovery')], { mount });
  apriOf(raw, 'a').dispatch('click');
  const panel = panelOf(raw);
  panel.findAll('select')[0].value = 'demo';
  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move').dispatch('click');
  await tick();
  await tick();
  await tick();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1);
  const after = panelOf(raw);
  assert.ok(after, 'the panel is still open after the move');
  assert.ok(after.textContent.includes('FaseDemo'), 'and shows the new stage');
});

test('review #774 P2: a move started in the panel locks the card and survives closing and reopening the panel', async () => {
  const { mount, client } = await board([record('a', 'discovery')], { onPost: () => new Promise(() => {}) });
  apriOf(mount, 'a').dispatch('click');
  let panel = panelOf(mount);
  panel.findAll('select')[0].value = 'demo';
  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move').dispatch('click');
  await tick();
  const posts = () => client.calls.filter((call) => call.method === 'POST').length;
  assert.equal(posts(), 1);
  const card = cardOf(mount, 'a');
  assert.equal(card.getAttribute('aria-busy'), 'true', 'the card shows the panel\'s move');
  assert.ok(card.textContent.includes('Spostamento in corso…'));
  let prevented = false;
  card.dispatch('dragstart', { preventDefault() { prevented = true; }, dataTransfer: dataTransfer() });
  assert.ok(prevented, 'the card cannot be dragged meanwhile');
  card.__select.value = 'demo';
  await card.__move();
  assert.equal(posts(), 1, 'Sposta on the card posts nothing while the panel\'s move runs');

  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'offer-drawer-close').dispatch('click');
  apriOf(mount, 'a').dispatch('click');
  panel = panelOf(mount);
  const go = panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move');
  assert.equal(go.disabled, true, 'the reopened panel stays locked');
  assert.ok(panel.textContent.includes('Spostamento in corso…'), 'and says why');
  panel.findAll('select')[0].value = 'demo';
  go.dispatch('click');
  await tick();
  assert.equal(posts(), 1, 'no second POST from the reopened panel');
});

test('review #774 P2: a panel move with no answer turns «Non ancora confermato» with Riprova, a re-read only', async () => {
  let elapse = () => {};
  const timer = new Promise((resolve) => { elapse = resolve; });
  const { mount, client } = await board([record('a', 'discovery')], {
    onPost: () => new Promise(() => {}),
    wait: () => timer,
  });
  apriOf(mount, 'a').dispatch('click');
  const panel = panelOf(mount);
  panel.findAll('select')[0].value = 'demo';
  panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move').dispatch('click');
  await tick();
  assert.ok(panel.textContent.includes('Spostamento in corso…'));
  elapse();
  await tick();
  const status = panel.findAll('small').find((n) => n.getAttribute('role') === 'status');
  assert.equal(status.textContent, 'Non ancora confermato', 'the wait is bounded');
  const retry = panel.findAll('button').find((n) => n.getAttribute('data-action') === 'drawer-move-retry');
  assert.ok(retry && !classes(retry).includes('hidden'), 'Riprova shows');
  assert.ok(cardOf(mount, 'a').textContent.includes('Non ancora confermato'), 'the card says the same');
  const reads = client.calls.filter((call) => call.method === 'GET').length;
  retry.dispatch('click');
  await tick();
  await tick();
  assert.ok(client.calls.filter((call) => call.method === 'GET').length > reads, 'Riprova re-reads the board');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1, 'never a second POST');
});
