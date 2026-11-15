import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { paintToast } from '../apps/admin/public/admin-ui.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:7b2203e69826 — Pipeline card (giro UX 11/11, punti 20 e 21):
 * «Annulla» nel toast dopo uno spostamento (Trello); tutta la card apre il
 * pannello, con hover visibile; le iniziali dicono chi è il referente; la
 * card mostra il cliente, mai «Senza azienda».
 */

const PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  stages: [
    { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Vinta', order: 50, type: 'won', probability: 100 },
  ],
};

function record(id, stage, extra = {}) {
  return {
    id, name: `Offerta ${id}`, companyId: 'co1', companyName: 'Palestra Esempio', valueCents: 100_000,
    currency: 'EUR', pipelineKey: 'b2b-sales', pipelineStage: stage, ...extra,
  };
}

function server(initial) {
  let records = initial.map((item) => ({ ...item }));
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (options.method === 'POST') {
        const id = decodeURIComponent(path.split('/records/')[1].split('/')[0]);
        const { toStage } = JSON.parse(options.body);
        records = records.map((item) => (item.id === id ? { ...item, pipelineStage: toStage } : item));
        return { ok: true };
      }
      return { items: records };
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const classes = (node) => String(node.getAttribute('class') ?? '').split(/\s+/);
const cardOf = (mount, id) => mount.findAll('div').find((n) => n.getAttribute('data-record') === id && classes(n).includes('pipeline-card'));
const panelOf = (mount) => mount.findAll('div').find((n) => n.getAttribute('data-offer-drawer') !== null);

async function board(records, docExtra = {}) {
  const doc = Object.assign(createFakeDocument(), docExtra);
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

/** A click target that answers `closest` like a real element inside the card. */
const target = (matches) => ({ closest: (selector) => (matches && selector.includes(matches) ? {} : null) });

test('7b2203e69826: after a move between working stages the toast offers «Annulla», which moves the card back', async () => {
  const { mount, client, toasts } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'demo';
  await card.__move();
  await tick();
  const moved = toasts.find((item) => item.message === 'Spostata in Demo.');
  assert.ok(moved, 'the move toast');
  assert.equal(moved.options?.action?.label, 'Annulla', 'carries «Annulla»');
  moved.options.action.run();
  await tick();
  await tick();
  const posts = client.calls.filter((call) => call.method === 'POST').map((call) => JSON.parse(call.body));
  assert.deepEqual(posts, [
    { toStage: 'demo', fromStage: 'discovery' },
    // 67a3116f4f65: back to the very place it left (here, first).
    { toStage: 'discovery', fromStage: 'demo', first: true },
  ], 'Annulla is the reverse move, through the same write');
  const back = toasts.find((item) => item.message === 'Riportata in Scoperta.');
  assert.ok(back, 'the undo says where the card went back');
  assert.equal(back.options, undefined, 'an undo offers no undo of its own');
  assert.equal(cardOf(mount, 'a').parentNode.getAttribute('data-stage'), 'discovery', 'the card is back');
});

test('7b2203e69826: a closing move (Vinta) offers no «Annulla» — a won offer never reopens', async () => {
  const { mount, toasts } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  card.__select.value = 'won';
  await card.__move();
  await card.__confirm();
  await tick();
  const moved = toasts.find((item) => item.message === 'Spostata in Vinta.');
  assert.ok(moved);
  assert.equal(moved.options, undefined, 'no undo after closing');
});

test('7b2203e69826: the shell toast paints one action button that runs once', () => {
  const doc = createFakeDocument();
  const node = createMount();
  node.setAttribute('class', 'toast ui-toast');
  let runs = 0;
  let done = 0;
  paintToast(doc, node, 'Spostata in Demo.', { action: { label: 'Annulla', run: () => { runs += 1; } }, onDone: () => { done += 1; } });
  assert.ok(node.textContent.startsWith('Spostata in Demo.'));
  const button = node.findAll('button')[0];
  assert.equal(button.textContent, 'Annulla');
  assert.equal(button.getAttribute('type'), 'button');
  button.dispatch('click');
  button.dispatch('click');
  assert.equal(runs, 1, 'the action runs once');
  assert.equal(done, 1, 'and the toast is told to close');
  paintToast(doc, node, 'Errore', { error: true });
  assert.equal(node.findAll('button').length, 0, 'a plain toast has no button left over');
  assert.ok(node.classList.contains('error'));
  paintToast(doc, node, 'Ok');
  assert.ok(!node.classList.contains('error'));
});

test('7b2203e69826: a click anywhere on the card opens the panel; its own controls keep their click', async () => {
  const { mount } = await board([record('a', 'discovery')]);
  const card = cardOf(mount, 'a');
  assert.equal(card.getAttribute('data-openable'), 'true', 'the card is marked openable (hover in CSS)');
  card.dispatch('click', { target: target('button') });
  assert.equal(panelOf(mount), undefined, 'a click on a card control does not open the panel');
  card.dispatch('click', { target: target(null) });
  assert.ok(panelOf(mount), 'a click on the card body opens the panel');
});

test('7b2203e69826: a click that ends a text selection on the card stays on the board', async () => {
  const { mount } = await board([record('a', 'discovery')], {
    getSelection: () => ({ isCollapsed: false, toString: () => 'Palestra' }),
  });
  cardOf(mount, 'a').dispatch('click', { target: target(null) });
  assert.equal(panelOf(mount), undefined);
});

test('7b2203e69826: the card names the customer — the contact, else the company, never «Senza azienda»', async () => {
  const { mount } = await board([
    record('a', 'discovery', { contactName: 'Giulia Bianchi', companyName: 'Senza azienda' }),
    record('b', 'discovery', { companyName: 'Senza azienda' }),
    record('c', 'discovery'),
  ]);
  const company = (id) => cardOf(mount, id).findAll('p').find((n) => classes(n).includes('card-company')).textContent;
  assert.equal(company('a'), 'Giulia Bianchi');
  assert.equal(company('b'), '—');
  assert.equal(company('c'), 'Palestra Esempio');
  assert.ok(!mount.textContent.includes('Senza azienda'));
});

test('7b2203e69826: the referente initials carry the person\'s name', async () => {
  const { mount } = await board([record('a', 'discovery', { owner: 'Guido Presti' })]);
  const badge = cardOf(mount, 'a').findAll('p').find((n) => classes(n).includes('card-owner'));
  assert.equal(badge.textContent, 'GP');
  assert.equal(badge.getAttribute('aria-label'), 'Referente: Guido Presti');
  assert.equal(badge.getAttribute('title'), 'Referente: Guido Presti');
});

test('7b2203e69826: the stylesheet gives the openable card a visible hover and the toast action a look', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.pipeline-card\[data-openable="true"\]:hover\s*\{[^}]*(border-color|box-shadow)/, 'a visible hover');
  assert.match(css, /\.pipeline-card\[data-openable="true"\]\s*\{[^}]*cursor:\s*pointer/, 'a pointer');
  assert.match(css, /\.ui-toast-action\s*\{/, 'the toast action is styled');
});
