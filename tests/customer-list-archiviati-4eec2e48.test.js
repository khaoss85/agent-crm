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

const stubContactService = (service, { actives = null, archived = null, archivedError = null }) => ({
  list: async (opts = {}) => {
    if (opts?.archivedOnly === true) {
      if (archivedError !== null) throw archivedError;
      if (archived !== null) return archived;
      return service.list({ limit: CUSTOMER_SCAN_LIMIT, includeArchived: true, archivedOnly: true });
    }
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
