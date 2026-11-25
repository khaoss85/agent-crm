import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerHandoff, mergeHandoffIntoDraft } from '../apps/admin/public/admin-composer-handoff.js';
import { createOfferDetail, offerComposeTarget } from '../apps/admin/public/admin-offer.js';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:ab7c38cbcca5 — from the offer page, with the link ready, one press
 * opens the customer's scheda with the message already in the composer.
 * Red before the cure: the offer page has no «Scrivi a» action and the
 * scheda never opens a composer by itself, so the owner had to open the
 * scheda and paste. Green after: the message travels through a one-shot,
 * space-keyed store, lands only in the composer of the same customer in the
 * same space, and an offer without a customer scheda shows no action.
 */

const ORIGIN = 'https://spazio.example';
const TOKEN = 'a'.repeat(64);
const URL = `${ORIGIN}/q/${TOKEN}`;
const EXPIRES = '2026-12-01T10:00:00.000Z';

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('ab7c38cbcca5: the handoff store is one-shot, per customer, per space, short-lived', () => {
  let space = 'presti';
  let clock = 1_000;
  const store = createComposerHandoff({ space: () => space, now: () => clock, ttlMs: 60_000 });
  assert.equal(store.stage('contact', 'c1', '   '), false, 'an empty message is never kept');
  assert.equal(store.stage('Contact!', 'c1', 'ciao'), false, 'an invalid resource is never kept');
  assert.equal(store.stage('contact', 'c1', 'Ciao Giulia'), true);
  assert.equal(store.take('contact', 'c2'), null, 'another customer never receives it');
  space = 'altro';
  assert.equal(store.take('contact', 'c1'), null, 'another space never receives it');
  space = 'presti';
  assert.deepEqual(store.take('contact', 'c1'), { text: 'Ciao Giulia', subject: '' }, 'the same customer in the same space takes it');
  assert.equal(store.take('contact', 'c1'), null, 'taken means gone');
  store.stage('contact', 'c1', 'primo');
  store.stage('contact', 'c1', 'secondo');
  assert.equal(store.take('contact', 'c1')?.text, 'secondo', 'only the last prepared message is handed over');
  store.stage('contact', 'c1', 'vecchio');
  clock += 60_001;
  assert.equal(store.take('contact', 'c1'), null, 'a stale message is dropped');
});

test('ab7c38cbcca5: a typed draft is never lost when the message lands', () => {
  assert.equal(mergeHandoffIntoDraft('', 'Messaggio'), 'Messaggio');
  assert.equal(mergeHandoffIntoDraft('  \n', 'Messaggio'), 'Messaggio');
  assert.equal(mergeHandoffIntoDraft('Ciao Giulia,', 'Messaggio'), 'Ciao Giulia,\n\nMessaggio');
  assert.equal(mergeHandoffIntoDraft('Ciao\n\nMessaggio', 'Messaggio'), 'Ciao\n\nMessaggio', 'never twice');
});

test('ab7c38cbcca5: the compose target needs a customer with a scheda', () => {
  assert.deepEqual(offerComposeTarget({ contactName: 'Giulia Verdi', contactId: 'c1' }),
    { resource: 'contact', id: 'c1', name: 'Giulia Verdi', href: '#/customer-card/contact/c1' });
  assert.deepEqual(offerComposeTarget({ companyName: 'Palestra Esempio', companyId: 'co 1' }),
    { resource: 'company', id: 'co 1', name: 'Palestra Esempio', href: '#/customer-card/company/co%201' });
  assert.equal(offerComposeTarget({ contactName: 'Giulia Verdi' }), null, 'a name without a scheda');
  assert.equal(offerComposeTarget({ name: 'Offerta senza cliente' }), null, 'no customer at all');
});

// ---- offer page ----

const SCHEMA = {
  pipelines: [{
    pipelineContract: 1, name: 'b2b-sales', label: 'B2B Sales', module: 'opportunity', defaultStage: 'discovery',
    stages: [{ key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 }],
  }],
};

const RECORD = {
  id: 'off1', name: 'Cucina per Giulia', contactName: 'Giulia Verdi', contactId: 'c1',
  companyName: null, companyId: null, pipelineKey: 'b2b-sales', pipelineStage: 'discovery', stage: 'discovery',
  valueCents: 2750000, currency: 'EUR', expectedCloseDate: '2026-11-20',
  createdAt: '2026-10-02T09:15:00.000Z', updatedAt: '2026-10-28T18:40:00.000Z', owner: 'maria',
};

const QUOTE = {
  id: 'q1', opportunityId: 'off1', priceBookId: 'pb1', currency: 'EUR', status: 'approved',
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
};

function offerClient(record) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (path === '/api/schema') return SCHEMA;
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && method === 'GET') return { ...record };
      if (path === '/api/modules/quote/records/q1/actions/share-link' && method === 'POST') {
        return { result: { alreadyExisted: false, token: TOKEN, share: { expiresAt: EXPIRES } } };
      }
      if (path.startsWith('/api/modules/quote/records')) return { items: [QUOTE] };
      return { items: [] };
    },
  };
}

async function openOffer(record, handoff) {
  const doc = createFakeDocument();
  doc.defaultView = { navigator: { clipboard: { writeText: async () => {} } } };
  const mount = createMount();
  const went = [];
  const view = createOfferDetail({
    doc, mount, client: offerClient(record), origin: ORIGIN, composerHandoff: handoff,
    toast: () => {}, navigate: (hash) => went.push(hash),
  });
  await view.renderOfferDetail('off1');
  await flush();
  return { mount, went };
}

const byAction = (mount, action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
const isHidden = (node) => node.getAttribute('hidden') !== null && node.getAttribute('hidden') !== undefined;

test('ab7c38cbcca5: with the link ready, «Scrivi a» opens the scheda with the message handed over', async () => {
  const store = createComposerHandoff({ space: () => 'presti' });
  const { mount, went } = await openOffer(RECORD, store);
  const compose = byAction(mount, 'offer-share-compose');
  assert.ok(compose, 'the offer with a customer offers «Scrivi a» (red before the cure)');
  assert.equal(compose.textContent, 'Scrivi a Giulia Verdi');
  assert.ok(isHidden(compose), 'before the link is ready there is nothing to hand over');
  byAction(mount, 'offer-share-link').dispatch('click');
  await flush();
  assert.ok(!isHidden(compose), 'with the message ready the action shows');
  assert.ok(mount.textContent.includes('«Scrivi a Giulia Verdi»'), 'the status line names the way to send it');
  compose.dispatch('click');
  assert.deepEqual(went, ['#/customer-card/contact/c1'], 'one press opens the customer scheda');
  const handed = store.take('contact', 'c1');
  assert.ok(handed?.text.includes(URL), 'the whole message with the link waits for that scheda');
  assert.ok(handed?.text.includes('Cucina per Giulia'), 'it is the same ready message');
  assert.equal(handed?.subject, 'Offerta «Cucina per Giulia»', 'an email gets a subject that names the offer');
});

test('ab7c38cbcca5: an offer without a customer scheda shows no «Scrivi a»', async () => {
  const store = createComposerHandoff({ space: () => 'presti' });
  for (const record of [
    { ...RECORD, contactName: null, contactId: null },
    { ...RECORD, contactId: null },
  ]) {
    const { mount } = await openOffer(record, store);
    byAction(mount, 'offer-share-link').dispatch('click');
    await flush();
    assert.equal(byAction(mount, 'offer-share-compose'), undefined, 'no customer scheda, no action');
    assert.ok(mount.textContent.includes('Link pronto, da inviare.'), 'the copy flow stays as before');
  }
});

// ---- scheda ----

const cardOf = (id, name) => ({
  customerCardContract: 1,
  subject: { resource: 'contact', id },
  name,
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: false, value: null },
  email: `${id}@esempio.invalid`,
  socials: [],
  status: { value: 'contatto' },
});

const timelineOf = (id) => ({
  customerTimelineContract: 1,
  subject: { resource: 'contact', id },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: 0, truncated: false, items: [] },
  appointments: { available: true, count: 0, truncated: false, items: [] },
});

const profileOf = (id) => ({
  customerProfileContract: 1,
  subject: { resource: 'contact', id },
  canonicalIdentity: { linked: false, members: [] },
  identity: { contact: { id } },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
});

const schedaClient = {
  async request(path, options = {}) {
    enforceAdminWriteGate(path, options);
    if (path.startsWith('/api/customer-hub/card/')) {
      const id = path.split('/').pop();
      return cardOf(id, id === 'c1' ? 'Giulia Verdi' : 'Sara Blu');
    }
    if (path.startsWith('/api/customer-hub/timeline/')) return timelineOf(path.split('/').pop());
    if (path.startsWith('/api/customer-data/profile/')) return profileOf(path.split('/').pop());
    if (path.startsWith('/api/connectors')) {
      return { connectors: [{ channel: 'email', status: 'active', connectionKey: 'gmail-1', account: 'studio@palestra-esempio.it' }] };
    }
    if (path === '/api/profile') throw Object.assign(new Error('no profile'), { status: 404 });
    if (path.startsWith('/api/audit')) return { items: [] };
    if (path === '/api/spine/memberships') return { items: [] };
    if (path.startsWith('/api/customer-hub/messages')) return { items: [] };
    throw Object.assign(new Error(`Not Found: ${path}`), { status: 404 });
  },
};

function openScheda(handoff, spaceId = 'presti') {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc, mount, client: schedaClient, spaceId, origin: ORIGIN, composerHandoff: handoff,
    toast: () => {}, wait: () => Promise.resolve(),
  });
  return { mount, view };
}

const composerText = (mount) => {
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  return panel ? String(panel.findAll('textarea')[0]?.value ?? '') : null;
};

const MESSAGE = `Ciao, ecco la tua offerta «Cucina per Giulia»: ${URL}`;

test('ab7c38cbcca5: the scheda of that customer opens its composer with the message', async () => {
  const store = createComposerHandoff({ space: () => 'presti' });
  store.stage('contact', 'c1', MESSAGE, 'Offerta «Cucina per Giulia»');
  const { mount, view } = openScheda(store);
  await view.renderCard('contact', 'c1');
  await flush();
  assert.equal(composerText(mount), MESSAGE, 'the composer is open with the message ready for Invia (red before the cure)');
  const subject = mount.findAll('input').find((node) => String(node.getAttribute('class') ?? '').includes('subject'));
  assert.equal(subject?.value, 'Offerta «Cucina per Giulia»', 'the email subject names the offer');
  assert.equal(store.take('contact', 'c1'), null, 'the message was taken once');
  // A later visit of the same scheda never reopens it by itself.
  await view.renderCard('contact', 'c2');
  await flush();
  await view.renderCard('contact', 'c1');
  await flush();
  const reopened = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.equal(reopened, undefined, 'one-shot: the next visit opens no composer by itself');
});

test('ab7c38cbcca5: the message never reaches another customer or another space', async () => {
  const store = createComposerHandoff({ space: () => 'presti' });
  store.stage('contact', 'c1', MESSAGE);
  const other = openScheda(store);
  await other.view.renderCard('contact', 'c2');
  await flush();
  assert.equal(composerText(other.mount), null, 'customer B opens no composer');
  assert.ok(!other.mount.textContent.includes(TOKEN), 'no trace of the link on B');

  let space = 'presti';
  const switching = createComposerHandoff({ space: () => space });
  switching.stage('contact', 'c1', MESSAGE);
  space = 'altro';
  const elsewhere = openScheda(switching, 'altro');
  await elsewhere.view.renderCard('contact', 'c1');
  await flush();
  assert.equal(composerText(elsewhere.mount), null, 'the same customer id in another space receives nothing');
  space = 'presti';
  assert.equal(switching.take('contact', 'c1')?.text, MESSAGE, 'the message is still waiting in its own space');
});
