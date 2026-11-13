import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Namespace import: on the code before this change the file still loads and
// every test fails on its own assertion (the behaviour).
import * as pipelineModule from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * 67a3116f4f65 (parte web; verifica-38 su pilota f5f9fe8 / agent-crm 60c5fc5):
 * il core salva la posizione (#785) ma il /bo non la usava. Ora:
 * - il segnaposto sta sotto il puntatore, anche fra due card;
 * - la colonna di partenza accetta il drop (riordino);
 * - move-stage manda afterId o first; la board legge order=board;
 * - il riordino ha lo stesso stato d'attesa e «Annulla» torna al posto lasciato.
 * d3910a25dbc0: un 409 transitorio si riprova una volta, poi lo si dice.
 * Rifinitura: un drop rifiutato lo dice; la card in attesa ha una barra visibile.
 */

const { createPipelineBoard } = pipelineModule;

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

function server(initial, { onPost = null, answer = null } = {}) {
  let records = initial.map((item) => ({ ...item }));
  const posts = [];
  const reads = [];
  /** When set, list reads wait for it (a slow quiet re-read). */
  let readGate = null;
  return {
    posts, reads,
    gateReads(gate) { readGate = gate; },
    /** The server-side stage write a pilot commits before the place is refused. */
    setStage(id, stage) { records = records.map((item) => (item.id === id ? { ...item, pipelineStage: stage } : item)); },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        posts.push(body);
        if (onPost) await onPost(body, posts.length);
        const id = decodeURIComponent(path.split('/records/')[1].split('/')[0]);
        // The server's board order: the moved card where the body says.
        const moved = { ...records.find((item) => item.id === id), pipelineStage: body.toStage };
        const rest = records.filter((item) => item.id !== id);
        const column = rest.filter((item) => item.pipelineStage === body.toStage);
        const others = rest.filter((item) => item.pipelineStage !== body.toStage);
        const at = body.afterId ? column.findIndex((item) => item.id === body.afterId) + 1 : 0;
        column.splice(at, 0, moved);
        records = [...column, ...others];
        if (answer) {
          // Like the pilot when the place was not saved: the stage moved,
          // the card sits on top of its new column.
          const placed = { ...moved };
          records = [placed, ...records.filter((item) => item.id !== id)];
          return answer;
        }
        return { ok: true };
      }
      reads.push(path);
      if (readGate && path.startsWith('/api/opportunities')) await readGate;
      return { items: records };
    },
  };
}

const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const columnOf = (mount, stage) => mount.findAll('div').find((n) => n.getAttribute('data-stage') === stage);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const order = (mount, stage) => columnOf(mount, stage).childNodes.filter((n) => classes(n).includes('pipeline-card')).map((n) => n.getAttribute('data-record'));

/** Give every card a box: 100 px tall, stacked from y = 0 in its column. */
function measure(mount) {
  for (const column of mount.findAll('div').filter((n) => n.getAttribute('data-stage') !== null)) {
    column.childNodes.filter((n) => classes(n).includes('pipeline-card'))
      .forEach((card, index) => { card.getBoundingClientRect = () => ({ top: index * 100, height: 100 }); });
  }
}

async function board(records, options = {}) {
  const mount = createMount();
  const client = server(records, options);
  const toasts = [];
  const view = createPipelineBoard({
    doc: createFakeDocument(), mount, client,
    toast: (message, error, opts) => toasts.push({ message: String(message), error: Boolean(error), options: opts }),
    navigate: () => {},
    wait: () => new Promise(() => {}),
    retryWait: () => Promise.resolve(),
  });
  await view.renderBoard('b2b-sales');
  measure(mount);
  return { mount, client, toasts };
}

function drag(mount, id, stage, clientY) {
  const store = {};
  const transfer = { setData(type, value) { store[type] = value; }, getData(type) { return store[type] ?? ''; } };
  cardOf(mount, id).dispatch('dragstart', { dataTransfer: transfer });
  const column = columnOf(mount, stage);
  column.dispatch('dragover', { preventDefault() {}, clientY });
  return { column, drop: () => column.dispatch('drop', { preventDefault() {}, dataTransfer: transfer }) };
}

test('67a3116f4f65: the board reads the stored order (order=board)', async () => {
  const { client } = await board([record('a', 'discovery')]);
  assert.ok(client.reads.some((path) => path.startsWith('/api/opportunities') && /[?&]order=board(&|$)/.test(path)), client.reads.join(' '));
});

test('67a3116f4f65: the slot follows the pointer between two cards, and the drop lands there with afterId', async () => {
  const { mount, client } = await board([record('a', 'discovery'), record('b', 'demo'), record('c', 'demo')]);
  // Pointer at y = 150: below the middle of b (50), above the middle of c (150 is c's middle → before c).
  const { column, drop } = drag(mount, 'a', 'demo', 140);
  const slotAt = column.childNodes.findIndex((n) => classes(n).includes('pipeline-drop-slot'));
  const cards = column.childNodes.map((n) => n.getAttribute?.('data-record') ?? (classes(n).includes('pipeline-drop-slot') ? 'SLOT' : null)).filter(Boolean);
  assert.deepEqual(cards, ['b', 'SLOT', 'c'], 'the slot sits between b and c');
  assert.ok(slotAt > 0);
  drop();
  await tick();
  assert.deepEqual(client.posts[0], { toStage: 'demo', fromStage: 'discovery', afterId: 'b' });
  assert.deepEqual(order(mount, 'demo'), ['b', 'a', 'c'], 'the card is where the slot was');
});

test('67a3116f4f65: the source column takes the drop; a reorder posts the same stage with its place, and Annulla goes back to the place left', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'discovery'), record('c', 'discovery')]);
  let prevented = false;
  const store = {};
  const transfer = { setData(type, value) { store[type] = value; }, getData(type) { return store[type] ?? ''; } };
  cardOf(mount, 'a').dispatch('dragstart', { dataTransfer: transfer });
  const column = columnOf(mount, 'discovery');
  column.dispatch('dragover', { preventDefault() { prevented = true; }, clientY: 260 });
  assert.ok(prevented, 'the source column accepts the drop');
  column.dispatch('drop', { preventDefault() {}, dataTransfer: transfer });
  await tick();
  assert.deepEqual(client.posts[0], { toStage: 'discovery', fromStage: 'discovery', afterId: 'c' }, 'a reorder after c');
  assert.deepEqual(order(mount, 'discovery'), ['b', 'c', 'a']);
  const said = toasts.find((item) => item.message === 'Ordine aggiornato in Richiesta info.');
  assert.ok(said, 'the reorder is said');
  assert.ok(cardOf(mount, 'a').getAttribute('aria-busy') === 'true' || client.posts.length === 1, 'the card waits like any move');
  said.options.action.run();
  await tick();
  assert.deepEqual(order(mount, 'discovery'), ['a', 'b', 'c'], 'Annulla puts it back first, at once');
  assert.deepEqual(client.posts[1], { toStage: 'discovery', fromStage: 'discovery', first: true }, 'and the server follows');
});

test('67a3116f4f65: a drop back where the card already is writes nothing and says nothing', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'discovery')]);
  const { drop } = drag(mount, 'a', 'discovery', 10);
  drop();
  await tick();
  assert.equal(client.posts.length, 0);
  assert.equal(toasts.length, 0);
});

test('d3910a25dbc0: a write that met another one (409 transient) is retried once, quietly', async () => {
  const conflict = Object.assign(new Error('The write lost a serialization contest; retry the request'), {
    status: 409, code: 'CONFLICT', details: { transient: true, reason: 'serialization' },
  });
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'demo')], {
    onPost: (_body, count) => { if (count === 1) throw conflict; },
  });
  const { drop } = drag(mount, 'a', 'demo', 0);
  drop();
  await tick(10);
  assert.equal(client.posts.length, 2, 'one retry');
  assert.ok(!toasts.some((item) => item.error), 'no error shown when the retry lands');
  assert.deepEqual(order(mount, 'demo'), ['a', 'b']);
});

test('d3910a25dbc0: a second meeting is said in plain words and the card goes back', async () => {
  const conflict = () => Object.assign(new Error('The write lost a serialization contest; retry the request'), {
    status: 409, code: 'CONFLICT', details: { transient: true, reason: 'serialization' },
  });
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'demo')], {
    onPost: () => { throw conflict(); },
  });
  const { drop } = drag(mount, 'a', 'demo', 0);
  drop();
  await tick(10);
  assert.equal(client.posts.length, 2, 'retried once, not more');
  assert.equal(toasts[toasts.length - 1].message, 'Un altro spostamento è arrivato nello stesso momento: riprova.');
  assert.deepEqual(order(mount, 'discovery'), ['a'], 'the card is back');
});

test('67a3116f4f65: a column that changed under the drop (STALE_POSITION) says so and re-reads', async () => {
  const stale = Object.assign(new Error('stale'), { status: 409, code: 'STALE_POSITION' });
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'demo')], {
    onPost: () => { throw stale; },
  });
  const readsBefore = client.reads.length;
  const { drop } = drag(mount, 'a', 'demo', 150);
  drop();
  await tick(10);
  assert.equal(toasts[toasts.length - 1].message, 'La colonna è cambiata nel frattempo: la pipeline si aggiorna, riprova.');
  assert.ok(client.reads.length > readsBefore, 'the board reads again');
});

test('rifinitura: a refused drop (a closed offer to another stage) is said, nothing is written', async () => {
  const { mount, client, toasts } = await board([record('w', 'won'), record('b', 'demo')]);
  const { drop } = drag(mount, 'w', 'demo', 0);
  drop();
  await tick();
  assert.equal(client.posts.length, 0);
  assert.equal(toasts[toasts.length - 1].message, "Un'offerta chiusa non cambia più fase: resta in Vinta.");
  assert.equal(toasts[toasts.length - 1].error, true);
});

test('rifinitura: a card waiting for its write shows a moving bar, not only aria-busy', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.pipeline-card\[aria-busy="true"\]::after \{[^}]*content: ""/, 'a visible bar on the waiting card');
  assert.match(css, /animation: pipeline-card-wait/, 'that moves');
});

// ---- Review Muse #852, giro 1 ----------------------------------------------

test('review #852: «Annulla» clicked while the landing re-read is in flight wins over that repaint', async () => {
  // The reverse write never answers here: what the screen shows after the
  // forward re-read is the client's own doing, not a later server repaint.
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'demo')], {
    onPost: (_body, count) => (count === 2 ? new Promise(() => {}) : undefined),
  });
  let releaseRead = () => {};
  client.gateReads(new Promise((resolve) => { releaseRead = resolve; }));
  const { drop } = drag(mount, 'a', 'demo', 0);
  drop();
  await tick();
  assert.equal(client.posts.length, 1, 'the forward write landed; its re-read now waits');
  toasts.find((item) => item.message === 'Spostata in Prova.').options.action.run();
  await tick();
  assert.deepEqual(order(mount, 'discovery'), ['a'], 'the click puts the card back');
  client.gateReads(null);
  releaseRead();
  await tick(10);
  assert.deepEqual(order(mount, 'discovery'), ['a'], 'the in-flight re-read did not paint it back onto Prova');
  assert.deepEqual(client.posts[1], { toStage: 'discovery', fromStage: 'demo', first: true }, 'and the reverse write followed');
});

test('review #852: a drop onto Vinta keeps the place the slot showed through Conferma', async () => {
  const { mount, client } = await board([record('a', 'discovery'), record('w1', 'won'), record('w2', 'won')]);
  // Pointer at y = 140: below the middle of w1, above the middle of w2.
  const { drop } = drag(mount, 'a', 'won', 140);
  drop();
  await tick();
  assert.equal(client.posts.length, 0, 'Conferma first');
  await cardOf(mount, 'a').__confirm();
  await tick();
  assert.deepEqual(client.posts[0], { toStage: 'won', fromStage: 'discovery', afterId: 'w1' }, 'the confirmed write carries the place');
});

test('review #852: STALE_POSITION never puts the card back by guess — the fresh board says where it is', async () => {
  const stale = Object.assign(new Error('stale'), { status: 409, code: 'STALE_POSITION' });
  let api = null;
  const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'demo')], {
    // Like the pilot: the stage write lands, then the place is refused.
    onPost: (body) => { api.setStage('a', body.toStage); throw stale; },
  });
  api = client;
  // The re-read after the refusal is slow: what shows meanwhile matters.
  let releaseRead = () => {};
  client.gateReads(new Promise((resolve) => { releaseRead = resolve; }));
  const { drop } = drag(mount, 'a', 'demo', 150);
  drop();
  await tick(6);
  assert.deepEqual(order(mount, 'discovery'), [], 'no guessed jump back to Richiesta info while the board re-reads');
  client.gateReads(null);
  releaseRead();
  await tick(10);
  assert.deepEqual(order(mount, 'demo'), ['a', 'b'], 'the card shows where the server has it (Prova)');
  assert.deepEqual(order(mount, 'discovery'), []);
  assert.equal(toasts[toasts.length - 1].message, 'La colonna è cambiata nel frattempo: la pipeline si aggiorna, riprova.');
});

// ---- 67a3116f4f65 with pilot #562: a stage saved without its place ----------

for (const [code, text] of [
  ['refused', 'Spostata in Prova, ma la colonna era cambiata: la card è in cima.'],
  ['unavailable', 'Spostata in Prova, ma qui il posto nella colonna non si salva: la card è in cima.'],
]) {
  test(`67a3116f4f65: a receipt with placement '${code}' is never a silent «saved» — the card is on top and the toast says so`, async () => {
    const { mount, client, toasts } = await board([record('a', 'discovery'), record('b', 'demo'), record('c', 'demo')], {
      answer: { saved: { id: 'a', pipelineStage: 'demo', placement: code }, spaceId: 's1' },
    });
    // Dropped between b and c…
    const { drop } = drag(mount, 'a', 'demo', 140);
    drop();
    await tick(10);
    assert.deepEqual(client.posts[0], { toStage: 'demo', fromStage: 'discovery', afterId: 'b' });
    // …but the place was not saved: after the re-read the card is on top.
    assert.deepEqual(order(mount, 'demo'), ['a', 'b', 'c']);
    const last = toasts[toasts.length - 1];
    assert.equal(last.message, text);
    assert.equal(last.options?.action?.label, 'Annulla', 'the move can still be undone');
  });
}

test('67a3116f4f65: a receipt without a place code (the core, or a saved place) adds no warning', async () => {
  const { mount, toasts } = await board([record('a', 'discovery'), record('b', 'demo')]);
  const { drop } = drag(mount, 'a', 'demo', 0);
  drop();
  await tick(10);
  assert.ok(!toasts.some((item) => item.message.includes('la card è in cima')));
  assert.equal(pipelineModule.placementNotSaved({ ok: true }), null);
  assert.equal(pipelineModule.placementNotSaved({ saved: { placement: 'refused' } }), 'refused');
  assert.equal(pipelineModule.placementNotSaved({ id: 'a', placement: 'unavailable' }), 'unavailable', 'the row the write client unwraps');
});
