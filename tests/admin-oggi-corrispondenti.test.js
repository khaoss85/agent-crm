import test from 'node:test';
import assert from 'node:assert/strict';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import { awaitingReplyFor } from '../packages/customer-data/src/customers.js';
import {
  reviveCorrespondents,
  serializeCorrespondents,
  teamCorrespondents,
  teamWroteTo,
} from '../packages/core/src/sender-kind.js';
import { buildInbox, buildServerReplies } from '../apps/admin/public/admin-oggi.js';

/**
 * Seguito P2 della review Muse giro 4 di agent-crm#821 (testa 466b7ce5):
 * Oggi contava i corrispondenti sui 100 messaggi che legge, la vista server
 * «Da rispondere» su tutta la scansione. Per un mittente a cui il team ha
 * scritto mesi fa (fuori dai 100) le due schermate dicevano cose diverse:
 * Clienti lo contava in attesa, Oggi lo archiviava tra le notifiche.
 * La cura: la risposta server porta la stessa base («mai scritto») e
 * l'inbox locale la riusa quando c'è.
 */

const SENDER = 'news@palestra-amica.it';
const INBOUND = {
  id: 'm-new', channel: 'email', direction: 'inbound', remoteHandle: SENDER,
  subjectResource: 'contact', subjectId: 'c1', conversationId: 'mail:news1',
  occurredAt: '2026-11-13T09:00:00.000Z',
  body: 'New October classes are out. Unsubscribe from this list',
};
const OLD_OUTBOUND = {
  id: 'm-old', channel: 'email', direction: 'outbound', remoteHandle: SENDER,
  subjectResource: 'contact', subjectId: 'c1', conversationId: 'mail:news1',
  occurredAt: '2026-03-02T09:00:00.000Z', body: 'Ciao, ti mandiamo gli orari',
};
const CONVERSATIONS = [{ id: 'mail:news1', subjectLabel: 'Palestra Amica' }];
// La pagina di Oggi: solo gli ultimi messaggi, senza l'outbound di mesi fa.
const PAGE = [INBOUND];

test('095fb37de6bb: la stessa base decide su entrambe le schermate — un mittente a cui si è scritto oltre i 100 letti resta in attesa', () => {
  // La vista server vede tutta la scansione: il team gli ha scritto, resta una persona in attesa.
  const server = awaitingReplyFor([OLD_OUTBOUND, INBOUND], CONVERSATIONS);
  assert.equal(server.count, 1, 'il server conta il mittente già contattato come in attesa');
  // L’inbox sui soli messaggi della pagina non lo sa: lo archivia tra le notifiche.
  const local = buildInbox({ messages: PAGE, conversations: CONVERSATIONS });
  assert.equal(local.total, 0, 'repro: senza la base del server la pagina perde l’attesa');
  assert.equal(local.notifications.total, 1, 'repro: e la archivia tra le notifiche');
  // Con la base del server la stessa pagina decide come il server.
  const shared = reviveCorrespondents(serializeCorrespondents(teamCorrespondents([OLD_OUTBOUND, INBOUND])));
  const unified = buildInbox({ messages: PAGE, conversations: CONVERSATIONS, correspondents: shared });
  assert.equal(unified.total, 1, 'con la base del server la pagina conta lo stesso in attesa');
  assert.equal(unified.notifications.total, 0, 'e non lo archivia tra le notifiche');
});

test('095fb37de6bb: la base attraversa il confine server/browser senza cambiare idea', () => {
  const wire = serializeCorrespondents(teamCorrespondents([OLD_OUTBOUND, INBOUND]));
  assert.ok(Array.isArray(wire.addresses) && wire.addresses.includes(SENDER), 'l’indirizzo viaggia nella risposta');
  const back = reviveCorrespondents(JSON.parse(JSON.stringify(wire)));
  assert.equal(teamWroteTo(back, INBOUND), true, 'dopo il giro resta un mittente già contattato');
  assert.equal(teamWroteTo(back, { ...INBOUND, remoteHandle: 'sconosciuto@example.it', conversationId: 'mail:xxx' }), false,
    'un mittente mai contattato resta mai contattato');
  assert.equal(teamWroteTo(reviveCorrespondents(null), INBOUND), false, 'senza base nessun falso “già scritto”');
});

function fakeModules({ contacts, companies, messages }) {
  const match = (rows, filters) => rows.filter((row) => Object.entries(filters).every(([key, value]) => (
    Array.isArray(value) ? value.includes(row?.[key]) : row?.[key] === value)));
  const exact = (rows) => ({ listWhere: async (filters) => match(rows, filters) });
  return {
    get: (name) => {
      const map = {
        contact: { service: { list: async () => contacts } },
        company: { service: { list: async () => companies } },
        'external-identity': { service: exact([]) },
        'interaction-message': { service: exact(messages) },
        'interaction-call': { service: exact([]) },
      };
      const entry = map[name];
      if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      return entry;
    },
  };
}

test('095fb37de6bb: la risposta «da-rispondere» porta la base e Oggi la riusa per le notifiche', async () => {
  const row = (over) => ({
    id: `m-${Math.random().toString(36).slice(2)}`, channel: 'email', direction: 'inbound',
    subjectResource: 'contact', subjectId: 'c1', ...over,
  });
  const messages = [
    row({ ...OLD_OUTBOUND, subjectId: 'c1' }),
    row({ ...INBOUND, subjectId: 'c1' }),
  ];
  const base = {
    modules: fakeModules({
      contacts: [{ id: 'c1', companyId: 'co1', firstName: 'Palestra', lastName: 'Amica', email: SENDER }],
      companies: [{ id: 'co1', name: 'Palestra Amica' }],
      messages,
    }),
    core: {},
    names: { identity: 'external-identity' },
  };
  const page = await listCustomerRecords(base, { vista: 'da-rispondere' });
  assert.equal(page.total, 1, 'il server conta il mittente già contattato come in attesa');
  assert.ok(Array.isArray(page.teamCorrespondents?.addresses), 'la risposta porta la base «mai scritto»');
  assert.ok(page.teamCorrespondents.addresses.includes(SENDER), 'la base nomina il mittente contattato mesi fa');
  const server = buildServerReplies(page);
  assert.ok(server && server.correspondents, 'Oggi legge la base dalla risposta');
  // La pagina di Oggi non ha l’outbound di marzo: da sola sbaglierebbe, con la base no.
  const unified = buildInbox({
    messages: messages.filter((m) => m.direction === 'inbound'),
    conversations: [{ id: 'mail:news1' }],
    correspondents: server.correspondents,
  });
  assert.equal(unified.total, 1, 'Oggi conta lo stesso in attesa');
  assert.equal(unified.notifications.total, 0, 'e non lo sposta tra le notifiche');
});
