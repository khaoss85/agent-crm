import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Backlog 53c61a1caf4f: dentro i menu aperti «Offerta» e «Cambia stato»
 * della scheda cliente Freccia giù e Freccia su scorrono le voci (in
 * ciclo), Home porta alla prima, Fine all'ultima.
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

async function openMenu(action) {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client: stubClient(), spaceId: 'presti', toast: () => {} })
    .renderCard('contact', 'c1');
  await flush();
  const button = mount.findAll('button')
    .find((node) => node.getAttribute('data-action') === action);
  assert.ok(button, 'the menu button exists');
  const menu = button.parentNode.findAll('div').find((node) => node.getAttribute('role') === 'menu');
  assert.ok(menu, 'the menu exists');
  button.dispatch('click');
  const voices = menu.findAll('button');
  assert.ok(voices.length >= 2, 'the open menu has at least two voices');
  return { button, menu, voices };
}

const clearFocus = (voices) => { for (const voice of voices) voice.__focused = false; };
const press = (node, key) => node.dispatch('keydown', { key, preventDefault() {} });
const isOpen = (menu) => !String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');

for (const [label, action] of [['Offerta', 'new-offer'], ['Cambia stato', 'change-offer-stage']]) {
  test(`53c61a1caf4f: «${label}» Freccia giù e su scorrono le voci del menu aperto`, async () => {
    const { voices } = await openMenu(action);
    clearFocus(voices);
    press(voices[0], 'ArrowDown');
    assert.equal(voices[1].__focused, true, 'ArrowDown moves to the next voice');
    clearFocus(voices);
    press(voices[1], 'ArrowUp');
    assert.equal(voices[0].__focused, true, 'ArrowUp moves to the previous voice');
  });

  test(`53c61a1caf4f: «${label}» Fine e Home portano a ultima e prima voce`, async () => {
    const { voices } = await openMenu(action);
    const last = voices.length - 1;
    clearFocus(voices);
    press(voices[0], 'End');
    assert.equal(voices[last].__focused, true, 'End moves to the last voice');
    clearFocus(voices);
    press(voices[last], 'Home');
    assert.equal(voices[0].__focused, true, 'Home moves to the first voice');
  });

  test(`53c61a1caf4f: «${label}» alle estremità il giro continua in ciclo`, async () => {
    const { voices } = await openMenu(action);
    const last = voices.length - 1;
    clearFocus(voices);
    press(voices[last], 'ArrowDown');
    assert.equal(voices[0].__focused, true, 'ArrowDown on the last voice wraps to the first');
    clearFocus(voices);
    press(voices[0], 'ArrowUp');
    assert.equal(voices[last].__focused, true, 'ArrowUp on the first voice wraps to the last');
  });

  test(`53c61a1caf4f: «${label}» Esc sulla voce chiude e torna al pulsante`, async () => {
    const { button, menu, voices } = await openMenu(action);
    assert.ok(isOpen(menu), 'the menu starts open');
    press(voices[0], 'Escape');
    assert.ok(!isOpen(menu), 'Esc closes the menu');
    assert.equal(button.__focused, true, 'Esc gives focus back to the button');
  });
}
