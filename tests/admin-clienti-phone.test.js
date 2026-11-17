// backlog:92d9c5456ca6 — a 390 px Clienti reads as a card list, never as
// the 760px table with an inner sideways scroll. The PNG proof is
// `npm run bo:shots` (headless Chrome renders every screen at 390x1600
// too); these tests lock the stylesheet rules it relies on and the DOM
// they restyle: same filters, views, search, columns and pager, every
// fact carrying its own label so the card needs no head.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCustomerListView } from '../apps/admin/public/admin-clienti.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'apps/admin/public/styles.css'), 'utf8');

/**
 * Bodies of every `@media` block whose query matches `query` (balanced
 * braces, one level of nested rules).
 * @param {RegExp} query
 */
function mediaBodies(query) {
  const out = [];
  const re = /@media([^{]+)\{/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    if (!query.test(match[1])) continue;
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

const phone = mediaBodies(/\(max-width:\s*700px\)/).join('\n');

test('phone: the table head hides and rows stack as one-column cards', () => {
  assert.match(phone, /\.bo-clienti-thead\s*\{[^}]*display:\s*none/,
    'the head hides on a phone, like the catalog head');
  const row = phone.match(/\.bo-clienti-row\s*\{([^}]*)\}/);
  assert.ok(row, 'a phone rule restyles the row');
  assert.match(row[1], /grid-template-columns:[^;]*minmax\(0,\s*1fr\)[^;]*!important/,
    'one fluid track beats the inline desktop tracks');
  assert.match(row[1], /min-width:\s*0[^;]*!important/,
    'no 760px floor survives on a phone (the floor rides inline)');
});

test('phone: the list never scrolls sideways', () => {
  const table = phone.match(/\.bo-clienti-table\s*\{([^}]*)\}/);
  assert.ok(table, 'a phone rule restyles the table');
  assert.match(table[1], /overflow-x:\s*visible/, 'the inner sideways scroll is gone');
});

test('phone: every fact names its column, so the card needs no head', () => {
  const label = phone.match(/\.bo-clienti-label\s*\{([^}]*)\}/);
  assert.ok(label, 'a phone rule reveals the per-fact label');
  assert.match(label[1], /position:\s*static/, 'the label leaves its 1px hidden slot');
});

const MENUS = {
  views: [
    { id: 'tutti', label: 'Tutti' },
    { id: 'ricontattare-oggi', label: 'Da ricontattare oggi' },
    { id: 'nuovi-lead', label: 'Nuovi lead' },
    { id: 'clienti-attivi', label: 'Clienti attivi' },
    { id: 'rinnovi-30-giorni', label: 'Rinnovi entro 30 giorni' },
  ],
  sorts: [
    { id: 'recent', label: 'Ultimo contatto' },
    { id: 'name', label: 'Nome A–Z' },
    { id: 'value', label: 'Valore offerta' },
    { id: 'status', label: 'Stato' },
  ],
  columns: [
    { id: 'canali', label: 'Canali', always: false, ai: false, def: true },
    { id: 'stato', label: 'Stato', always: false, ai: false, def: true },
    { id: 'ultimo', label: 'Ultimo contatto', always: false, ai: false, def: true },
    { id: 'prossimo', label: 'Prossimo passo', always: false, ai: false, def: true },
    { id: 'calendario', label: 'Calendario', always: false, ai: false, def: true },
    { id: 'email', label: 'Email', always: false, ai: false, def: false },
    { id: 'telefono', label: 'Telefono', always: false, ai: false, def: false },
    { id: 'offerta', label: 'Valore offerta', always: false, ai: false, def: false },
    { id: 'budget', label: 'Budget dichiarato', always: false, ai: true, def: false },
  ],
  pageSizes: [10, 25, 50],
};

const ROW_MARCO = {
  resource: 'contact', id: 'c1', name: 'Marco Rossi',
  company: { id: 'co1', name: 'Palestra Esempio' },
  email: 'marco@palestra-esempio.it',
  phone: { value: '+393331234567', system: 'whatsapp' },
  channels: ['whatsapp'],
  status: { value: 'cliente', reason: 'signed business on record: orders' },
  lastContactAt: '2026-10-20T09:00:00.000Z', lastContactText: 'ci vediamo domani',
  lastContactChannel: 'whatsapp',
  nextAppointment: { startsAt: '2026-10-24T10:00:00.000Z', endsAt: '2026-10-24T10:30:00.000Z', status: 'booked' },
  offerValueCents: 120000, offerCurrency: 'EUR',
  nextStep: { title: 'Prova gratuita', dueAt: '2026-10-22', overdue: false },
};

function stubClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      return {
        customerListContract: 1,
        items: [ROW_MARCO], total: 1, page: 1, pageSize: 10, pages: 1,
        totalIsExact: true, ...MENUS,
      };
    },
  };
}

const flush = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const render = async (client) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  const view = createCustomerListView({ doc, mount, client, storage: store, notify: () => {} });
  await view.render();
  return { doc, mount, view };
};

const byAttr = (mount, tag, attr, value) => mount.findAll(tag)
  .find((node) => node.getAttribute(attr) === value);
const toolToggle = (mount, name) => mount.findAll('button').find((node) => {
  const label = String(node.getAttribute('aria-label') ?? '');
  return label === name || label.startsWith(`${name}:`);
});

test('cards carry the same actions and filters as the table', async () => {
  const { mount } = await render(stubClient());
  // The acceptance fields read in the card: name, stato, ultimo, valore.
  const card = mount.findAll('article')[0];
  assert.ok(card, 'the customer renders as a card');
  assert.equal(byAttr(mount, 'a', 'data-action', 'open-customer-card')?.getAttribute('href'),
    '#/customer-card/contact/c1', 'the name opens the scheda');
  assert.ok(card.textContent.includes('Cliente'), 'the stato pill reads');
  assert.ok(card.textContent.includes('WhatsApp'), 'the ultimo contatto reads');
  byAttr(mount, 'button', 'data-column', 'offerta').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes('1.200 €'), 'the valore offerta reads once enabled');
  // Same filters and tools, same DOM at every width.
  assert.ok(mount.findAll('input').some((node) => node.getAttribute('aria-label') === 'Cerca clienti'), 'search stays');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-view') === 'tutti'), 'views stay');
  assert.ok(toolToggle(mount, 'Filtri'), 'filters stay');
  assert.ok(toolToggle(mount, 'Ordina'), 'sort stays');
  assert.ok(toolToggle(mount, 'Colonne'), 'columns stay');
  assert.ok(mount.findAll('nav').some((node) => node.getAttribute('aria-label') === 'Paginazione'), 'pager stays');
});

test('cards name every fact, so hiding the head loses nothing', async () => {
  const { mount } = await render(stubClient());
  const facts = mount.findAll('p').filter((node) => node.getAttribute('data-column') !== null);
  assert.ok(facts.length >= 5, `the default columns render as facts (${facts.length})`);
  for (const fact of facts) {
    const label = (fact.findAll?.('span') ?? [])
      .find((node) => String(node.getAttribute?.('class') ?? '').split(/\s+/).includes('bo-clienti-label'));
    assert.ok(label, `the ${fact.getAttribute('data-column')} fact carries its label`);
    assert.ok(label.textContent.endsWith(': '), 'the label reads like a caption');
  }
});
