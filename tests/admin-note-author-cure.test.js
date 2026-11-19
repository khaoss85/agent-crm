import test from 'node:test';
import assert from 'node:assert/strict';
import { authorName, auditActorLabel, offerCreatorLabel } from '../apps/admin/public/admin-labels.js';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:3f3c143b (seguito, prova del Mac sul live b4784e9 17/11 18:50Z):
 * #999 unita ma le firme restano «daniele pelleri (2)» anche su una nota
 * nuova — le note leggono `person.label` (etichetta numerata del Team)
 * invece della parola d'autore senza suffisso che cronologia e «Creata da»
 * leggono da #988 (backlog:54a83e2fd0d2). Stessa funzione di risoluzione
 * della persona (famiglia backlog:91f4e2f0d650): due righe distinte restano
 * due autori distinti, mai fusi, mai numerati nelle firme.
 */

const FIRST = 'google|601';
const SECOND = 'github|602';
// Due account distinti, stesso nome a meno delle maiuscole (chiavi e caselle
// diverse: mai fusi, agent-crm#644/#742).
const ROSTER = {
  items: [
    { subject: FIRST, displayName: 'Daniele Pelleri', email: 'dan@example.com', operatorAccountId: 'op-1' },
    { subject: SECOND, displayName: 'daniele pelleri', email: 'dan.code@example.com', operatorAccountId: 'op-2' },
  ],
};

const CARD = {
  customerCardContract: 1, subject: { resource: 'contact', id: 'c1' }, name: 'Cliente Prova',
  company: { id: 'co1', name: 'Azienda Esempio' }, phone: { available: false, value: null },
  email: 'cliente@esempio.invalid', socials: [], status: { value: 'contatto' },
};
const PROFILE = {
  customerProfileContract: 1, subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: { company: { id: 'co1', name: 'Azienda Esempio' }, contact: { id: 'c1', firstName: 'Cliente', lastName: 'Prova', email: 'cliente@esempio.invalid', companyId: 'co1' } },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};
const NOTE = {
  entry: 'note', id: 'n1', body: 'Nota nuova di daniele pelleri', teamAuthorId: SECOND,
  occurredAt: '2026-11-18T09:00:00.000Z',
};

function client({ items = [NOTE], roster = ROSTER } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) {
        return {
          customerTimelineContract: 1, subject: { resource: 'contact', id: 'c1' },
          conversations: { available: true, count: 0, truncated: false, items: [] },
          entries: { available: true, count: items.length, truncated: false, items },
          appointments: { available: true, count: 0, truncated: false, items: [] },
        };
      }
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path === '/api/spine/memberships') return roster;
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/schema') return { pipelines: [] };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const timelineText = (mount) => mount.findAll('section')
  .find((node) => String(node.getAttribute('class')).includes('bo-scheda-card-timeline'))?.textContent ?? '';

test('3f3c143b firma: a new note by the second of two same-name accounts reads its profile name, never «(2)»', async () => {
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client: client(), spaceId: 'spazio-prova', toast: () => {} });
  void view.renderCard('contact', 'c1');
  await flush();
  const text = timelineText(mount);
  assert.ok(text.includes('Nota nuova di daniele pelleri'), `the note is on screen: ${text}`);
  assert.ok(text.includes('da daniele pelleri'), `the note names its writer: ${text}`);
  assert.ok(!text.includes('(2)'), `no Team ordinal in the signature: ${text}`);
  assert.ok(!text.includes('dal team'), text);
  assert.ok(!text.includes('da utente'), text);
});

test('3f3c143b firma: the author word is the row profile name for each distinct row', () => {
  const rows = [
    { subjects: [FIRST], members: [], keys: ['op-1'], name: 'Daniele Pelleri', email: 'dan@example.com' },
    { subjects: [SECOND], members: [], keys: ['op-2'], name: 'daniele pelleri', email: 'dan.code@example.com' },
  ];
  assert.equal(authorName(rows[0]), 'Daniele Pelleri');
  assert.equal(authorName(rows[1]), 'daniele pelleri');
});

test('3f3c143b firma: new history lines name the recorded author without ordinal, unknown stays honest', () => {
  const roster = ROSTER.items;
  assert.equal(auditActorLabel({ actorId: SECOND, actorType: 'user' }, [], roster), 'daniele pelleri');
  assert.equal(auditActorLabel({ actorId: FIRST, actorType: 'user' }, [], roster), 'Daniele Pelleri');
  const offer = { id: 'o1', name: 'Prova', owner: SECOND, contactName: 'Cliente Prova', companyName: 'Azienda Esempio' };
  const created = { action: 'opportunity.created', actorType: 'user', actorId: SECOND };
  assert.equal(offerCreatorLabel([created], offer, roster), 'daniele pelleri');
  // Un autore mai registrato resta una forma onesta, mai «utente»/«dal team».
  assert.equal(auditActorLabel({ actorId: 'admin-ui', actorType: 'user' }, [], roster), '—');
});
