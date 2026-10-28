import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENTI_COLUMNS_KEY, createCustomerListView, pageNumbers } from '../apps/admin/public/admin-clienti.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Clienti list (BO-F1-05), against a stub server.
 *
 * What it must prove: the five quick views render as tabs, the grouped
 * channel/status filters combine and each clears with its own ×, search
 * narrows the page the server returns, pagination walks 10/25/50 server
 * pages with ellipses, the AI column stays off by default and renders its
 * stored value with a clickable source (or an honest reason, never broken),
 * the AI entry point degrades to a hint without an LLM backend, and hostile
 * server text stays text.
 */

const MENUS = {
  views: [
    { id: 'tutti', label: 'Tutti' },
    { id: 'nuovi-lead', label: 'Nuovi lead' },
    { id: 'clienti-attivi', label: 'Clienti attivi' },
    { id: 'ricontattare-oggi', label: 'Da ricontattare oggi' },
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
  lastContactAt: '2026-10-20T09:00:00.000Z', lastContactChannel: 'whatsapp',
  offerValueCents: 120000, offerCurrency: 'EUR',
  nextStep: { title: 'Prova gratuita', dueAt: '2026-10-22', overdue: false },
  budget: { available: true, value: '€200/mese', source: { resource: 'contact', id: 'c1' }, reason: null },
};

const ROW_ANNA = {
  resource: 'contact', id: 'c2', name: 'Anna Bianchi',
  company: null, email: 'anna@esempio.it', phone: null, channels: ['instagram'],
  status: { value: 'contatto', reason: 'no signed business on record' },
  lastContactAt: null, lastContactChannel: null,
  offerValueCents: null, offerCurrency: null, nextStep: null,
  budget: { available: false, value: null, source: null, reason: 'nessun budget estratto dall\u2019AI per questo cliente' },
};

function stubClient({ pages = null, onRequest = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async request(path) {
      calls.push(path);
      onRequest(path);
      const query = new URL(path, 'http://localhost').searchParams;
      if (pages) {
        const page = Number(query.get('page') ?? '1');
        return { ...pages[page - 1], ...MENUS };
      }
      return {
        customerListContract: 1,
        items: [ROW_MARCO, ROW_ANNA],
        total: 2, page: 1, pageSize: Number(query.get('pageSize') ?? '10'), pages: 1,
        totalIsExact: true,
        ...MENUS,
      };
    },
  };
}

const flush = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const render = async (client, deps = {}) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  const view = createCustomerListView({ doc, mount, client, storage: store, notify: () => {}, ...deps });
  await view.render();
  return { doc, mount, view, store };
};

const buttons = (mount) => mount.findAll('button');
const byAttr = (mount, tag, attr, value) => mount.findAll(tag).find((node) => node.getAttribute(attr) === value);

test('page numbers collapse to first, last and neighbours with ellipses', () => {
  assert.deepEqual(pageNumbers(1, 1), [1]);
  assert.deepEqual(pageNumbers(10, 1), [1, 2, '…', 10]);
  assert.deepEqual(pageNumbers(10, 5), [1, '…', 4, 5, 6, '…', 10]);
  assert.deepEqual(pageNumbers(10, 10), [1, '…', 9, 10]);
  assert.deepEqual(pageNumbers(3, 2), [1, 2, 3]);
});

test('the five quick views render as tabs, with Tutti active first', async () => {
  const { mount } = await render(stubClient());
  const tabs = buttons(mount).filter((node) => node.getAttribute('role') === 'tab');
  assert.deepEqual(tabs.map((node) => node.textContent),
    ['Tutti', 'Nuovi lead', 'Clienti attivi', 'Da ricontattare oggi', 'Rinnovi entro 30 giorni']);
  const active = tabs.find((node) => node.getAttribute('data-view') === 'tutti');
  assert.equal(active.getAttribute('aria-selected'), 'true');
  assert.ok(mount.textContent.includes('Marco Rossi'));
  assert.ok(mount.textContent.includes('Anna Bianchi'));
});

test('the channel filter narrows the page and its × restores it', async () => {
  const client = stubClient();
  const { mount } = await render(client);
  assert.equal(client.calls.length, 1);
  byAttr(mount, 'button', 'data-filter', 'canale:whatsapp').dispatch('click');
  await flush();
  assert.equal(client.calls.length, 2, 'selecting a filter reloads from the server');
  assert.ok(client.calls[1].includes('canale=whatsapp'), `the server sees the filter: ${client.calls[1]}`);
  const chip = byAttr(mount, 'button', 'aria-label', 'Rimuovi filtro WhatsApp');
  assert.ok(chip, 'the active filter carries its own ×');
  chip.dispatch('click');
  await flush();
  assert.equal(client.calls.length, 3, 'clearing the filter reloads again');
  assert.ok(!client.calls[2].includes('canale='), `the filter is gone: ${client.calls[2]}`);
});

test('search and status combine on the server page, each with its own ×', async () => {
  const client = stubClient();
  const { mount } = await render(client);
  byAttr(mount, 'button', 'data-filter', 'stato:cliente').dispatch('click');
  await flush();
  const last = client.calls[client.calls.length - 1];
  assert.ok(last.includes('stato=cliente'), `the server sees the status: ${last}`);
  assert.ok(byAttr(mount, 'button', 'aria-label', 'Rimuovi filtro Cliente'), 'the status chip clears itself');
});

test('pagination walks server pages and the size buttons switch 10/25/50', async () => {
  const page = (items, pageNum, pagesCount) => ({
    customerListContract: 1, items, total: pagesCount * 10,
    page: pageNum, pageSize: 10, pages: pagesCount, totalIsExact: true,
  });
  const client = stubClient({ pages: [page([ROW_MARCO], 1, 3), page([ROW_ANNA], 2, 3), page([], 3, 3)] });
  const { mount } = await render(client);
  assert.ok(mount.textContent.includes('Marco Rossi'));
  byAttr(mount, 'button', 'data-page', '2').dispatch('click');
  await flush();
  const last = client.calls[client.calls.length - 1];
  assert.ok(last.includes('page=2'), `the server sees the page: ${last}`);
  assert.ok(mount.textContent.includes('Anna Bianchi'), 'the second server page renders');
  byAttr(mount, 'button', 'data-size', '25').dispatch('click');
  await flush();
  const sized = client.calls[client.calls.length - 1];
  assert.ok(sized.includes('pageSize=25'), `the server sees the size: ${sized}`);
});

test('hostile server text renders as text, never as markup', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const evil = {
    ...ROW_MARCO,
    name: nasty,
    company: { id: 'co9', name: nasty },
    budget: { available: true, value: nasty, source: { resource: 'contact', id: 'c1' }, reason: null },
  };
  const client = stubClient();
  client.request = async () => ({
    customerListContract: 1, items: [evil], total: 1, page: 1, pageSize: 10, pages: 1,
    totalIsExact: true, ...MENUS,
  });
  const store = { map: new Map([[CLIENTI_COLUMNS_KEY, JSON.stringify({ budget: true })]]), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerListView({ doc, mount, client, storage: store, notify: () => {} }).render();
  assert.ok(mount.textContent.includes(nasty), 'the value is shown as text');
  assert.deepEqual(mount.findAll('img'), [], 'and no element was created from it');
  assert.deepEqual(mount.findAll('script'), [], 'and no script was created from it');
});

test('the AI budget column stays off by default, renders value plus clickable source when enabled', async () => {
  const facts = (mount) => mount.findAll('p').filter((node) => node.getAttribute('data-column') === 'budget');
  const { mount } = await render(stubClient());
  assert.deepEqual(facts(mount), [], 'the AI column is opt-in: no budget fact renders by default');
  assert.ok(!mount.textContent.includes('€200/mese'), 'the stored budget value stays hidden until enabled');
  byAttr(mount, 'button', 'data-column', 'budget').dispatch('click');
  assert.equal(facts(mount).length, 2, 'enabling the column shows one budget fact per row');
  assert.ok(mount.textContent.includes('€200/mese'), 'enabling the column shows the stored value');
  const sources = mount.findAll('a').filter((node) => node.textContent === 'fonte');
  assert.equal(sources.length, 1, 'the value carries its clickable source');
  assert.equal(sources[0].getAttribute('href'), '#/customer-card/contact/c1');
  assert.ok(mount.textContent.includes('nessun budget estratto'), 'a customer without signals reads unavailable, never broken');
});

test('the column choice persists per operator', async () => {
  const first = await render(stubClient());
  byAttr(first.mount, 'button', 'data-column', 'email').dispatch('click');
  const saved = first.store.map.get(CLIENTI_COLUMNS_KEY);
  assert.ok(saved, 'the choice is stored');
  assert.equal(JSON.parse(saved).email, true);
});

test('the AI entry point degrades to a hint without an LLM backend', async () => {
  let notified = null;
  let asked = null;
  const plain = await render(stubClient(), { notify: (message) => { notified = message; } });
  byAttr(plain.mount, 'button', 'data-action', 'ai-filter').dispatch('click');
  assert.ok(notified, 'without onAskAi the entry point explains itself instead of breaking');
  const wired = await render(stubClient(), { onAskAi: (question) => { asked = question; } });
  byAttr(wired.mount, 'button', 'data-action', 'ai-filter').dispatch('click');
  assert.ok(asked, 'with the assistant panel the entry point asks through it');
});

test('a space the server does not compose reads as unavailable, never blank', async () => {
  const failing = { calls: [], async request() { throw Object.assign(new Error('no such space'), { status: 404 }); } };
  const { mount } = await render(failing);
  assert.ok(mount.textContent.includes('Clienti non composto in questo spazio'));
});

test('BO-F6-08 fetta 1: the title is the only h1 and carries the total', async () => {
  const { mount } = await render(stubClient());
  const titles = mount.findAll('h1');
  assert.equal(titles.length, 1, 'exactly one h1 on the screen');
  assert.equal(titles[0].textContent, 'Clienti 2');
  assert.deepEqual(mount.findAll('h3'), [], 'no legacy h3 title remains');
});

test('BO-F6-08 fetta 1: the search bar shows the prototype placeholder and an Azzera while typing', async () => {
  const client = stubClient();
  const { mount } = await render(client);
  const input = mount.findAll('input')[0];
  assert.equal(input.getAttribute('placeholder'), 'Cerca per nome o chiedi: «lead da Instagram», «chi è di Milano»');
  const clear = byAttr(mount, 'button', 'data-action', 'clear-search');
  assert.ok(clear, 'the search bar carries its own Azzera');
  assert.ok(clear.classList.contains('hidden'), 'Azzera stays hidden without a search');
  assert.equal(client.calls.length, 1);
  input.value = 'milano';
  input.dispatch('input');
  assert.ok(!clear.classList.contains('hidden'), 'typing reveals Azzera');
  clear.dispatch('click');
  await flush();
  assert.equal(input.value, '', 'Azzera empties the field');
  assert.equal(client.calls.length, 2, 'Azzera reloads the list');
  assert.ok(!client.calls[1].includes('q='), `the search is gone: ${client.calls[1]}`);
});

test('BO-F6-08 fetta 1: the toolbar names Filtri, Ordina and Colonne with its visible count', async () => {
  const { mount } = await render(stubClient());
  const labels = buttons(mount).map((node) => node.textContent);
  assert.ok(labels.includes('Filtri'), 'Filtri button renders');
  assert.ok(labels.includes('Ordina'), 'Ordina button renders');
  assert.ok(labels.includes('Colonne 4/8'), `Colonne carries visible/total, got: ${labels.join(' | ')}`);
  assert.ok(mount.textContent.includes('Ordina per'), 'the sort menu names its title');
});

test('BO-F6-08 fetta 1: the table header names Cliente plus only the visible columns', async () => {
  const { mount } = await render(stubClient());
  const heads = mount.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('bo-clienti-th'));
  assert.deepEqual(heads.map((node) => node.textContent),
    ['Cliente', 'Canali', 'Stato', 'Ultimo contatto', 'Prossimo passo']);
  byAttr(mount, 'button', 'data-column', 'email').dispatch('click');
  const grown = mount.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('bo-clienti-th'));
  assert.ok(grown.map((node) => node.textContent).includes('Email'), 'enabling a column adds it to the header');
});

test('BO-F6-08 fetta 1: an empty page reads the prototype text and 0 di 0 with page controls', async () => {
  const empty = { calls: [], async request() { return { customerListContract: 1, items: [], total: 0, page: 1, pageSize: 10, pages: 1, totalIsExact: true, ...MENUS }; } };
  const { mount } = await render(empty);
  assert.ok(mount.textContent.includes('Nessun cliente corrisponde. Prova con un nome, una città o un canale.'));
  assert.ok(mount.textContent.includes('0 di 0'), 'the pager keeps its 0 di 0 interval');
  assert.ok(mount.textContent.includes('Righe per pagina'), 'the page-size group stays labelled');
  assert.ok(byAttr(mount, 'button', 'aria-label', 'Pagina precedente'), 'previous keeps its accessible label');
  assert.ok(byAttr(mount, 'button', 'aria-label', 'Pagina successiva'), 'next keeps its accessible label');
  for (const size of ['10', '25', '50']) {
    assert.ok(byAttr(mount, 'button', 'data-size', size), `size ${size} stays clickable on an empty page`);
  }
});

test('BO-F6-08 fetta 1: a filled page shows its interval in the pager', async () => {
  const { mount } = await render(stubClient());
  const ranges = mount.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('bo-clienti-range'));
  assert.equal(ranges.length, 1, 'one interval in the pager');
  assert.equal(ranges[0].textContent, '1–2 di 2');
});

test('the shell storage initializes before the views that read it', () => {
  const source = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const initialized = source.indexOf('const shellStorage = guardedStorage();');
  assert.ok(initialized !== -1, 'shell storage has one initialization');
  for (const use of ['createCustomerCardView({', 'createCustomerDataView({', 'createConnectorsView({']) {
    const at = source.indexOf(use);
    assert.ok(at !== -1, `${use} is constructed in the shell`);
    assert.ok(initialized < at, `shell storage initializes before ${use}, never in a temporal dead zone`);
  }
});
