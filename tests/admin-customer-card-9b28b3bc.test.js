import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:9b28b3bc6003 (prova del Mac 17/11, scheda cliente): lo scheletro
 * «OFFERTA» compare anche su chi non ha offerte; «WhatsApp» compare su un
 * cliente che ha l'email ma non il telefono (e viceversa).
 *
 * Repro del NON PASSA: a profilo letto e senza offerte, mentre resta in volo
 * la sola lettura dello schema, la card mostra lo scheletro «Offerta»;
 * con solo l'email, le azioni rapide mostrano anche «WhatsApp».
 */

const baseCard = (over = {}) => ({
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: false, value: null, system: null, reason: 'no phone' },
  email: '',
  socials: [],
  status: { value: 'contatto', reason: 'x' },
  ...over,
});

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: 0, truncated: false, items: [] },
  appointments: { available: true, count: 0, truncated: false, items: [] },
};

const noOfferProfile = () => ({
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: {
    company: { id: 'co1', name: 'Palestra Esempio' },
    contact: { id: 'c1', firstName: 'Guido', lastName: 'Presti', email: '', companyId: 'co1' },
  },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
});

const ENRICHED = {
  customerEnrichmentContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  linked: false,
  optedOut: null,
  items: [],
};

function fakeClient({ card, onSchema = null, companyProfile = null } = {}) {
  const profile = noOfferProfile();
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return { ok: true };
      if (path.startsWith('/api/customer-hub/card/')) return card;
      if (path.startsWith('/api/customer-hub/timeline/')) return TIMELINE;
      if (path.startsWith('/api/customer-data/profile/company/')) {
        if (companyProfile) return companyProfile;
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      if (path.startsWith('/api/customer-data/profile/')) return profile;
      if (path === '/api/schema') {
        if (onSchema) return onSchema();
        return { pipelines: [] };
      }
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(client) {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({ doc, mount, client, spaceId: 'presti' });
  await view.renderCard('contact', 'c1');
  await flush();
  return mount;
}

const byAction = (mount, action) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === action) ?? null;
const offerCards = (mount) => mount.findAll('section')
  .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-card-offer'));

test('9b28b3bc6003: con la sola email, le azioni rapide mostrano Email ma non WhatsApp', async () => {
  const mount = await open(fakeClient({
    card: baseCard({ email: 'guido@palestra-esempio.it' }),
  }));
  assert.ok(byAction(mount, 'call-customer'), '«Chiama» resta sempre (Dan 11/11)');
  assert.ok(byAction(mount, 'compose-email'), 'Email: il cliente ha un indirizzo');
  assert.equal(byAction(mount, 'compose-whatsapp'), null, 'WhatsApp: il cliente non ha telefono');
});

test('9b28b3bc6003: con il solo telefono, le azioni rapide mostrano WhatsApp ma non Email', async () => {
  const mount = await open(fakeClient({
    card: baseCard({
      phone: { available: true, value: '+393331234567', system: 'phone', reason: null },
    }),
  }));
  assert.ok(byAction(mount, 'call-customer'), '«Chiama» resta sempre (Dan 11/11)');
  assert.ok(byAction(mount, 'compose-whatsapp'), 'WhatsApp: il cliente ha un telefono');
  assert.equal(byAction(mount, 'compose-email'), null, 'Email: il cliente non ha indirizzo');
});

test('9b28b3bc6003: senza canali, le azioni dicono che non ce ne sono', async () => {
  const mount = await open(fakeClient({ card: baseCard() }));
  assert.ok(byAction(mount, 'call-customer'), '«Chiama» resta sempre (Dan 11/11)');
  assert.equal(byAction(mount, 'compose-whatsapp'), null, 'niente WhatsApp senza telefono');
  assert.equal(byAction(mount, 'compose-email'), null, 'niente Email senza indirizzo');
  assert.ok(
    mount.textContent.includes('Nessun canale scrivibile'),
    'una riga onesta al posto dei canali',
  );
});

test('9b28b3bc6003: senza offerte, niente scheletro Offerta mentre si aspetta solo lo schema', async () => {
  // Voce 4ec1fe6d (supervisore 17/11): il contatto c1 non ha offerte proprie
  // ma ha l'azienda collegata (co1), così il riquadro Offerta resta — non uno
  // scheletro, il contenuto finale con il link alla scheda azienda — invece
  // di sparire. Resta vero il contratto di questa voce: a profilo noto e
  // schema in volo nessuno scheletro fantasma.
  let releaseSchema;
  const schemaGate = new Promise((resolve) => { releaseSchema = resolve; });
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc,
    mount,
    client: fakeClient({
      card: baseCard(),
      onSchema: () => schemaGate,
      companyProfile: {
        customerProfileContract: 1,
        subject: { resource: 'company', id: 'co1' },
        opportunities: {
          available: true, count: 1, countIsComplete: true, truncated: false,
          items: [{ id: 'o1', status: 'proposal', stage: 'proposal', name: 'Pacchetto sede' }],
        },
        quotes: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
      },
    }),
    spaceId: 'presti',
  });
  const opening = view.renderCard('contact', 'c1');
  await flush(20);
  assert.equal(offerCards(mount).length, 1, 'il profilo è letto: un riquadro Offerta con il link azienda');
  assert.notEqual(
    offerCards(mount)[0].getAttribute('data-loading'), 'true',
    'a profilo noto niente scheletro, il contenuto finale anche con lo schema in volo',
  );
  assert.ok(
    offerCards(mount)[0].textContent.includes('Palestra Esempio'),
    'il riquadro nomina l’azienda collegata',
  );
  releaseSchema({ pipelines: [] });
  await opening;
  await flush();
  assert.equal(offerCards(mount).length, 1, 'a lettura finita resta il link alle offerte azienda');
  const link = offerCards(mount)[0].findAll('a')[0] ?? null;
  assert.equal(link?.getAttribute('href'), '#/customer-card/company/co1', 'il link apre la scheda azienda');
});
