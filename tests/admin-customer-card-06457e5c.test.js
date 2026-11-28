import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:06457e5c9717 — scheda cliente: rifinitura stato vuoto, errori,
 * focus, card e campi vuoti. Verifica Mac 13/11, verifier back 17/11
 * (returns: 1): lo stato vuoto cita «qui sotto», l'id inesistente non legge
 * mai «cliente non trovato».
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: false, value: null },
  email: 'guido@palestra-esempio.it',
  socials: [],
  status: { value: 'contatto' },
};

const emptyTimeline = () => ({
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: 0, truncated: false, items: [] },
  appointments: { available: true, count: 0, truncated: false, items: [] },
});

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: {
    company: { id: 'co1', name: 'Palestra Esempio' },
    contact: { id: 'c1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it', companyId: 'co1' },
  },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

function fakeClient({ card = CARD, cardError = null, timeline = emptyTimeline(), profile = PROFILE } = {}) {
  const writes = [];
  return {
    writes,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') {
        writes.push({ path });
        return { id: 'n1', body: 'x', actorId: 'google|118', occurredAt: '2026-11-11T10:00:00.000Z' };
      }
      if (path.startsWith('/api/customer-hub/card/')) {
        if (cardError) throw cardError;
        return card;
      }
      if (path.startsWith('/api/customer-hub/timeline/')) return timeline;
      if (path.startsWith('/api/customer-data/profile/')) return profile;
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/schema') return { pipelines: [] };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(client, extra = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti', toast: () => {},
    navigate: (hash) => { navigated.push(hash); }, ...extra,
  });
  await view.renderCard('contact', 'c1');
  await flush();
  return { mount, view, navigated };
}

const noteField = (mount) => mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody');
const byAction = (mount, action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
const key = (name, extra = {}) => ({ key: name, preventDefault() { this.prevented = true; }, ...extra });

test('06457e5c9717: id inesistente legge «Cliente non trovato» con ritorno a Clienti', async () => {
  const gone = Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' });
  const { mount, navigated } = await open(fakeClient({ cardError: gone }));
  const text = mount.textContent;
  assert.ok(text.includes('Cliente non trovato'), 'the 404 panel names the missing customer');
  assert.ok(text.includes('Questo cliente non esiste più'), 'a 404 is not a temporary error');
  assert.ok(!text.includes('Riprova'), 'a 404 never invites a retry that cannot succeed');
  assert.equal(byAction(mount, 'scheda-retry'), undefined, 'no retry button on a 404');
  const back = byAction(mount, 'back-to-clienti');
  assert.ok(back, 'the panel offers the way back to Clienti');
  back.dispatch('click');
  assert.deepEqual(navigated, ['#/customer-data'], 'the way back returns to Clienti');
});

test('06457e5c9717: errore vero resta «Scheda non disponibile» con Riprova', async () => {
  const down = Object.assign(new Error('boom'), { status: 503 });
  const { mount } = await open(fakeClient({ cardError: down }));
  assert.ok(mount.textContent.includes('Scheda non disponibile'), 'a transient failure keeps the retry panel');
  assert.ok(byAction(mount, 'scheda-retry'), 'the retry button stays for a transient failure');
});

test('06457e5c9717: stato vuoto senza «qui sotto» né bottoni fantasma', async () => {
  const { mount } = await open(fakeClient());
  const text = mount.textContent;
  assert.ok(!text.includes('qui sotto'), 'the empty state never says «qui sotto»');
  assert.ok(!text.includes('«Scrivi»'), 'no phantom «Scrivi» button is named');
  assert.ok(!text.includes('«WhatsApp»'), 'no channel button is named when it may not exist');
  assert.ok(text.includes('Ancora nessun contatto'), 'the empty title stays');
});

test('06457e5c9717: vista note senza «qui sotto»', async () => {
  const note = {
    entry: 'note', id: 'n0', body: 'Richiamare lunedì', teamAuthorId: null,
    occurredAt: '2026-11-10T10:00:00.000Z',
  };
  const timeline = {
    ...emptyTimeline(),
    entries: { available: true, count: 1, truncated: false, items: [note] },
  };
  const { mount } = await open(fakeClient({ timeline }));
  const chip = mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'note');
  assert.ok(chip, 'the note filter chip exists');
  chip.dispatch('click');
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Richiamare lunedì'), 'the note shows under its filter');
  assert.ok(!text.includes('qui sotto'), 'the note view never says «qui sotto»');
});

test('06457e5c9717: contatore vicino al limite, errore via quando il testo torna valido', async () => {
  const { mount } = await open(fakeClient());
  const field = noteField(mount);
  assert.ok(field, 'the note field exists');
  field.value = 'a'.repeat(950);
  field.dispatch('input');
  const count = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '').includes('bo-scheda-note-count'));
  assert.ok(count, 'the counter shows near the limit');
  assert.ok(count.textContent.includes('950/1000'), 'the counter names what is written and the limit');
  field.value = 'a'.repeat(1001);
  field.dispatch('input');
  byAction(mount, 'add-note').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes('La nota è troppo lunga: al massimo 1000 caratteri.'));
  field.value = 'a'.repeat(100);
  field.dispatch('input');
  await flush();
  assert.ok(!mount.textContent.includes('La nota è troppo lunga'), 'the error is gone when the text is valid again');
});

test('06457e5c9717: Modifica mette il cursore nel primo campo', async () => {
  const { mount } = await open(fakeClient());
  byAction(mount, 'edit-details').dispatch('click');
  const first = mount.findAll('input').find((node) => node.getAttribute('name') === 'firstName');
  assert.ok(first, 'the Dettagli form opens');
  assert.equal(first.__focused, true, 'the cursor is in the first field');
});

test('06457e5c9717: badge Offerta sempre nello stesso posto, «—» se lo stato è ignoto', async () => {
  const profile = {
    ...PROFILE,
    opportunities: {
      available: true, count: 1, countIsComplete: true, truncated: false,
      items: [{ id: 'o1', status: 'mystery', stage: 'mystery', name: 'Offerta ignota' }],
    },
  };
  const { mount } = await open(fakeClient({ profile }));
  const line = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'bo-scheda-offer');
  assert.ok(line, 'the offer line exists');
  const kids = line.childNodes.filter((node) => node.tagName === 'SPAN');
  assert.equal(kids[kids.length - 1].getAttribute('class'), 'bo-scheda-offer-state', 'the badge is the last thing on the line');
  assert.equal(kids[kids.length - 1].textContent, '—', 'an unknown state reads as a dash, never missing');
});

test('06457e5c9717: email vuota non legge «non disponibile», invita ad aggiungerla', async () => {
  const card = { ...CARD, email: null };
  const profile = {
    ...PROFILE,
    identity: {
      company: { id: 'co1', name: 'Palestra Esempio' },
      contact: { id: 'c1', firstName: 'Guido', lastName: 'Presti', companyId: 'co1' },
    },
  };
  const { mount } = await open(fakeClient({ card, profile }));
  assert.ok(!mount.textContent.includes('non disponibile'), 'no bare «non disponibile» on screen');
  const add = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Aggiungi Email');
  assert.ok(add, 'the empty email invites to add it');
  add.dispatch('click');
  const email = mount.findAll('input').find((node) => node.getAttribute('name') === 'email');
  assert.ok(email, 'the invite opens the Dettagli form');
  assert.equal(email.__focused, true, 'the cursor is in the email field');
});
