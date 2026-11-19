import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Voce 91c92940274c (Presti, 19/11): un contatto che il titolare non
 * vuole — per esempio un mittente automatico arrivato dalla sync della
 * posta come «Apple Reply» — si archivia o si elimina.
 *
 * Cosa prova, dal vivo:
 * - archivia: sparisce da lista e conteggi, resta nel filtro Archiviati;
 * - ripristina: torna in lista;
 * - elimina: chiede la regola (con offerte solo archivio, 409), lascia
 *   l'audit e non tocca gli altri contatti;
 * - sync: l'email archiviata resta trovata e non si ricrea un doppione.
 */

const ACTOR = { type: 'user', id: 'titolare' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Presti Group' });
  const auto = await app.services.contacts.create({
    companyId: company.id, firstName: 'Apple', lastName: 'Reply',
    email: 'apple.reply@email.apple.com',
  });
  const other = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@prestigroup.example',
  });
  return { app, company, auto, other };
}

test('archivia: sparisce dalla lista, resta nel filtro Archiviati con audit', async (t) => {
  const { app, auto } = await scene(t);
  const archived = await app.services.contacts.archive(auto.id, { actor: ACTOR });
  assert.equal(archived.archivedAt === null, false, 'archivedAt is set');

  const list = await app.services.contacts.list({});
  assert.ok(!list.some((row) => row.id === auto.id), 'archived contact leaves the list');

  const only = await app.services.contacts.list({ includeArchived: true, archivedOnly: true });
  assert.ok(only.some((row) => row.id === auto.id), 'archived contact is found in Archiviati');
  assert.ok(only.every((row) => row.archivedAt !== null), 'Archiviati lists only archived rows');

  const scan = await app.services.contacts.scan({});
  assert.ok(!scan.some((row) => row.id === auto.id), 'archived contact leaves the search scan too');

  const actions = app.audit.list({ entityType: 'contact' }).map((event) => event.action);
  assert.ok(actions.includes('contact.archived'), 'the archive is audited');
});

test('ripristina: torna in lista', async (t) => {
  const { app, auto } = await scene(t);
  await app.services.contacts.archive(auto.id, { actor: ACTOR });
  const restored = await app.services.contacts.restore(auto.id, { actor: ACTOR });
  assert.equal(restored.archivedAt, null, 'archivedAt is cleared');

  const list = await app.services.contacts.list({});
  assert.ok(list.some((row) => row.id === auto.id), 'restored contact is back in the list');

  const actions = app.audit.list({ entityType: 'contact' }).map((event) => event.action);
  assert.ok(actions.includes('contact.restored'), 'the restore is audited');
});

test('elimina: senza offerte sparisce ovunque ma resta per audit e sync', async (t) => {
  const { app, auto, other } = await scene(t);
  const deleted = await app.services.contacts.remove(auto.id, { actor: ACTOR });
  assert.equal(deleted.deletedAt === null, false, 'deletedAt is set');

  const list = await app.services.contacts.list({});
  assert.ok(!list.some((row) => row.id === auto.id), 'deleted contact leaves the list');
  const archived = await app.services.contacts.list({ includeArchived: true, archivedOnly: true });
  assert.ok(!archived.some((row) => row.id === auto.id), 'deleted contact is not even in Archiviati');

  const reread = await app.services.contacts.get(auto.id);
  assert.equal(reread.id, auto.id, 'get still reads the row for audit and sync');
  const actions = app.audit.list({ entityType: 'contact' }).map((event) => event.action);
  assert.ok(actions.includes('contact.deleted'), 'the elimination is audited');

  const survivors = await app.services.contacts.list({});
  assert.ok(survivors.some((row) => row.id === other.id), 'other contacts are untouched');
});

test('elimina: con offerte collegate solo archivio, mai elimina (409)', async (t) => {
  const { app, company, auto } = await scene(t);
  await app.services.opportunities.create({
    companyId: company.id, contactId: auto.id,
    name: 'Abbonamento sala', valueCents: 50000, owner: 'coach-guido',
  });

  await assert.rejects(
    () => app.services.contacts.remove(auto.id, { actor: ACTOR }),
    (error) => error?.code === 'CONTACT_HAS_OPPORTUNITIES' && error?.status === 409,
    'a contact with offers refuses elimination with 409',
  );
  const archived = await app.services.contacts.archive(auto.id, { actor: ACTOR });
  assert.ok(archived.archivedAt !== null, 'the same contact archives fine instead');
  const reread = await app.services.contacts.get(auto.id);
  assert.equal(reread.deletedAt, null, 'the refused elimination wrote nothing');
});

test('sync: un archivio non si ricrea dalla stessa email', async (t) => {
  const { app, auto } = await scene(t);
  await app.services.contacts.archive(auto.id, { actor: ACTOR });

  // La riga resta: la sync ritrova la stessa email e riusa il contatto
  // archiviato invece di crearne uno nuovo (niente doppione no-reply).
  const tombstone = await app.services.contacts.get(auto.id);
  assert.equal(tombstone.email, 'apple.reply@email.apple.com', 'the archived row still resolves by id');
  assert.ok(tombstone.archivedAt !== null, 'and it stays archived, not resurrected');

  await assert.rejects(
    () => app.services.contacts.create({
      companyId: auto.companyId, firstName: 'Apple', lastName: 'Reply',
      email: 'apple.reply@email.apple.com',
    }, { actor: ACTOR }),
    (error) => error?.name === 'ConflictError',
    'a second sync row with the same email refuses instead of duplicating',
  );
});
