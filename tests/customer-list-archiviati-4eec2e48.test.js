import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';

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
