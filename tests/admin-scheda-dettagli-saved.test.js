import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce 26afd13657c5, ritorno 1 (verifier 17/11, supervisore 17/11 dal Mac):
 * dopo «Salva» in Modifica la conferma «Dati salvati» arrivava solo come
 * toast in basso a destra, lontano dalla card salvata. La conferma deve
 * vivere nei Dettagli, dove sta l'occhio — il form si chiude lì.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: true, value: '+39 333 1234567', system: 'whatsapp', reason: null },
  email: 'guido@palestra-esempio.it',
  socials: [{ system: 'instagram', handle: 'guido.presti' }],
  status: { value: 'contatto', reason: 'no signed business in the composed packages' },
  activePackage: { available: false, reason: 'not composed', active: null, items: null },
  notes: { available: false, items: null, reason: 'this application composes no notes record' },
  history: { available: false, items: [], count: 0, truncated: false, completeTimeline: false, reason: 'no history' },
  headline: {
    city: { available: false, value: null, reason: 'no city on record' },
    origin: { available: true, system: 'whatsapp', firstObservedAt: '2026-10-19T10:00:00.000Z', reason: null },
    assignee: { available: false, value: null, reason: 'no referente on record' },
  },
};

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
  entries: { available: true, count: 0, truncated: false, items: [] },
};

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false },
  identity: { company: { id: 'co1', name: 'Palestra Esempio' }, contact: { id: 'c1', email: 'guido@palestra-esempio.it' } },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
  quotes: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
  orders: { available: false, reason: 'not composed', items: null, count: null },
  contracts: { available: false, reason: 'not composed', items: null, count: null },
  subscriptions: { available: false, reason: 'not composed', items: null, count: null },
  deliveryProjects: { available: false, reason: 'not composed', items: null, count: null },
  serviceCoverages: { available: false, reason: 'not composed', items: null, count: null },
  supportCases: { available: false, reason: 'not composed', items: null, count: null },
  workTasks: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
  successions: { available: false, reason: 'not composed', items: null, count: null },
  dataQualityIssues: [],
  duplicateCandidates: [],
  completeTimeline: false,
  timelineNote: 'This profile spans Accordo-managed records only.',
  limitations: [],
};

const ENRICHED = {
  customerEnrichmentContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  linked: false,
  optedOut: null,
  items: [],
};

function stubClient() {
  const writes = [];
  return {
    writes,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') {
        writes.push({ path, method: options.method });
        return { ok: true };
      }
      if (path.startsWith('/api/customer-hub/')) return path.includes('/card/') ? CARD : TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path.startsWith('/api/customer-data/enriched/')) return ENRICHED;
      if (path === '/api/customer-data/fields') return { definitions: [] };
      if (path.startsWith('/api/customer-data/fields/values')) return { values: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/appointments/services') throw Object.assign(new Error('Not Found'), { status: 404 });
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      if (path.startsWith('/api/call-intelligence/calls/')) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (path === '/api/schema') throw Object.assign(new Error('Not Found'), { status: 404 });
      throw new Error(`unexpected request ${path}`);
    },
  };
}

const flushClicks = async (times = 5) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const byAction = (mount, action) =>
  mount.findAll('button').find((node) => node.getAttribute('data-action') === action);

const savedNote = (mount) =>
  mount.findAll('p').find((node) => node.getAttribute('role') === 'status'
    && String(node.textContent ?? '').includes('Dati salvati'));

test('26afd13657c5: dopo Salva in Modifica la conferma vive nei Dettagli, non solo nel toast', async () => {
  const seen = [];
  const client = stubClient();
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  assert.equal(savedNote(mount), undefined, 'nessuna conferma prima del salvataggio');
  byAction(mount, 'edit-details').dispatch('click');
  const save = byAction(mount, 'save-details');
  assert.ok(save, 'Salva is in the form');
  save.dispatch('click');
  await flushClicks();

  assert.equal(byAction(mount, 'save-details'), undefined, 'the form closed after the save');
  assert.ok(seen.some((toast) => toast.message === 'Dati salvati' && toast.error === false),
    'the save still toasts in Italian');
  const note = savedNote(mount);
  assert.ok(note, 'the Dettagli show «Dati salvati» where the form was');
  assert.ok(mount.textContent.includes('Dettagli'), 'the re-read card shows Dettagli again');
});

test('26afd13657c5: riaprire Modifica toglie la conferma del salvataggio', async () => {
  const client = stubClient();
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, toast: () => {} }).renderCard('contact', 'c1');

  byAction(mount, 'edit-details').dispatch('click');
  byAction(mount, 'save-details').dispatch('click');
  await flushClicks();
  assert.ok(savedNote(mount), 'the save shows its confirmation in Dettagli');

  byAction(mount, 'edit-details').dispatch('click');
  await flushClicks(2);
  assert.equal(savedNote(mount), undefined, 'no stale confirmation inside the open form');
});
