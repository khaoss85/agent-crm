import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:fb35de38db49 (prova del Mac 17/11, scheda cliente): «Mostra
 * precedenti» funziona, ma a ogni cambio di stato la cronologia scende per
 * circa 0,2 s a 8 voci e la pagina salta da 1800 a 759 px. Il ridisegno
 * deve tenere le voci già mostrate finché la rilettura non risponde.
 *
 * Repro del NON PASSA: dopo «Cambia stato», mentre la rilettura di card e
 * profilo è ancora in volo, la cronologia perde le righe di offerta e cambi
 * di stato e mostra «Carico offerte e cambi di stato…» al loro posto.
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
  entries: {
    available: true, count: 1, truncated: false,
    items: [{
      entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
      sync: 'received', body: 'Ciao, vorrei prenotare una prova', teamAuthorId: null,
      remoteHandle: '+393331234567', errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
    }],
  },
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

const moveRow = (id, from, to, at) => ({
  id, action: 'opportunity.stage_changed', actorType: 'user', actorId: 'maria',
  createdAt: at, data: { from, to },
});

/**
 * Serves the scheda; after the first full read, `hold()` makes every read
 * wait until `release()`, so a test sees the screen between the write and
 * the re-read.
 */
function fakeClient() {
  const state = {
    card: CARD,
    timeline: TIMELINE,
    profile: PROFILE,
    audit: [moveRow('a1', 'contact', 'qualification', '2026-11-02T10:00:00.000Z')],
  };
  const reads = [];
  const writes = [];
  let gate = null;
  let open = () => {};
  let failAudit = false;
  return {
    state,
    reads,
    writes,
    hold() { gate = new Promise((resolve) => { open = resolve; }); },
    release() { open(); gate = null; },
    failAuditOnce() { failAudit = true; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        writes.push({ path, method });
        const body = options.body ? JSON.parse(String(options.body)) : null;
        if (path === '/api/opportunities/o1/stage') {
          state.profile = {
            ...state.profile,
            opportunities: {
              ...state.profile.opportunities,
              items: [{ ...state.profile.opportunities.items[0], stage: 'proposal', status: 'proposal' }],
            },
          };
          state.audit = [...state.audit, moveRow('a2', 'qualification', 'proposal', '2026-11-17T09:00:00.000Z')];
          return { runId: 'r1', status: 'completed', output: { outcome: 'moved' } };
        }
        return { ok: true };
      }
      reads.push(path);
      if (gate !== null) await gate;
      if (path.startsWith('/api/customer-hub/card/')) return state.card;
      if (path.startsWith('/api/customer-hub/timeline/')) return state.timeline;
      if (path.startsWith('/api/customer-data/profile/')) return state.profile;
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) {
        if (failAudit) throw Object.assign(new Error('down'), { status: 503 });
        return { items: state.audit };
      }
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(client) {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti',
    toast: (text) => { toasts.push(text); },
  });
  await view.renderCard('contact', 'c1');
  await flush();
  client.reads.length = 0;
  return { mount, view, toasts };
}

const timelineList = (mount) => mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-timeline');
const byAction = (mount, action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);

test('fb35de38db49: «Cambia stato» tiene le voci della cronologia finché la rilettura non risponde', async () => {
  const client = fakeClient();
  const { mount, toasts } = await open(client);
  const before = timelineList(mount);
  const rowsBefore = before.findAll('div').length;
  assert.ok(rowsBefore >= 3, `la cronologia mostra messaggi, offerta e cambi di stato (trovate ${rowsBefore} righe)`);
  assert.ok(before.textContent.includes('Cambio di stato'), 'il cambio di stato letto è in pagina');
  assert.ok(before.textContent.includes('Offerta creata'), 'la creazione dell’offerta è in pagina');

  byAction(mount, 'change-offer-stage').listeners.click[0]();
  const voice = mount.findAll('button').find((node) => (node.getAttribute('role') === 'menuitem') && /propost/i.test(node.textContent));
  assert.ok(voice, 'il menu offre lo stato proposta');
  client.hold();
  const moving = voice.listeners.click[0]();
  await flush();
  assert.deepEqual(toasts, ['Stato aggiornato']);

  // La rilettura di card e profilo è ancora in volo: la cronologia non deve
  // scendere e la pagina non deve saltare.
  const during = timelineList(mount);
  assert.equal(during.findAll('div').length, rowsBefore, 'stesse righe prima e durante la rilettura');
  assert.ok(during.textContent.includes('Cambio di stato'), 'i cambi di stato restano in pagina');
  assert.ok(during.textContent.includes('Offerta creata'), 'la creazione dell’offerta resta in pagina');
  assert.ok(!during.textContent.includes('Carico offerte e cambi di stato'), 'nessuno scheletro al posto delle voci');
  const history = mount.findAll('p')
    .filter((node) => ['bo-scheda-offer-history', 'bo-muted'].includes(node.getAttribute('class') ?? ''))
    .map((node) => node.textContent);
  assert.ok(history.some((text) => text.includes('· da maria')), '«Storia stati» tiene la mossa già letta');
  assert.ok(!history.includes('Caricamento…'), '«Storia stati» non torna a «Caricamento…»');
  assert.equal(client.reads.filter((path) => path.startsWith('/api/audit')).length, 1, 'la storia è riletta una volta sola');

  client.release();
  await moving;
  await flush();
  const after = timelineList(mount);
  assert.equal(after.textContent.split('Cambio di stato').length - 1, 2, 'dopo la risposta la mossa nuova si aggiunge');
  assert.ok(!after.textContent.includes('Carico offerte e cambi di stato'), 'lo scheletro non resta');
});

test('fb35de38db49: una rilettura della storia fallita tiene le voci già mostrate', async () => {
  const client = fakeClient();
  const { mount } = await open(client);
  const rowsBefore = timelineList(mount).findAll('div').length;

  byAction(mount, 'change-offer-stage').listeners.click[0]();
  const voice = mount.findAll('button').find((node) => (node.getAttribute('role') === 'menuitem') && /propost/i.test(node.textContent));
  client.hold();
  const moving = voice.listeners.click[0]();
  await flush();
  client.failAuditOnce();
  client.release();
  await moving;
  await flush();

  const after = timelineList(mount);
  assert.equal(after.findAll('div').length, rowsBefore, 'le righe restano anche se la storia non si rilegge');
  assert.ok(after.textContent.includes('Cambio di stato'), 'i cambi di stato già letti restano in pagina');
  assert.ok(!after.textContent.includes('Cambi di stato non leggibili'), 'nessuna riga d’errore al posto delle voci');
});
