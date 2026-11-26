import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import { CUSTOMER_SCAN_LIMIT } from '../packages/customer-data/src/customers.js';

/**
 * backlog:4eec2e48 (B2, 25/11): due contatti di prova archiviati
 * dall'interfaccia («Prova Mac Offerta 25-11» senza messaggi e «Prova Mac
 * Approvazione 25-11» con messaggi). La linguetta leggeva «Archiviati 0»
 * anche dopo entrambi: la scansione escludeva gli archiviati fuori dalla
 * loro vista e le linguette si contano sulle righe della scansione.
 *
 * Cosa prova, dal vivo:
 * - la linguetta Archiviati conta tutti gli archiviati dello spazio;
 * - la vista Archiviati li elenca tutti, compreso uno senza messaggi;
 * - gli archiviati restano fuori dalle altre viste e pagine.
 */

const ACTOR = { type: 'user', id: 'titolare' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'B2 Test' });
  const active = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@b2-esempio.it',
  });
  const noMessages = await app.services.contacts.create({
    companyId: company.id, firstName: 'Prova Mac', lastName: 'Offerta 25-11',
    email: 'offerta-25-11@b2-esempio.it',
  });
  const withMessages = await app.services.contacts.create({
    companyId: company.id, firstName: 'Prova Mac', lastName: 'Approvazione 25-11',
    email: 'approvazione-25-11@b2-esempio.it',
  });
  await app.services.contacts.archive(noMessages.id, { actor: ACTOR });
  await app.services.contacts.archive(withMessages.id, { actor: ACTOR });
  const match = (rows, filters) => rows.filter((row) => Object.entries(filters)
    .every(([key, value]) => (Array.isArray(value) ? value.includes(row?.[key]) : row?.[key] === value)));
  const exact = (rows) => ({ listWhere: async (filters) => match(rows, filters) });
  const modules = {
    get: (name) => {
      if (name === 'contact') return { service: app.services.contacts };
      if (name === 'company') return { service: app.services.companies };
      if (name === 'interaction-message') {
        return {
          service: exact([{
            id: 'm-approvazione', channel: 'whatsapp', direction: 'inbound', body: 'Approvo',
            subjectResource: 'contact', subjectId: withMessages.id,
            conversationId: 'wa:1', occurredAt: '2026-11-25T19:40:00.000Z',
          }]),
        };
      }
      if (name === 'interaction-call') return { service: exact([]) };
      throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
    },
  };
  return { base: { modules, core: {}, names: {} }, active, noMessages, withMessages };
}

const pill = (page, id) => page.views.find((view) => view.id === id)?.count ?? null;

test('4eec2e48: la linguetta Archiviati conta tutti gli archiviati dello spazio', async (t) => {
  const { base } = await scene(t);
  const page = await listCustomerRecords(base, {});
  assert.equal(pill(page, 'archiviati'), 2, 'Archiviati counts both archived contacts');
  assert.equal(pill(page, 'tutti'), 1, 'Tutti still counts only the active contact');
  assert.ok(page.items.every((item) => item.archivedAt === null), 'no archived row leaks into Tutti');
});

test('4eec2e48: la vista Archiviati li elenca tutti, compreso uno senza messaggi', async (t) => {
  const { base, noMessages, withMessages } = await scene(t);
  const page = await listCustomerRecords(base, { vista: 'archiviati' });
  assert.equal(page.total, 2, 'both archived contacts are listed');
  const ids = page.items.map((item) => item.id);
  assert.ok(ids.includes(noMessages.id), 'the archived contact without messages is listed');
  assert.ok(ids.includes(withMessages.id), 'the archived contact with messages is listed');
  assert.equal(pill(page, 'archiviati'), 2, 'the pill agrees with the page');
});

test('4eec2e48: la ricerca nella vista Archiviati trova anche quello senza messaggi', async (t) => {
  const { base, noMessages } = await scene(t);
  const page = await listCustomerRecords(base, { vista: 'archiviati', q: 'offerta' });
  assert.ok(page.items.some((item) => item.id === noMessages.id),
    'the messageless archived contact matches by name');
});

/**
 * backlog:4eec2e48 (review #1161 P1+P3): la completezza è per partizione.
 * Tre stub sopra la stessa scena reale — la lista di default esclude gli
 * archiviati, come faceva main per le letture non archiviate:
 * - 500 archiviati e pochi attivi: Tutti resta esatta (fallisce sulla testa
 *   9cdde55, dove il flag globale AND avvelenava anche questa vista);
 * - 500 attivi e due archiviati: la vista Archiviati resta esatta e conta 2;
 * - lettura dei soli archiviati in errore: Tutti resta 200 ed esatta, senza
 *   linguetta Archiviati; la vista Archiviati rifiuta con un codice.
 */

const fakeContact = (kind, i) => ({
  id: `${kind}-stub-${i}`,
  companyId: null,
  firstName: kind === 'archiviato' ? 'Archiviato' : 'Attivo',
  lastName: `Stub ${i}`,
  email: `${kind}-stub-${i}@b2-esempio.it`,
  archivedAt: kind === 'archiviato' ? '2026-11-25T15:59:10.000Z' : null,
});

const stubContactService = (service, {
  actives = null, archived = null, archivedError = null, activeError = null,
}) => ({
  list: async (opts = {}) => {
    if (opts?.archivedOnly === true) {
      if (archivedError !== null) throw archivedError;
      if (archived !== null) return archived;
      return service.list({ limit: CUSTOMER_SCAN_LIMIT, includeArchived: true, archivedOnly: true });
    }
    if (activeError !== null) throw activeError;
    if (actives !== null) return actives;
    return service.list({ limit: CUSTOMER_SCAN_LIMIT });
  },
});

const withContactService = (base, service) => ({
  ...base,
  modules: {
    get: (name) => (name === 'contact' ? { service } : base.modules.get(name)),
  },
});

const fullPartition = (kind) => Array.from({ length: CUSTOMER_SCAN_LIMIT }, (_, i) => fakeContact(kind, i));

test('4eec2e48: il tetto degli archiviati non sporca Tutti', async (t) => {
  const { base } = await scene(t);
  const stubbed = withContactService(base,
    stubContactService(base.modules.get('contact').service, { archived: fullPartition('archiviato') }));
  const page = await listCustomerRecords(stubbed, {});
  assert.equal(page.totalIsExact, true, 'Tutti stays exact when only the archived partition truncates');
  assert.equal(pill(page, 'tutti'), 1, 'Tutti still counts the one active contact');
  assert.equal(pill(page, 'archiviati'), null, 'no exact archived count past the ceiling');
});

test('4eec2e48: il tetto degli attivi non sporca la vista Archiviati', async (t) => {
  const { base } = await scene(t);
  const stubbed = withContactService(base,
    stubContactService(base.modules.get('contact').service, { actives: fullPartition('attivo') }));
  const page = await listCustomerRecords(stubbed, { vista: 'archiviati' });
  assert.equal(page.total, 2, 'both archived contacts are listed');
  assert.equal(pill(page, 'archiviati'), 2, 'the pill agrees with the page');
  assert.equal(page.totalIsExact, true, 'the archiviati view stays exact when only the active partition truncates');
});

/**
 * backlog:4eec2e48 (review #1161 P1 su c50be6af + P1 su 9cdde55cc, stessa
 * radice: l'unione delle partizioni trattata come una sola — tabella che
 * tiene ogni caso dei giri precedenti e di questo):
 * - un archiviato non nasconde la riga azienda-sola nelle viste attive
 *   (cade sulla testa c50be6af, dove seenCompanies si riempiva da ogni
 *   contatto dell'unione e il giro dell'azienda la saltava);
 * - un attivo coprente non crea doppioni (nessuna riga azienda-sola in più);
 * - una tombstone non nasconde la riga azienda-sola in nessuna vista;
 * - la vista Archiviati elenca comunque il contatto archiviato.
 */

async function companyScene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const onlyArchived = await app.services.companies.create({ name: 'Solo Archiviati Srl' });
  const archivedContact = await app.services.contacts.create({
    companyId: onlyArchived.id, firstName: 'Vecchio', lastName: 'Archiviato',
    email: 'vecchio-archiviato@b2-esempio.it',
  });
  await app.services.contacts.archive(archivedContact.id, { actor: ACTOR });
  const covered = await app.services.companies.create({ name: 'Attivi Spa' });
  const activeContact = await app.services.contacts.create({
    companyId: covered.id, firstName: 'Anna', lastName: 'Attiva',
    email: 'anna-attiva@b2-esempio.it',
  });
  const match = (rows, filters) => rows.filter((row) => Object.entries(filters)
    .every(([key, value]) => (Array.isArray(value) ? value.includes(row?.[key]) : row?.[key] === value)));
  const exact = (rows) => ({ listWhere: async (filters) => match(rows, filters) });
  const modules = {
    get: (name) => {
      if (name === 'contact') return { service: app.services.contacts };
      if (name === 'company') return { service: app.services.companies };
      if (name === 'interaction-message') return { service: exact([]) };
      if (name === 'interaction-call') return { service: exact([]) };
      throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
    },
  };
  return { base: { modules, core: {}, names: {} }, onlyArchived, archivedContact, covered, activeContact };
}

const companyOnlyRow = (page, companyId) => page.items.find(
  (item) => item?.resource === 'company' && item?.id === companyId,
);

test('4eec2e48: un archiviato non nasconde la riga azienda-sola in Tutti', async (t) => {
  const { base, onlyArchived, archivedContact } = await companyScene(t);
  const page = await listCustomerRecords(base, {});
  assert.ok(companyOnlyRow(page, onlyArchived.id) !== undefined,
    'the company named only by an archived contact still lists its company-only row');
  assert.ok(page.items.every((item) => item.id !== archivedContact.id),
    'the archived contact itself stays out of Tutti');
  assert.equal(pill(page, 'tutti'), page.total, 'the pill agrees with the page');
});

test('4eec2e48: un attivo coprente non crea righe azienda doppie', async (t) => {
  const { base, covered } = await companyScene(t);
  const page = await listCustomerRecords(base, {});
  assert.equal(companyOnlyRow(page, covered.id), undefined,
    'no company-only row when an active contact already names the company');
});

test('4eec2e48: la vista Archiviati elenca comunque il contatto archiviato', async (t) => {
  const { base, archivedContact } = await companyScene(t);
  const page = await listCustomerRecords(base, { vista: 'archiviati' });
  assert.ok(page.items.some((item) => item.id === archivedContact.id),
    'the archived contact is still listed in its own view');
});

test('4eec2e48: una tombstone non nasconde la riga azienda-sola', async (t) => {
  const { base, onlyArchived } = await companyScene(t);
  const contactService = base.modules.get('contact').service;
  const tombstone = {
    id: 'tombstone-stub', companyId: onlyArchived.id, firstName: 'Tomba', lastName: 'Pietra',
    email: 'tomba@b2-esempio.it', archivedAt: null, deletedAt: '2026-11-25T15:59:10.000Z',
  };
  const stubbed = withContactService(base, {
    list: async (opts = {}) => (opts?.archivedOnly === true
      ? contactService.list({ limit: CUSTOMER_SCAN_LIMIT, includeArchived: true, archivedOnly: true })
      : [tombstone]),
  });
  const page = await listCustomerRecords(stubbed, {});
  assert.ok(page.items.every((item) => item.id !== tombstone.id),
    'the tombstone lists no row in any view');
  assert.ok(companyOnlyRow(page, onlyArchived.id) !== undefined,
    'neither the archived contact nor the tombstone hides the company-only row');
});

test('4eec2e48: la lettura archiviati in errore non rompe Tutti', async (t) => {
  const { base } = await scene(t);
  const fault = Object.assign(new Error('archived index unavailable'), { code: 'ARCHIVED_INDEX_DOWN' });
  const stubbed = withContactService(base,
    stubContactService(base.modules.get('contact').service, { archivedError: fault }));
  const page = await listCustomerRecords(stubbed, {});
  assert.equal(page.totalIsExact, true, 'Tutti stays exact without the archived read');
  assert.equal(pill(page, 'tutti'), 1, 'Tutti still counts the active contact');
  assert.equal(pill(page, 'archiviati'), null, 'no archived pill without the archived read');
  await assert.rejects(
    listCustomerRecords(stubbed, { vista: 'archiviati' }),
    (error) => error?.code === 'CUSTOMER_LIST_UNAVAILABLE',
    'the archiviati view refuses with a code instead of a bare rejection',
  );
});

/**
 * backlog:4eec2e48 (review #1161 P2 su c50be6af, direzione simmetrica):
 * la vista «Archiviati» non dipende dalla lettura degli attivi — main non
 * la emetteva per quella vista. Cade sulla testa c50be6af (la lettura
 * attivi scoppia fuori da ogni try/catch e la vista rifiuta grezza).
 */
test('4eec2e48: la lettura attivi in errore non rompe la vista Archiviati', async (t) => {
  const { base, noMessages, withMessages } = await scene(t);
  const fault = Object.assign(new Error('active index unavailable'), { code: 'ACTIVE_INDEX_DOWN' });
  const stubbed = withContactService(base,
    stubContactService(base.modules.get('contact').service, { activeError: fault }));
  const page = await listCustomerRecords(stubbed, { vista: 'archiviati' });
  assert.equal(page.total, 2, 'both archived contacts are listed without the active read');
  const ids = page.items.map((item) => item.id);
  assert.ok(ids.includes(noMessages.id), 'the archived contact without messages is listed');
  assert.ok(ids.includes(withMessages.id), 'the archived contact with messages is listed');
  assert.equal(pill(page, 'archiviati'), 2, 'the pill agrees with the page');
  assert.equal(page.totalIsExact, true, 'the archiviati view stays exact without the active read');
  assert.equal(pill(page, 'tutti'), null, 'no Tutti count without the active read');
});
