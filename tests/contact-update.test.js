import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { ConflictError, NotFoundError, ValidationError } from '../packages/core/src/errors.js';

/**
 * Voce 714433c2: the scheda cliente edits Dettagli in place.
 *
 * What it must prove: a partial patch touches only the keys present, the
 * email stays unique like in create (a taken address refuses, never a
 * silent duplicate), an empty patch and an unknown id refuse, and the write
 * is audited as `contact.updated`.
 */

const ACTOR = { type: 'user', id: 'scheda-op' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it', role: 'cliente',
  });
  return { app, company, contact };
}

test('a partial patch touches only the keys present and is audited', async (t) => {
  const { app, contact } = await scene(t);
  const updated = await app.services.contacts.update(contact.id, {
    firstName: 'Guido Maria', email: 'guido.maria@palestra-esempio.it',
  }, { actor: ACTOR });
  assert.equal(updated.firstName, 'Guido Maria');
  assert.equal(updated.lastName, 'Presti', 'an untouched key survives');
  assert.equal(updated.email, 'guido.maria@palestra-esempio.it');
  assert.equal(updated.role, 'cliente', 'an untouched key survives');
  assert.ok(updated.updatedAt >= contact.updatedAt, 'the write moves updatedAt');
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.firstName, 'Guido Maria', 'the patch persists');
  const actions = app.audit.list({ entityType: 'contact' }).map((event) => event.action);
  assert.ok(actions.includes('contact.created'), 'the create is audited');
  assert.ok(actions.includes('contact.updated'), 'the update is audited');
});

test('a taken email refuses with ConflictError, like create', async (t) => {
  const { app, company, contact } = await scene(t);
  await app.services.contacts.create({
    companyId: company.id, firstName: 'Altra', lastName: 'Persona',
    email: 'altra@palestra-esempio.it',
  });
  await assert.rejects(
    () => app.services.contacts.update(contact.id, { email: 'altra@palestra-esempio.it' }, { actor: ACTOR }),
    (error) => error instanceof ConflictError,
    'a taken address refuses, never a silent duplicate',
  );
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'the refused patch writes nothing');
});

test('an empty patch and an unknown id refuse', async (t) => {
  const { app, contact } = await scene(t);
  await assert.rejects(
    () => app.services.contacts.update(contact.id, {}, { actor: ACTOR }),
    (error) => error instanceof ValidationError,
    'an empty patch refuses',
  );
  await assert.rejects(
    () => app.services.contacts.update(contact.id, { companyId: 'other' }, { actor: ACTOR }),
    (error) => error instanceof ValidationError,
    'a patch with no editable key refuses',
  );
  await assert.rejects(
    () => app.services.contacts.update('ghost-id', { firstName: 'X' }, { actor: ACTOR }),
    (error) => error instanceof NotFoundError,
    'an unknown id refuses before any write',
  );
});

test('invalid values refuse like create', async (t) => {
  const { app, contact } = await scene(t);
  await assert.rejects(
    () => app.services.contacts.update(contact.id, { email: 'not-an-email' }, { actor: ACTOR }),
    (error) => error instanceof ValidationError,
    'a bad email refuses',
  );
  await assert.rejects(
    () => app.services.contacts.update(contact.id, { firstName: '' }, { actor: ACTOR }),
    (error) => error instanceof ValidationError,
    'an empty first name refuses',
  );
});
