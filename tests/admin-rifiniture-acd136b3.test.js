import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { buildShellNav, createShellView, settingsBadge } from '../apps/admin/public/admin-shell.js';
import { greetingForHour, romeHour } from '../apps/admin/public/admin-oggi.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:acd136b3cd5d — rifiniture dalla prova Mac del 18/11 sul live
 * (cronologia «da —», «Mostra precedenti», «Impostazioni 0», saluto notturno).
 * Un test per punto: autore sconosciuto, bottone precedenti, nome
 * accessibile di Impostazioni, saluto sull'ora di Roma anche di notte.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: true, value: '+393331234567', system: 'phone', reason: null },
  email: 'guido@palestra-esempio.it',
  socials: [],
  status: { value: 'contatto', reason: 'x' },
};

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: {
    company: { id: 'co1', name: 'Palestra Esempio' },
    contact: { id: 'c1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it', companyId: 'co1' },
  },
  externalIdentities: [],
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{ id: 'o1', status: 'open', name: 'Pacchetto 10 ingressi' }],
  },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

const message = (n) => ({
  entry: 'message', id: `m${n}`, conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
  sync: 'received', body: `Messaggio ${n}`, teamAuthorId: null,
  remoteHandle: '+393331234567', errorCode: null,
  occurredAt: `2026-10-${String((n % 27) + 1).padStart(2, '0')}T09:00:00.000Z`,
});

function stubClient({ entries, audit = [] } = {}) {
  const timeline = {
    customerTimelineContract: 1,
    subject: { resource: 'contact', id: 'c1' },
    conversations: { available: true, count: 0, truncated: false, items: [] },
    entries: { available: true, count: entries.length, truncated: false, items: entries },
    appointments: { available: true, count: 0, truncated: false, items: [] },
  };
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return { ok: true };
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return timeline;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: audit };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw Object.assign(new Error(`unexpected ${path}`), { status: 404 });
    },
  };
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

async function renderCard(client) {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({ doc, mount, client, spaceId: 'presti', toast: () => {} });
  await view.renderCard('contact', 'c1');
  await flush();
  return mount;
}

const timelineList = (mount) => mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-timeline');
const olderButton = (mount) => mount.findAll('button').find((node) => node.getAttribute('data-action') === 'timeline-older');

test('acd136b3cd5d: la cronologia omette «da» con autore sconosciuto, lo tiene con autore noto', async () => {
  const mount = await renderCard(stubClient({
    entries: [
      { entry: 'offer-created', id: 'e1', who: '—', text: 'Pacchetto 10 ingressi', occurredAt: '2026-11-02T10:00:00.000Z' },
      { entry: 'stage-moved', id: 'e2', who: '', text: 'Avanzamento', occurredAt: '2026-11-03T10:00:00.000Z' },
      { entry: 'offer-created', id: 'e3', who: 'Elena Rinaldi', text: 'Pacchetto 5 ingressi', occurredAt: '2026-11-04T10:00:00.000Z' },
      message(1),
    ],
  }));
  const text = timelineList(mount).textContent;
  assert.ok(text.includes('Offerta creata'), 'il fatto resta in pagina');
  assert.ok(text.includes('Cambio di stato'), 'il cambio resta in pagina');
  assert.ok(!text.includes('da —'), 'nessuna coda «da —» con autore ignoto');
  assert.ok(text.includes('da Elena Rinaldi'), 'l\u2019autore noto resta nominato');
});

test('acd136b3cd5d: la Storia stati omette «da» con attore ignoto', async () => {
  const mount = await renderCard(stubClient({
    entries: [message(1)],
    audit: [{
      id: 'a9', action: 'opportunity.stage_changed',
      createdAt: '2026-11-05T10:00:00.000Z', data: { from: 'contact', to: 'qualification' },
    }],
  }));
  const text = mount.textContent;
  assert.ok(text.includes('Storia stati'), 'la sezione resta in pagina');
  assert.ok(text.includes('Cambio di stato'), 'la mossa resta in pagina');
  assert.ok(!text.includes('da —'), 'nessuna coda «da —» con attore ignoto');
});

test('acd136b3cd5d: «Mostra precedenti» conta solo oltre la pagina e sparisce a tutto mostrato', async () => {
  const items = Array.from({ length: 45 }, (_, index) => message(index + 1));
  const mount = await renderCard(stubClient({ entries: items }));
  const shown = () => timelineList(mount).findAll('div')
    .filter((node) => typeof node.getAttribute('data-entry') === 'string' && node.getAttribute('data-entry') !== '');
  assert.equal(shown().length, 20, 'una pagina alla volta');
  assert.equal(olderButton(mount).textContent, 'Mostra precedenti · 20 di 25', 'il resto oltre la pagina conta');
  olderButton(mount).dispatch('click');
  await flush(4);
  assert.equal(shown().length, 40, 'la seconda pagina si aggiunge');
  assert.equal(olderButton(mount).textContent, 'Mostra precedenti', 'il resto da una pagina non conta «5 di 5»');
  olderButton(mount).dispatch('click');
  await flush(4);
  assert.equal(shown().length, 45, 'tutto mostrato');
  assert.equal(olderButton(mount), undefined, 'nessun bottone quando tutto è mostrato');
});

function renderSidebarShell() {
  const doc = createFakeDocument();
  const sidebar = createMount();
  createShellView({
    doc,
    sidebar,
    topbar: createMount(),
    spaces: [{ id: 'aurora', name: 'Studio Aurora', initials: 'SA' }],
    user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it' },
    items: buildShellNav({ customerDataAvailable: true }),
    navigate: () => {},
    notify: () => {},
    onLogout: () => {},
    onPickSpace: () => {},
  });
  return sidebar;
}

const accessibleName = (link) => link.findAll('span')
  .filter((node) => node.getAttribute('aria-hidden') !== 'true')
  .map((node) => node.textContent)
  .join('');

test('acd136b3cd5d: il nome accessibile del link Impostazioni è «Impostazioni» senza 0', () => {
  assert.equal(settingsBadge(0), '', 'zero non accende il badge');
  const sidebar = renderSidebarShell();
  const link = sidebar.findAll('a').find((node) => node.getAttribute('href') === '#/personalizzazione');
  assert.ok(link, 'la voce Impostazioni resta in pagina');
  assert.equal(accessibleName(link), 'Impostazioni', 'il segnaposto nascosto non entra nel nome');
  assert.ok(!accessibleName(link).includes('0'), 'nessuno zero nel nome');
});

test('acd136b3cd5d: il saluto segue Roma anche di notte, mai l\u2019orologio del dispositivo', () => {
  assert.equal(greetingForHour(4), 'Buonanotte', 'alle 4 di notte mai «Buonasera»');
  assert.equal(greetingForHour(22), 'Buonanotte');
  assert.equal(greetingForHour(18), 'Buonasera', 'la sera resta sera');
  // Luglio, 20:30Z: a Londra è sera, a Roma sono le 22:30 — notte.
  assert.equal(romeHour(new Date('2026-07-15T20:30:00.000Z')), 22);
  assert.equal(greetingForHour(romeHour(new Date('2026-07-15T20:30:00.000Z'))), 'Buonanotte');
});
