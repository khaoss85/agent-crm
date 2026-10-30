import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENTI_COLUMNS_KEY, CLIENTI_IMPORT_ROUTE, createCustomerListView, pageNumbers } from '../apps/admin/public/admin-clienti.js';
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
 * server text stays text. The Aggiungi cliente menu offers the AI paste and
 * the manual contact factory, one menu opens at a time, pills carry server
 * counts when named, and no control renders without a ui-* system class.
 */

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
    { id: 'cliente', label: 'Cliente', always: true, ai: false },
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
    ['Tutti', 'Da ricontattare oggi', 'Nuovi lead', 'Clienti attivi', 'Rinnovi entro 30 giorni']);
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

test('Aggiungi cliente opens a menu with the two prototype entries', async () => {
  let manualCalls = 0;
  const { mount } = await render(stubClient(), { onManualAdd: () => { manualCalls += 1; } });
  const add = mount.findAll('button').find((node) => node.textContent === 'Aggiungi cliente');
  assert.ok(add, 'the add button renders beside the title');
  assert.equal(add.getAttribute('aria-haspopup'), 'true');
  const menus = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-menu'));
  assert.ok(menus.length >= 4, 'add, filters, sort and columns menus render');
  assert.ok(menus[0].classList.contains('hidden'), 'the add menu starts closed');
  add.dispatch('click');
  assert.ok(!menus[0].classList.contains('hidden'), 'click opens the add menu');
  assert.ok(menus[0].textContent.includes("Crea con l'AI"));
  assert.ok(menus[0].textContent.includes('Incolla un messaggio o un biglietto da visita'));
  assert.ok(menus[0].textContent.includes('Compila manualmente'));
  assert.ok(menus[0].textContent.includes('Nome, recapiti e canale di provenienza'));
  byAttr(mount, 'button', 'data-action', 'add-manual').dispatch('click');
  assert.equal(manualCalls, 1, 'manual entry routes to the governed import form, never a parallel creation');
  assert.ok(menus[0].classList.contains('hidden'), 'choosing an entry closes the menu');
  let navigated = null;
  const plain = await render(stubClient(), { navigate: (hash) => { navigated = hash; } });
  plain.mount.findAll('button').find((node) => node.textContent === 'Aggiungi cliente').dispatch('click');
  byAttr(plain.mount, 'button', 'data-action', 'add-manual').dispatch('click');
  assert.equal(navigated, CLIENTI_IMPORT_ROUTE, 'without the section hook the entry navigates to the import screen');
});

test('the Clienti screen carries no import tool', async () => {
  // backlog:80b25fb0: the prototype's Clienti screen has no JSON import, so
  // the list renders without the Dati dei clienti section or its vocabulary.
  const { mount } = await render(stubClient());
  assert.deepEqual(mount.findAll('div').filter((node) =>
    (node.getAttribute('class') ?? '').split(/\s+/).includes('customer-data-section')), [],
  'no import section renders on the Clienti screen');
  for (const marker of ['Dati dei clienti', 'Righe (JSON)', 'customer-rows', 'Applica importazione', 'Anteprima (non scrive nulla)']) {
    assert.ok(!mount.textContent.includes(marker), `the Clienti screen never names ${JSON.stringify(marker)}`);
  }
});

test('a list read still in flight dies when the operator leaves the list', async () => {
  // backlog:80b25fb0: the list paints straight into the shell's shared
  // mount, so the shell invalidates it on every other route — a late
  // response must not clear the screen the operator just opened.
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const doc = createFakeDocument();
  const mount = createMount();
  const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  const client = {
    async request() {
      await gate;
      return {
        customerListContract: 1, items: [ROW_MARCO], total: 1, page: 1, pageSize: 10, pages: 1,
        totalIsExact: true, ...MENUS,
      };
    },
  };
  const view = createCustomerListView({ doc, mount, client, storage: store, notify: () => {} });
  const pending = view.render();
  view.invalidate();
  release();
  await pending;
  await flush();
  assert.ok(!mount.textContent.includes('Marco Rossi'), 'the late list response never paints over the new screen');
});

test("a contact from the site form shows 'Form sito' in Ultimo contatto", async () => {
  // backlog:80b25fb0: the site-forms package logs its inbound as the
  // website-form channel; the list shows the Italian label, never the raw id.
  const siteRow = {
    ...ROW_ANNA, channels: ['website-form'],
    lastContactAt: '2026-10-24T09:00:00.000Z', lastContactChannel: 'website-form',
  };
  const client = stubClient();
  client.request = async () => ({
    customerListContract: 1, items: [siteRow], total: 1, page: 1, pageSize: 10, pages: 1,
    totalIsExact: true, ...MENUS,
  });
  const { mount } = await render(client);
  const card = mount.findAll('article')[0];
  assert.ok(card.textContent.includes('Form sito'), 'the site-form channel reads as Form sito');
  assert.ok(!card.textContent.includes('website-form'), 'the raw channel id never leaks into the row');
  const tile = card.findAll('span').find((node) =>
    String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-tile'));
  assert.equal(tile?.getAttribute('title'), 'Form sito', 'the channel tile names Form sito too');
});

test('Ultimo contatto paints the mark, the excerpt and «canale · quando»', async () => {
  // backlog:22d4dd0f, C16: the prototype cell is the channel mark, the
  // message excerpt, then the mono «<canale> · <quando>» line.
  const excerptRow = {
    ...ROW_MARCO,
    lastContactAt: '2026-10-20T09:00:00.000Z', lastContactChannel: 'whatsapp',
    lastContactText: 'Ci vediamo domani per la prova gratuita?',
  };
  const client = stubClient();
  client.request = async () => ({
    customerListContract: 1, items: [excerptRow], total: 1, page: 1, pageSize: 10, pages: 1,
    totalIsExact: true, ...MENUS,
  });
  const { mount } = await render(client);
  const card = mount.findAll('article')[0];
  const when = card.querySelector('.bo-clienti-when');
  assert.ok(when, 'the mono quando line renders');
  assert.equal(when.textContent, 'WhatsApp · 20 ott', 'the mono line names the channel and the short day');
  assert.ok(card.textContent.includes('Ci vediamo domani per la prova gratuita?'), 'the excerpt renders beside the mark');
  const mark = card.querySelector('.bo-clienti-tile');
  assert.ok(mark, 'the channel mark renders before the excerpt');
  assert.equal(mark.getAttribute('aria-label'), 'WhatsApp', 'the mark names the channel to assistive tech');
});

test('Ultimo contatto of today reads «oggi HH:MM», a call names no excerpt', async () => {
  // backlog:22d4dd0f, C16: «WhatsApp · oggi 10:20» for a contact of today;
  // a latest call carries no text, so only channel and date render.
  const now = new Date().toISOString();
  const callRow = {
    ...ROW_MARCO,
    lastContactAt: now, lastContactChannel: 'phone', lastContactText: null,
  };
  const client = stubClient();
  client.request = async () => ({
    customerListContract: 1, items: [callRow], total: 1, page: 1, pageSize: 10, pages: 1,
    totalIsExact: true, ...MENUS,
  });
  const { mount } = await render(client);
  const card = mount.findAll('article')[0];
  const when = card.querySelector('.bo-clienti-when');
  assert.ok(when, 'the mono quando line renders for a call too');
  assert.match(when.textContent, /^Telefono · oggi \d{2}:\d{2}$/, 'today renders as «oggi HH:MM», never a bare date');
  assert.ok(!card.querySelector('.bo-clienti-tile') || !card.textContent.includes('…'),
    'no excerpt is invented for a call');
});

test('a hostile excerpt stays text, and no contact still reads «mai»', async () => {
  // backlog:22d4dd0f, C16+C23: hostile server text never becomes markup.
  const hostileRow = {
    ...ROW_MARCO,
    lastContactAt: '2026-10-20T09:00:00.000Z', lastContactChannel: 'whatsapp',
    lastContactText: '<img src=x onerror=alert(1)>',
  };
  const client = stubClient();
  client.request = async () => ({
    customerListContract: 1, items: [hostileRow, ROW_ANNA], total: 2, page: 1, pageSize: 10, pages: 1,
    totalIsExact: true, ...MENUS,
  });
  const { mount } = await render(client);
  const cards = mount.findAll('article');
  assert.equal(cards[0].findAll('img').length, 0, 'the excerpt never becomes an element');
  assert.ok(cards[0].textContent.includes('<img src=x onerror=alert(1)>'), 'the hostile text still reads as text');
  assert.ok(cards[1].textContent.includes('mai'), 'no contact still reads «mai»');
});

test("Crea con l'AI asks through the assistant, or hints without it", async () => {
  let asked = null;
  let notified = null;
  const wired = await render(stubClient(), { onAskAi: (question) => { asked = question; } });
  wired.mount.findAll('button').find((node) => node.textContent === 'Aggiungi cliente').dispatch('click');
  byAttr(wired.mount, 'button', 'data-action', 'add-ai').dispatch('click');
  assert.ok(asked, 'with the assistant panel the AI entry asks through it');
  const plain = await render(stubClient(), { notify: (message) => { notified = message; } });
  plain.mount.findAll('button').find((node) => node.textContent === 'Aggiungi cliente').dispatch('click');
  byAttr(plain.mount, 'button', 'data-action', 'add-ai').dispatch('click');
  assert.ok(notified, 'without onAskAi the entry explains itself instead of breaking');
});

test('only one menu opens at a time, and Escape closes it', async () => {
  const { mount } = await render(stubClient());
  const menus = () => mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-menu'));
  const opener = (label) => mount.findAll('button').find((node) => node.textContent === label);
  opener('Filtri').dispatch('click');
  assert.ok(!menus()[1].classList.contains('hidden'), 'the filters menu opens');
  opener('Ordina').dispatch('click');
  assert.ok(!menus()[2].classList.contains('hidden'), 'the sort menu opens');
  assert.ok(menus()[1].classList.contains('hidden'), 'opening a second menu closes the first');
  menus()[2].dispatch('keydown', { key: 'Escape' });
  assert.ok(menus()[2].classList.contains('hidden'), 'Escape closes the open menu');
});

test('the opening click does not close the menu via the document handler', async () => {
  // P1 regression: in a real browser the opening click bubbles to the
  // document handler, which used to hide the just-opened menu at once.
  const doc = createFakeDocument();
  const docClicks = [];
  const docWithOutside = {
    ...doc,
    addEventListener: (type, handler) => {
      if (type === 'click') docClicks.push(handler);
    },
  };
  const mount = createMount();
  const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  const view = createCustomerListView({ doc: docWithOutside, mount, client: stubClient(), storage: store, notify: () => {} });
  await view.render();
  assert.ok(docClicks.length >= 1, 'the view installs a per-instance document handler');
  const add = mount.findAll('button').find((node) => node.textContent === 'Aggiungi cliente');
  const menus = () => mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-menu'));
  add.dispatch('click', { target: add, stopPropagation: () => {} });
  assert.ok(!menus()[0].classList.contains('hidden'), 'the menu stays open after its own opening click');
  // The bubbled opening click reaches the document handler with the button
  // as target (inside .bo-clienti-menuwrap): it must be ignored.
  for (const handler of docClicks) handler({ target: add });
  assert.ok(!menus()[0].classList.contains('hidden'), 'the bubbled opening click does not close the menu');
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  // An outside click closes and syncs aria-expanded.
  for (const handler of docClicks) handler({ target: mount });
  assert.ok(menus()[0].classList.contains('hidden'), 'an outside click closes the menu');
  assert.equal(add.getAttribute('aria-expanded'), 'false');
});

test('opening a second menu syncs the first button back to closed', async () => {
  // P2: aria-expanded desynchronised when another menu opened.
  const { mount } = await render(stubClient());
  const opener = (label) => mount.findAll('button').find((node) => node.textContent === label);
  const filtersButton = opener('Filtri');
  const sortButton = opener('Ordina');
  filtersButton.dispatch('click');
  assert.equal(filtersButton.getAttribute('aria-expanded'), 'true');
  sortButton.dispatch('click');
  assert.equal(sortButton.getAttribute('aria-expanded'), 'true', 'the newly opened button reports expanded');
  assert.equal(filtersButton.getAttribute('aria-expanded'), 'false', 'the closed menu button reports collapsed');
});

test('Aggiungi cliente carries a single ui-btn-* variant', async () => {
  // P2: the add button rendered both ui-btn-primary and ui-btn-secondary.
  const { mount } = await render(stubClient());
  const add = mount.findAll('button').find((node) => node.textContent === 'Aggiungi cliente');
  const variants = String(add.getAttribute('class') ?? '').split(/\s+/).filter((cls) => cls.startsWith('ui-btn-'));
  assert.deepEqual(variants, ['ui-btn-primary'], 'a single primary variant, never primary plus secondary');
});

test('title row and open menu lines reuse styled classes only', async () => {
  // P2 rev-agent-crm-409-729d783ba359: the title-plus-button row and the
  // Aggiungi/Filtri/Colonne inner lines shipped classes no stylesheet
  // defines, so the row could not be a row. This screen owns no CSS: every
  // bo-* class its nodes carry must already be defined in styles.css.
  // bo-tile-*/bo-pill-* tint variants are exempt: they always pair with the
  // styled bo-clienti-tile/bo-clienti-pill bases and degrade to the neutral
  // base for channel systems or stati the stylesheet does not tint.
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const defined = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]));
  const boClasses = (root) => {
    const out = [];
    const walk = (node) => {
      for (const cls of String(node.getAttribute?.('class') ?? '').split(/\s+/).filter(Boolean)) {
        if (cls.startsWith('bo-') && !/^bo-(tile|pill)-/.test(cls)) out.push(cls);
      }
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(root);
    return out;
  };
  const styled = (node, what) => {
    const classes = boClasses(node);
    assert.ok(classes.length > 0, `${what} carries bo-* classes`);
    for (const cls of classes) assert.ok(defined.has(cls), `${what} class .${cls} is defined in styles.css`);
  };
  const { mount } = await render(stubClient());
  const title = mount.findAll('h1')[0];
  assert.ok(title, 'the screen renders its h1 title');
  styled(title.parentNode, 'title row');
  const opener = (label) => mount.findAll('button').find((node) => node.textContent === label)
    ?? mount.findAll('button').find((node) => String(node.textContent).startsWith(label));
  const menus = () => mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-menu'));
  opener('Aggiungi cliente').dispatch('click');
  assert.ok(!menus()[0].classList.contains('hidden'), 'the add menu opens');
  styled(menus()[0], 'Aggiungi menu');
  opener('Filtri').dispatch('click');
  assert.ok(!menus()[1].classList.contains('hidden'), 'the filters menu opens');
  styled(menus()[1], 'Filtri menu');
  opener('Colonne').dispatch('click');
  assert.ok(!menus()[3].classList.contains('hidden'), 'the columns menu opens');
  styled(menus()[3], 'Colonne menu');
});

test('the columns menu names its title and the always-visible Cliente row', async () => {
  const { mount } = await render(stubClient());
  mount.findAll('button').find((node) => node.textContent === 'Colonne 4/8').dispatch('click');
  assert.ok(mount.textContent.includes('Colonne visibili'), 'the menu names its title');
  assert.ok(mount.textContent.includes('Cliente · sempre visibile'), 'the fixed Cliente row names itself');
  assert.ok(mount.textContent.includes('Ripristina'), 'the reset stays');
});

test('the filters menu carries the prototype example', async () => {
  const { mount } = await render(stubClient());
  mount.findAll('button').find((node) => node.textContent === 'Filtri').dispatch('click');
  assert.ok(mount.textContent.includes('Es. «clienti di Milano con offerta sopra 10.000 €»'));
});

test('view pills show server counts when the server names them', async () => {
  const counted = {
    calls: [],
    async request() {
      return {
        customerListContract: 1, items: [], total: 0, page: 1, pageSize: 10, pages: 1,
        totalIsExact: true, ...MENUS,
        views: MENUS.views.map((view, index) => ({ ...view, count: (index + 1) * 3 })),
      };
    },
  };
  const { mount } = await render(counted);
  const tabs = buttons(mount).filter((node) => node.getAttribute('role') === 'tab');
  assert.deepEqual(tabs.map((node) => node.textContent),
    ['Tutti 3', 'Da ricontattare oggi 6', 'Nuovi lead 9', 'Clienti attivi 12', 'Rinnovi entro 30 giorni 15']);
});

test('the fallback views keep the prototype order before the server answers', async () => {
  const bare = { calls: [], async request() { return {}; } };
  const { mount } = await render(bare);
  const tabs = buttons(mount).filter((node) => node.getAttribute('role') === 'tab');
  assert.deepEqual(tabs.map((node) => node.textContent),
    ['Tutti', 'Da ricontattare oggi', 'Nuovi lead', 'Clienti attivi', 'Rinnovi entro 30 giorni']);
});

test('changing the view or the page size returns to page 1', async () => {
  // C12, C20: view and size switches re-read from the first page.
  const page = (items, pageNum, pagesCount) => ({
    customerListContract: 1, items, total: pagesCount * 10,
    page: pageNum, pageSize: 10, pages: pagesCount, totalIsExact: true,
  });
  const client = stubClient({ pages: [page([ROW_MARCO], 1, 3), page([ROW_ANNA], 2, 3), page([], 3, 3)] });
  const { mount } = await render(client);
  byAttr(mount, 'button', 'data-page', '2').dispatch('click');
  await flush();
  assert.ok(client.calls[client.calls.length - 1].includes('page=2'));
  byAttr(mount, 'button', 'data-view', 'nuovi-lead').dispatch('click');
  await flush();
  const switched = client.calls[client.calls.length - 1];
  assert.ok(switched.includes('vista=nuovi-lead'), `the server sees the view: ${switched}`);
  assert.ok(switched.includes('page=1'), `changing the view returns to page 1: ${switched}`);
  byAttr(mount, 'button', 'data-page', '2').dispatch('click');
  await flush();
  byAttr(mount, 'button', 'data-size', '25').dispatch('click');
  await flush();
  const resized = client.calls[client.calls.length - 1];
  assert.ok(resized.includes('pageSize=25'), `the server sees the size: ${resized}`);
  assert.ok(resized.includes('page=1'), `changing the size returns to page 1: ${resized}`);
});

test('the sort menu lists the four prototype orders', async () => {
  // C13: Ordina per, then Ultimo contatto, Nome A–Z, Valore offerta, Stato.
  const { mount } = await render(stubClient());
  mount.findAll('button').find((node) => node.textContent === 'Ordina').dispatch('click');
  for (const label of ['Ordina per', 'Ultimo contatto', 'Nome A–Z', 'Valore offerta', 'Stato']) {
    assert.ok(mount.textContent.includes(label), `the sort menu offers ${label}`);
  }
});

test('a row carries avatar, tiles, state pill, last contact, next step and its card link', async () => {
  // C16: name plus company (city/referente are not in the list contract, so
  // the row invents none); C17: the row reaches the scheda through its link.
  const { mount } = await render(stubClient());
  const cards = mount.findAll('article').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-clienti-row'));
  assert.equal(cards.length, 2, 'one card per customer');
  const first = cards[0];
  assert.ok(first.textContent.includes('Marco Rossi'));
  assert.ok(first.textContent.includes('MR'), 'the avatar carries the initials');
  assert.ok(first.textContent.includes('Palestra Esempio'), 'the company renders beside the name');
  const link = first.findAll('a').find((node) => node.getAttribute('data-action') === 'open-customer-card');
  assert.ok(link, 'the row links to the scheda cliente');
  assert.equal(link.getAttribute('href'), '#/customer-card/contact/c1');
  assert.ok(first.textContent.includes('WA'), 'the channel tile marks WhatsApp');
  assert.ok(first.textContent.includes('Cliente'), 'the state pill names the state');
  assert.ok(first.textContent.includes('WhatsApp · '), 'last contact names its channel');
  assert.ok(first.textContent.includes('✦ Prova gratuita'), 'the next step renders with its spark');
  assert.ok(first.textContent.includes('›'), 'the row carries its chevron');
});

test('a server failure reads as an Italian retry, never technical', async () => {
  // C23: Italian, non-technical, with a retry; never codes or English.
  const failing = { calls: [], async request() { throw Object.assign(new Error('boom'), { status: 500 }); } };
  const { mount } = await render(failing);
  const text = mount.textContent;
  assert.ok(text.includes('Riprova'), 'the failure offers a retry');
  assert.ok(!/NOT_FOUND|Error|undefined|NaN/.test(text), 'no technical residue leaks into the screen');
});

test('the clienti screen renders no raw control', async () => {
  // Acceptance: a control without a ui-* system class fails this screen.
  const rawControls = (root) => {
    const out = [];
    const walk = (node) => {
      const tag = String(node.tagName ?? '').toLowerCase();
      if (['button', 'select', 'input', 'textarea'].includes(tag)) {
        const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) out.push(`${tag}[${classes.join('.')}]`);
      }
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(root);
    return out;
  };
  const { mount } = await render(stubClient());
  assert.deepEqual(rawControls(mount), [], 'every control of the list carries a ui-* class');
  byAttr(mount, 'button', 'data-column', 'budget').dispatch('click');
  assert.deepEqual(rawControls(mount), [], 'enabling the AI column adds no raw control');
  mount.findAll('button').find((node) => node.textContent === 'Aggiungi cliente').dispatch('click');
  assert.deepEqual(rawControls(mount), [], 'the open add menu adds no raw control');
});

test('the shell storage initializes before the views that read it', () => {
  const source = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const initialized = source.indexOf('const shellStorage = guardedStorage();');
  assert.ok(initialized !== -1, 'shell storage has one initialization');
  for (const use of ['createCustomerCardView({', 'createCustomerListView({', 'createCustomerDataView({', 'createConnectorsView({']) {
    const at = source.indexOf(use);
    assert.ok(at !== -1, `${use} is constructed in the shell`);
    assert.ok(initialized < at, `shell storage initializes before ${use}, never in a temporal dead zone`);
  }
});
