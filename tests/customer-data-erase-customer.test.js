import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Voce d271d723 (validazione B6): cancellare un cliente davvero (GDPR).
 *
 * What it must prove: erasing a customer with messages and appointments
 * takes a user actor with an explicit titolare confirmation and a recorded
 * reason; it refuses when signed business must be kept (the one status
 * rule); otherwise it anonymizes the contact, withdraws the channel
 * identities, purges enriched fields, blanks custom-field values, records
 * one append-only erasure-log row, and the customer disappears from the
 * customer list, the search, the direct profile link and the export.
 * A second erasure replays the stored row.
 */

const OPERATOR = { type: 'user', id: 'titolare-1' };
const AGENT = { type: 'agent', id: 'agent-1' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  assert.equal(typeof app.eraseCustomer, 'function', 'the customer-data package offers the erasure operation');
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const other = await app.services.contacts.create({
    companyId: company.id, firstName: 'Maria', lastName: 'Rossi',
    email: 'maria@palestra-esempio.it',
  });
  await app.recordSubjectPhone({ resource: 'contact', id: contact.id, phone: '+393331234567', actor: OPERATOR });
  return { app, company, contact, other };
}

async function erasureRows(app, resource, id) {
  return app.modules.get('customer-erasure-log').service.listWhere({ subjectResource: resource, subjectId: id });
}

/** A signed-business stub: one order row naming this company makes the profile a cliente. */
function stubSignedBusiness(app, companyId) {
  app.modules.register({
    name: 'order',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['list'],
    fields: [
      { name: 'id', type: 'string', required: true, unique: true },
      { name: 'companyId', type: 'string', required: false, unique: false },
    ],
    service: {
      list: async () => [{ id: 'order-1', companyId }],
    },
  });
}

test('erasing needs the titolare: agent actors, missing confirm and missing reason refuse', async (t) => {
  const { app, contact } = await scene(t);
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta', actor: AGENT }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED' && error?.status === 403,
    'an agent actor refuses: erasing is a titolare decision',
  );
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, reason: 'richiesta', actor: OPERATOR }),
    (error) => error?.name === 'ValidationError',
    'no explicit confirmation refuses',
  );
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, actor: OPERATOR }),
    (error) => error?.name === 'ValidationError',
    'no recorded reason refuses',
  );
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: 'ghost', confirm: true, reason: 'richiesta', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_SUBJECT_NOT_FOUND' && error?.status === 404,
    'an unknown customer reads 404',
  );
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a refused erasure records nothing');
});

test('signed business blocks the erasure: a cliente is kept, never erased', async (t) => {
  const { app, company, contact } = await scene(t);
  stubSignedBusiness(app, company.id);
  const profile = await app.readCustomerProfile({ resource: 'contact', id: contact.id });
  assert.equal(profile.status.value, 'cliente', 'the stub order promotes the contact to cliente');
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_BLOCKED_SIGNED_BUSINESS' && error?.status === 409,
    'signed business refuses with 409',
  );
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'a blocked erasure rewrites nothing');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a blocked erasure records nothing');
});

test('erasing anonymizes, records and excludes: list, search, profile and export lose the customer', async (t) => {
  const { app, contact } = await scene(t);
  await app.defineCustomField({ label: 'Amico', type: 'si-no', actor: OPERATOR });
  const defs = await app.listCustomFields({});
  const amico = defs.find((def) => def.label === 'Amico');
  assert.ok(amico, 'the custom field exists');
  await app.setCustomFieldValue({ resource: 'contact', id: contact.id, key: amico.key, value: true, actor: OPERATOR });

  const receipt = await app.eraseCustomer({
    resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta del cliente', actor: OPERATOR,
  });
  assert.equal(receipt.outcome, 'erased');
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.reason, 'richiesta del cliente');

  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.firstName, 'Cliente');
  assert.equal(reread.lastName, 'cancellato');
  assert.match(reread.email, /^cancellato-.*@cancellato\.invalid$/, 'the email is non-identifying and never deliverable');

  const identities = await app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.ok(identities.length > 0, 'the identity rows stay (append-only) but withdrawn');
  for (const row of identities) {
    assert.equal(row.status, 'superseded', 'no active identity names the erased customer');
    assert.match(String(row.externalId), /^cancellato:/, 'the held identifier is redacted');
  }

  const values = await app.modules.get('custom-field-value').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id });
  for (const row of values) {
    assert.equal(row.value, null, 'personal custom-field values are blanked');
  }

  const logged = await erasureRows(app, 'contact', contact.id);
  assert.equal(logged.length, 1, 'one append-only registry row');
  assert.equal(logged[0].reason, 'richiesta del cliente');
  assert.equal(logged[0].erasedById, 'titolare-1');

  const list = await app.listCustomers({ pageSize: 50 });
  assert.ok(!list.items.some((row) => row.id === contact.id), 'the erased customer leaves Clienti');
  const search = await app.listCustomers({ q: 'Presti', pageSize: 50 });
  assert.ok(!search.items.some((row) => row.id === contact.id), 'the erased customer leaves the search');

  await assert.rejects(
    () => app.readCustomerProfile({ resource: 'contact', id: contact.id }),
    (error) => error?.code === 'CUSTOMER_ERASED' && error?.status === 404,
    'the direct link reads 404',
  );

  const exported = await app.exportCustomerRecords({ resource: 'external-identity' });
  assert.ok(
    !exported.rows.some((row) => row.subjectResource === 'contact' && row.subjectId === contact.id),
    'the export carries no row naming the erased customer',
  );

  const replay = await app.eraseCustomer({
    resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta del cliente', actor: OPERATOR,
  });
  assert.equal(replay.replayed, true, 'a second erasure replays the stored row');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 1, 'no second registry row');
});

test('the company with other contacts stays: only the erased contact leaves', async (t) => {
  const { app, company, contact, other } = await scene(t);
  await app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta', actor: OPERATOR });
  const list = await app.listCustomers({ pageSize: 50 });
  assert.ok(list.items.some((row) => row.id === other.id), 'the other contact still lists');
  assert.ok(list.items.some((row) => row.company?.id === company.id), 'the shared company still shows beside its contact');
  assert.equal((await erasureRows(app, 'company', company.id)).length, 0, 'no registry row for a kept company');
});

test('nobody authorizes an erasure: a missing or malformed actor refuses and records nothing', async (t) => {
  const { app, contact } = await scene(t);
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta' }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED' && error?.status === 403,
    'no actor refuses: the fail-closed anonymous authorizes nothing',
  );
  await assert.rejects(
    () => app.eraseCustomer({
      resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta', actor: { type: 'user' },
    }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED' && error?.status === 403,
    'an actor without an id refuses too',
  );
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'a refused erasure rewrites nothing');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a refused erasure records nothing');
});

test('uncertain evidence blocks the erasure: an empty bounded page proves nothing', async (t) => {
  const { app, contact } = await scene(t);
  app.modules.register({
    name: 'order',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['list'],
    fields: [
      { name: 'id', type: 'string', required: true, unique: true },
    ],
    service: {
      list: async () => [],
    },
  });
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_EVIDENCE_UNREADABLE' && error?.status === 409,
    'a list-only page refuses even when empty: a page is not a count',
  );
  const reread = await app.services.contacts.get(contact.id);
  assert.equal(reread.email, 'guido@palestra-esempio.it', 'a blocked erasure rewrites nothing');
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a blocked erasure records nothing');
});

test('uncertain evidence blocks the erasure: a failed evidence read refuses', async (t) => {
  const { app, contact } = await scene(t);
  app.modules.register({
    name: 'order',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['list'],
    fields: [
      { name: 'id', type: 'string', required: true, unique: true },
    ],
    service: {
      list: async () => { throw new Error('order store down'); },
    },
  });
  await assert.rejects(
    () => app.eraseCustomer({ resource: 'contact', id: contact.id, confirm: true, reason: 'richiesta', actor: OPERATOR }),
    (error) => error?.code === 'ERASURE_EVIDENCE_UNREADABLE' && error?.status === 409,
    'an unreadable evidence package refuses instead of risking signed business',
  );
  assert.equal((await erasureRows(app, 'contact', contact.id)).length, 0, 'a blocked erasure records nothing');
});

test('erasing a company cascades to its contacts: no name or email survives in Clienti', async (t) => {
  const { app, company, contact, other } = await scene(t);
  const receipt = await app.eraseCustomer({
    resource: 'company', id: company.id, confirm: true, reason: 'richiesta del cliente', actor: OPERATOR,
  });
  assert.equal(receipt.outcome, 'erased');
  assert.equal(receipt.counts.subjects, 3, 'the company and both linked contacts go together');
  for (const erased of [contact, other]) {
    const reread = await app.services.contacts.get(erased.id);
    assert.equal(reread.firstName, 'Cliente');
    assert.equal(reread.lastName, 'cancellato');
    assert.match(reread.email, /^cancellato-.*@cancellato\.invalid$/, 'no identifying email survives the cascade');
    assert.equal((await erasureRows(app, 'contact', erased.id)).length, 1, 'one registry row per cascaded contact');
  }
  assert.equal((await erasureRows(app, 'company', company.id)).length, 1, 'one registry row for the company');
  const list = await app.listCustomers({ pageSize: 50 });
  assert.ok(!list.items.some((row) => row.id === contact.id || row.id === other.id), 'cascaded contacts leave Clienti');
  const search = await app.listCustomers({ q: 'Presti', pageSize: 50 });
  assert.ok(!search.items.some((row) => row.id === contact.id), 'the erased name leaves the search');
});
