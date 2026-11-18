import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:fb35de38db49 (verifica 18/11, secondo ritorno: all'apertura la
 * lista mostra le note e poi, quando la storia degli stati arriva, le voci
 * già visibili spariscono spinte fuori dalla prima pagina da 20).
 *
 * Repro: 10 note di ottobre + 1 offerta di novembre con 19 cambi di stato
 * (30 voci in «Tutti»). Durante l'attesa della storia le 10 note sono in
 * pagina; quando la storia risponde, le note vecchie devono restare
 * raggiungibili senza che nessuna sparisca dalla vista.
 */

const note = (n) => ({
  entry: 'note',
  id: `n${n}`,
  body: `Nota di prova ${n}`,
  teamAuthorId: null,
  occurredAt: `2026-10-${String(n).padStart(2, '0')}T09:00:00.000Z`,
});

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
    available: true, count: 10, truncated: false,
    items: Array.from({ length: 10 }, (_, i) => note(i + 1)),
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

const moveRow = (n) => ({
  id: `a${n}`,
  action: 'opportunity.stage_changed',
  actorType: 'user',
  actorId: 'maria',
  createdAt: `2026-11-${String(n + 1).padStart(2, '0')}T10:00:00.000Z`,
  data: { from: 'contact', to: 'qualification' },
});

function fakeClient() {
  const audit = Array.from({ length: 19 }, (_, i) => moveRow(i + 1));
  let releaseAudit = null;
  const auditGate = new Promise((resolve) => { releaseAudit = resolve; });
  return {
    releaseAudit: () => releaseAudit(),
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') return { ok: true };
      if (path.startsWith('/api/audit')) {
        await auditGate;
        return { items: audit };
      }
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      if (path === '/api/spine/context') return { actor: { id: 'maria' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const timelineList = (mount) => mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-timeline');
const timelineRows = (mount) => timelineList(mount).findAll('div')
  .filter((node) => typeof node.getAttribute('data-entry') === 'string' && node.getAttribute('data-entry') !== '');

test('fb35de38db49: la storia in arrivo allarga la pagina, nessuna nota sparisce', async () => {
  const client = fakeClient();
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti',
    toast: () => {},
  });
  const rendered = view.renderCard('contact', 'c1');
  await flush();
  const during = timelineList(mount);
  assert.ok(during.textContent.includes('Nota di prova 1'), 'la nota più vecchia è in pagina prima che la storia arrivi');
  assert.ok(during.textContent.includes('Nota di prova 10'), 'la nota più nuova è in pagina prima che la storia arrivi');
  client.releaseAudit();
  await rendered;
  await flush(20);
  const after = timelineList(mount);
  assert.ok(after.textContent.includes('Nota di prova 1'), 'la nota più vecchia resta in pagina dopo che la storia arriva');
  assert.ok(after.textContent.includes('Nota di prova 10'), 'la nota più nuova resta in pagina dopo che la storia arriva');
  assert.ok(after.textContent.includes('Cambio di stato'), 'i cambi di stato arrivano insieme alle note');
});

const bnote = (n) => ({
  entry: 'note',
  id: `b${n}`,
  body: `Nota B ${n}`,
  teamAuthorId: null,
  occurredAt: `2026-10-${String((n % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
});

/**
 * Review #1027 (P2): la storia del cliente A che risponde dopo il passaggio
 * al cliente B non deve allargare la pagina di B.
 */
test('fb35de38db49: la storia di una scheda staccata non allarga la pagina corrente', async () => {
  const audit = Array.from({ length: 19 }, (_, i) => moveRow(i + 1));
  let releaseAudit = null;
  const auditGate = new Promise((resolve) => { releaseAudit = resolve; });
  const cardFor = (id, name) => ({ ...CARD, subject: { resource: 'contact', id }, name });
  const profileFor = (id) => (id === 'c1' ? PROFILE : {
    ...PROFILE,
    subject: { resource: 'contact', id },
    opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  });
  const timelineFor = (id) => (id === 'c1' ? TIMELINE : {
    ...TIMELINE,
    subject: { resource: 'contact', id },
    entries: {
      available: true, count: 50, truncated: false,
      items: Array.from({ length: 50 }, (_, i) => bnote(i + 1)),
    },
  });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (String(options?.method ?? 'GET').toUpperCase() !== 'GET') return { ok: true };
      if (path.startsWith('/api/audit')) {
        await auditGate;
        return { items: audit };
      }
      if (path.startsWith('/api/customer-hub/card/')) {
        const id = path.endsWith('/c2') ? 'c2' : 'c1';
        return cardFor(id, id === 'c2' ? 'Rosa Blu' : CARD.name);
      }
      if (path.startsWith('/api/customer-hub/timeline/')) {
        return timelineFor(path.endsWith('/c2') ? 'c2' : 'c1');
      }
      if (path.startsWith('/api/customer-data/profile/')) {
        return profileFor(path.endsWith('/c2') ? 'c2' : 'c1');
      }
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      if (path === '/api/spine/context') return { actor: { id: 'maria' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti',
    toast: () => {},
  });
  await view.renderCard('contact', 'c1');
  await flush();
  await view.renderCard('contact', 'c2');
  await flush();
  assert.equal(timelineRows(mount).length, 20, 'B mostra la prima pagina da 20');
  assert.ok(timelineList(mount).textContent.includes('Mostra precedenti'), 'B offre le precedenti');
  releaseAudit();
  await flush(20);
  await view.renderCard('contact', 'c2');
  await flush();
  assert.equal(timelineRows(mount).length, 20, 'la storia di A non allarga la pagina di B');
  assert.ok(timelineList(mount).textContent.includes('Mostra precedenti'), 'B offre ancora le precedenti');
});
