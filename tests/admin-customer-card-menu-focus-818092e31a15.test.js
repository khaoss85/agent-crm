import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Backlog 818092e31a15: i menu «Offerta» e «Cambia stato» della scheda
 * cliente si usano da tastiera — l'apertura porta il focus nella prima
 * voce, Freccia giù sul pulsante entra nella prima voce, Esc chiude e
 * riporta il focus al pulsante.
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

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: 0, truncated: false, items: [] },
  appointments: { available: true, count: 0, truncated: false, items: [] },
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
    items: [{
      id: 'o1', status: 'qualification', stage: 'qualification', name: 'Pacchetto 10 ingressi',
      owner: 'maria', createdAt: '2026-11-01T08:00:00.000Z',
    }],
  },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

function stubClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return { ok: true };
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

async function openCard() {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client: stubClient(), spaceId: 'presti', toast: () => {} })
    .renderCard('contact', 'c1');
  await flush();
  return mount;
}

const byAction = (mount, action) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === action);
const menuOf = (mount, action) => {
  const button = byAction(mount, action);
  const wrap = button.parentNode;
  return { button, menu: wrap.findAll('div').find((node) => node.getAttribute('role') === 'menu') };
};
const isOpen = (menu) => !String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');
const firstVoice = (menu) => menu.findAll('button')[0];

test('818092e31a15: «Offerta» apre il menu con il focus sulla prima voce', async () => {
  const mount = await openCard();
  const { button, menu } = menuOf(mount, 'new-offer');
  assert.ok(button && menu, 'the Offerta button and its menu exist');
  assert.ok(!isOpen(menu), 'the menu starts closed');
  button.dispatch('click');
  assert.ok(isOpen(menu), 'click opens the menu');
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'the button announces the open menu');
  assert.equal(firstVoice(menu).__focused, true, 'opening moves focus to the first voice');
});

test('818092e31a15: «Offerta» Freccia giù entra nella prima voce, Esc riporta il focus al pulsante', async () => {
  const mount = await openCard();
  const { button, menu } = menuOf(mount, 'new-offer');
  button.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.ok(isOpen(menu), 'ArrowDown opens the closed menu');
  assert.equal(firstVoice(menu).__focused, true, 'ArrowDown enters the first voice');
  menu.dispatch('keydown', { key: 'Escape' });
  assert.ok(!isOpen(menu), 'Esc closes the menu');
  assert.equal(button.__focused, true, 'Esc gives focus back to the button');
});

test('818092e31a15: «Cambia stato» apre il menu con il focus sulla prima voce', async () => {
  const mount = await openCard();
  const { button, menu } = menuOf(mount, 'change-offer-stage');
  assert.ok(button && menu, 'the Cambia stato button and its menu exist');
  button.dispatch('click');
  assert.ok(isOpen(menu), 'click opens the menu');
  assert.equal(button.getAttribute('aria-expanded'), 'true', 'the button announces the open menu');
  assert.ok(String(firstVoice(menu).textContent).includes('Proposta'), 'the first voice is the first legal move');
  assert.equal(firstVoice(menu).__focused, true, 'opening moves focus to the first voice');
});

test('818092e31a15: «Cambia stato» Freccia giù entra nella prima voce, Esc riporta il focus al pulsante', async () => {
  const mount = await openCard();
  const { button, menu } = menuOf(mount, 'change-offer-stage');
  button.dispatch('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.ok(isOpen(menu), 'ArrowDown opens the closed menu');
  assert.equal(firstVoice(menu).__focused, true, 'ArrowDown enters the first voice');
  menu.dispatch('keydown', { key: 'Escape' });
  assert.ok(!isOpen(menu), 'Esc closes the menu');
  assert.equal(button.__focused, true, 'Esc gives focus back to the button');
});
