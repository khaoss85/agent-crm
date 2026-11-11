// backlog:be99004b06e4 — ⌘K finds before it asks (giro UX 11/11, punto 36):
// typing in the top bar lists pages, customers and offers from local data
// and existing reads; arrows and Enter open a result, Esc closes the list;
// the AI is one explicit last row, «Chiedi all'assistente: …», and the
// panel answers at once with a waiting line.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShellNav, createShellView } from '../apps/admin/public/admin-shell.js';
import { createAssistantPanel } from '../apps/admin/public/admin-assistant.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const CUSTOMERS = [
  { resource: 'contact', id: 'c-1', name: 'Ada Lovelace', company: { name: 'Analitica Srl' }, email: 'ada@example.it' },
  { resource: 'contact', id: 'c-2', name: 'Adamo Riva', email: 'adamo@example.it' },
];
const OFFERS = [
  { id: 'o-1', name: 'Pacchetto 10 lezioni', companyName: 'Analitica Srl', contactName: 'Ada Lovelace' },
  { id: 'o-2', name: 'Abbonamento annuale', companyName: 'Rossi Spa' },
];

function shell({ customers = async () => CUSTOMERS, offers = async () => OFFERS } = {}) {
  const doc = createFakeDocument();
  doc.activeElement = null;
  const sidebar = createMount();
  const topbar = createMount();
  const seen = { navigate: [], asked: [], customerQueries: [], offersReads: 0 };
  const winListeners = {};
  const win = { addEventListener: (type, handler) => { (winListeners[type] ??= []).push(handler); } };
  const items = buildShellNav({
    pipelines: [{ name: 'vendite' }],
    customerDataAvailable: true,
  });
  const view = createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [{ id: 'prova', name: 'Spazio di prova', initials: 'SP' }],
    user: { name: 'Operatore', email: 'op@example.it' },
    navigate: (hash) => seen.navigate.push(hash),
    onAiSubmit: (text) => seen.asked.push(text),
    commandSearch: {
      customers: async (query) => { seen.customerQueries.push(query); return customers(query); },
      offers: async () => { seen.offersReads += 1; return offers(); },
    },
    schedule: (fn) => { fn(); return 1; },
    win,
  });
  view.update({ items, activeScreenId: 'oggi', screenLabel: 'Oggi' });
  const input = () => topbar.findAll('input').find((node) => String(node.getAttribute('class')).includes('bo-ai-input'));
  const list = () => topbar.findAll('div').find((node) => node.getAttribute('role') === 'listbox');
  const options = () => {
    const box = list();
    if (!box || box.classList.contains('hidden')) return [];
    const out = [];
    const walk = (node) => { for (const child of node.childNodes) { if (child.getAttribute?.('role') === 'option') out.push(child); walk(child); } };
    walk(box);
    return out;
  };
  const type = async (text) => {
    input().value = text;
    input().dispatch('input', {});
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const key = (name) => {
    const event = { key: name, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    input().dispatch('keydown', event);
    return event;
  };
  return { doc, topbar, view, seen, winListeners, input, list, options, type, key };
}

test('typing «Ada» lists the customers and offers, with the AI only as the last row', async () => {
  const s = shell();
  await s.type('Ada');
  const rows = s.options();
  const text = rows.map((row) => row.textContent);
  assert.ok(text.some((t) => t.includes('Ada Lovelace') && t.includes('Analitica Srl')), `customer row: ${text.join(' | ')}`);
  const customer = rows.find((row) => row.textContent.includes('Ada Lovelace') && row.getAttribute('data-kind') === 'customer');
  assert.equal(customer.getAttribute('href'), '#/customer-card/contact/c-1');
  const offer = rows.find((row) => row.getAttribute('data-kind') === 'offer');
  assert.ok(offer, 'the offer of Ada is listed');
  assert.equal(offer.getAttribute('href'), '#/offerte/o-1');
  assert.ok(!text.some((t) => t.includes('Abbonamento annuale')), 'an offer that does not match stays out');
  const last = rows[rows.length - 1];
  assert.equal(last.getAttribute('data-kind'), 'ask');
  assert.equal(last.textContent.includes('Chiedi all’assistente: «Ada»'), true);
  assert.deepEqual(s.seen.customerQueries, ['Ada'], 'the Clienti read runs with the typed words');
  assert.deepEqual(s.seen.asked, [], 'typing never calls the AI');
  const group = s.list().findAll('p').map((node) => node.textContent);
  assert.ok(group.includes('Clienti') && group.includes('Offerte'), `groups: ${group.join(', ')}`);
  assert.equal(s.input().getAttribute('aria-expanded'), 'true');
});

test('pages are found from the shell voices: Enter opens the first one', async () => {
  const s = shell();
  await s.type('pipe');
  const first = s.options()[0];
  assert.equal(first.getAttribute('data-kind'), 'page');
  assert.equal(first.textContent.includes('Pipeline'), true);
  assert.equal(first.getAttribute('aria-selected'), 'true');
  const event = s.key('Enter');
  assert.equal(event.defaultPrevented, true, 'Enter does not also submit the bar to the AI');
  assert.deepEqual(s.seen.navigate, ['#/pipelines/vendite']);
  assert.deepEqual(s.seen.asked, []);
  assert.equal(s.options().length, 0, 'the list closes after opening a result');
  assert.equal(s.input().value, '');
});

test('pages match by any word: «spazi e acc» finds Spazi e accessi, «impost» Impostazioni', async () => {
  const s = shell();
  await s.type('spazi e acc');
  assert.ok(s.options().some((row) => row.textContent.includes('Spazi e accessi') && row.getAttribute('href') === '#/spazi-accessi'));
  await s.type('impost');
  assert.ok(s.options().some((row) => row.textContent.includes('Impostazioni')));
});

test('arrows move the selection and Enter opens the selected customer', async () => {
  const s = shell();
  await s.type('Ada');
  s.key('ArrowDown');
  const selected = s.options().find((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(selected.getAttribute('href'), '#/customer-card/contact/c-2');
  assert.equal(s.input().getAttribute('aria-activedescendant'), selected.getAttribute('id'));
  s.key('ArrowUp');
  s.key('ArrowUp');
  const wrapped = s.options().find((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(wrapped.getAttribute('data-kind'), 'ask', 'ArrowUp from the top wraps to the ask row');
  s.key('ArrowDown');
  s.key('Enter');
  assert.deepEqual(s.seen.navigate, ['#/customer-card/contact/c-1']);
});

test('Esc closes the list and keeps the words; nothing behind it hears that Esc', async () => {
  const s = shell();
  await s.type('Ada');
  const event = s.key('Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
  assert.equal(s.options().length, 0);
  assert.equal(s.input().getAttribute('aria-expanded'), 'false');
  assert.equal(s.input().value, 'Ada');
  s.key('ArrowDown');
  assert.ok(s.options().length > 0, 'an arrow reopens the list');
});

test('a click outside the bar closes the list; a click on a row opens it', async () => {
  const s = shell();
  await s.type('Ada');
  const outside = createMount();
  for (const handler of s.winListeners.click ?? []) handler({ target: outside });
  assert.equal(s.options().length, 0);
  s.key('ArrowDown');
  const offer = s.options().find((row) => row.getAttribute('data-kind') === 'offer');
  const down = { prevented: false, preventDefault() { this.prevented = true; } };
  offer.dispatch('mousedown', down);
  assert.equal(down.prevented, true, 'the input keeps the focus');
  offer.dispatch('click', { preventDefault() {} });
  assert.deepEqual(s.seen.navigate, ['#/offerte/o-1']);
});

test('the ask row hands the words to the assistant; with no match it is the only row', async () => {
  const s = shell({ customers: async () => [], offers: async () => [] });
  await s.type('meteo a Milano');
  const rows = s.options();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].getAttribute('data-kind'), 'ask');
  assert.ok(s.list().textContent.includes('Nessun cliente, offerta o pagina'));
  s.key('Enter');
  assert.deepEqual(s.seen.asked, ['meteo a Milano']);
  assert.deepEqual(s.seen.navigate, []);
});

test('«@Agente …» skips the search and goes to the assistant', async () => {
  const s = shell();
  await s.type('@Riaggancio chiama i lead');
  assert.deepEqual(s.seen.customerQueries, []);
  assert.equal(s.options().length, 1);
  s.key('Enter');
  assert.deepEqual(s.seen.asked, ['@Riaggancio chiama i lead']);
});

test('a slow answer for older words never lands under newer ones', async () => {
  const pending = [];
  const s = shell({ customers: (query) => new Promise((resolve) => pending.push({ query, resolve })) });
  await s.type('Ad');
  await s.type('Ada');
  assert.ok(s.list().textContent.includes('Cerco tra clienti e offerte'), 'the list says it is searching');
  pending.find((entry) => entry.query === 'Ada').resolve([CUSTOMERS[0]]);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  pending.find((entry) => entry.query === 'Ad').resolve([{ resource: 'contact', id: 'c-9', name: 'Adelmo Vecchio' }]);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  const text = s.options().map((row) => row.textContent).join(' | ');
  assert.ok(text.includes('Ada Lovelace'));
  assert.ok(!text.includes('Adelmo Vecchio'), 'the stale answer is dropped');
});

test('without the Clienti read (not composed) the pages and the ask row still answer', async () => {
  const s = shell({ customers: async () => null, offers: async () => null });
  await s.type('cal');
  const kinds = s.options().map((row) => row.getAttribute('data-kind'));
  assert.deepEqual(kinds, ['page', 'ask']);
  assert.ok(!s.list().textContent.includes('Clienti'));
});

test('the offers read is reused while typing, not repeated per key', async () => {
  const s = shell();
  await s.type('Ad');
  await s.type('Ada');
  await s.type('Ada L');
  assert.equal(s.seen.offersReads, 1);
});

test('⌘K focuses the bar and reopens what was typed; a top-bar repaint keeps the words', async () => {
  const s = shell();
  await s.type('Ada');
  s.key('Escape');
  s.doc.activeElement = s.input();
  s.view.update({ activeScreenId: 'clienti', screenLabel: 'Clienti' });
  assert.equal(s.input().value, 'Ada', 'the repaint keeps the typed words');
  for (const handler of s.winListeners.keydown ?? []) handler({ key: 'k', metaKey: true, preventDefault() {} });
  assert.equal(s.input().__focused, true);
  assert.ok(s.options().length > 0, '⌘K reopens the list');
});

test('a question from ⌘K shows at once in the panel, with a waiting line, before the status answers', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let releaseStatus;
  const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
  const client = {
    async request(path) {
      if (path === '/api/assistant/status') {
        await statusGate;
        return { mode: 'dry-run', freeQuestions: 'disabled' };
      }
      const error = new Error('no');
      Object.assign(error, { status: 404, code: 'MODULE_NOT_FOUND' });
      throw error;
    },
  };
  const panel = createAssistantPanel({ doc, mount, client });
  const opening = panel.open('oggi', undefined, undefined, 'quanti lead oggi?');
  await Promise.resolve();
  assert.equal(panel.getState().open, true, 'the panel is open before the status probe answers');
  assert.ok(mount.textContent.includes('«quanti lead oggi?»'), 'the question is echoed');
  assert.ok(mount.textContent.includes('Chiedo all’assistente…'), 'a waiting line shows');
  releaseStatus();
  await opening;
  assert.ok(!mount.textContent.includes('Chiedo all’assistente…'), 'the waiting line goes when the answer path starts');
});

test('Enter while customers are still being read waits for them instead of asking the AI', async () => {
  const pending = [];
  const s = shell({ customers: (query) => new Promise((resolve) => pending.push({ query, resolve })), offers: async () => [] });
  await s.type('Ada');
  s.key('Enter');
  assert.deepEqual(s.seen.asked, [], 'no AI while the read runs');
  assert.ok(s.list().textContent.includes('Cerco tra clienti e offerte'));
  pending[0].resolve([CUSTOMERS[0]]);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  const selected = s.options().find((row) => row.getAttribute('aria-selected') === 'true');
  assert.equal(selected.getAttribute('href'), '#/customer-card/contact/c-1', 'the first result arrives selected');
  s.key('Enter');
  assert.deepEqual(s.seen.navigate, ['#/customer-card/contact/c-1']);
});

test('a second Enter while the read still hangs asks the AI', async () => {
  const s = shell({ customers: () => new Promise(() => {}), offers: async () => [] });
  await s.type('Ada');
  s.key('Enter');
  assert.deepEqual(s.seen.asked, []);
  s.key('Enter');
  assert.deepEqual(s.seen.asked, ['Ada']);
});

// ---- review Muse #779, giro 1 --------------------------------------------

test('review #779: a failed read is logged without the typed words and reads as its own state, not «no match»', async () => {
  const original = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args);
  try {
    const s = shell({
      customers: async () => { throw Object.assign(new Error('Ada Lovelace not found'), { status: 502, code: 'BAD_GATEWAY' }); },
      offers: async () => [],
    });
    await s.type('Ada');
    const text = s.list().textContent;
    assert.ok(text.includes('Non riesco a leggere i clienti adesso'), text);
    assert.ok(!text.includes('Nessun cliente, offerta o pagina'), 'a failure is not shown as an empty result');
    assert.equal(logged.length, 1);
    assert.ok(String(logged[0][0]).includes('lettura clienti non riuscita'));
    assert.deepEqual(logged[0][1], { name: 'Error', status: 502, code: 'BAD_GATEWAY' });
    assert.ok(!JSON.stringify(logged).includes('Ada'), 'neither the query nor the message reach the log');
  } finally {
    console.warn = original;
  }
});

test('review #779: the form submit (mobile «Vai», requestSubmit) opens the selected row, never the AI', async () => {
  const s = shell();
  await s.type('Ada');
  const form = s.topbar.findAll('form')[0];
  form.dispatch('submit', { preventDefault() {} });
  assert.deepEqual(s.seen.navigate, ['#/customer-card/contact/c-1']);
  assert.deepEqual(s.seen.asked, []);
});

test('review #779: keydown Enter followed by the browser submit acts once', async () => {
  const s = shell();
  await s.type('Ada');
  s.key('Enter');
  const form = s.topbar.findAll('form')[0];
  form.dispatch('submit', { preventDefault() {} });
  assert.deepEqual(s.seen.navigate, ['#/customer-card/contact/c-1']);
  assert.deepEqual(s.seen.asked, [], 'the trailing submit does not also open the assistant');
});

test('review #779: an empty bar submitted still opens the assistant', async () => {
  const s = shell();
  const form = s.topbar.findAll('form')[0];
  form.dispatch('submit', { preventDefault() {} });
  assert.deepEqual(s.seen.asked, ['']);
});

test('review #779: a hung offers read never locks the offers group after the menu resets', async () => {
  let calls = 0;
  const s = shell({
    customers: async () => [],
    offers: () => { calls += 1; return calls === 1 ? new Promise(() => {}) : Promise.resolve(OFFERS); },
  });
  await s.type('Ada');
  s.key('Enter');
  s.key('Enter'); // the second Enter asks the AI and resets the menu
  assert.deepEqual(s.seen.asked, ['Ada']);
  await s.type('Pacch');
  assert.equal(calls, 2, 'the next query reads the offers again');
  assert.ok(s.options().some((row) => row.getAttribute('href') === '#/offerte/o-1'));
  assert.ok(!s.list().textContent.includes('Cerco tra clienti e offerte'));
});

test('review #779: a space switch drops what the list read in the space left behind', async () => {
  const s = shell();
  await s.type('Ada');
  assert.ok(s.options().some((row) => row.textContent.includes('Ada Lovelace')));
  s.view.setSpaces([{ id: 'prova', name: 'Spazio di prova' }, { id: 'altro', name: 'Altro spazio' }], 'altro');
  assert.equal(s.input().value, '', 'the words go with the space');
  assert.equal(s.options().length, 0);
  for (const handler of s.winListeners.keydown ?? []) handler({ key: 'k', metaKey: true, preventDefault() {} });
  assert.equal(s.options().length, 0, '⌘K does not bring back the other space’s customers');
});
