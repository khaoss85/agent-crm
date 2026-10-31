import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Voce 105563eea902: the scheda cliente's "Aggiungi telefono".
 *
 * What it must prove: an operator-held phone number lands as an
 * `external-identity` row of system `phone` beside the contact or company —
 * the same identity record the sender resolution already owns (MEM_ACC_REUSE:
 * no new table, no master customer row). E.164 only, because the card dials
 * exactly the stored value: a number the scheda cannot dial is refused here,
 * not stored as a dead «Chiama». One identifier names one record, once: the
 * same number beside the same subject refreshes its sighting, beside another
 * subject it refuses 409 PHONE_ALREADY_HELD. A human decision: agent actors
 * refuse with HUMAN_APPROVAL_REQUIRED.
 */

const OPERATOR = { type: 'user', id: 'scheda-op' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  assert.equal(typeof app.recordSubjectPhone, 'function', 'the customer-data package offers the phone operation');
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const other = await app.services.contacts.create({
    companyId: company.id, firstName: 'Maria', lastName: 'Rossi',
    email: 'maria@palestra-esempio.it',
  });
  const identities = app.modules.get('external-identity').service;
  return { app, contact, other, company, identities };
}

function heldBy(app, contactId) {
  return app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId, status: 'active' });
}

test('an E.164 number is held beside the contact and reads on the profile', async (t) => {
  const { app, contact } = await scene(t);
  const recorded = await app.recordSubjectPhone({
    resource: 'contact', id: contact.id, phone: '+39 333 123 4567', actor: OPERATOR,
  });
  assert.equal(recorded.outcome, 'linked');
  assert.equal(recorded.system, 'phone');
  assert.equal(recorded.externalId, '+393331234567', 'display separators strip, the dialable value stores');
  assert.deepEqual(recorded.subject, { resource: 'contact', id: contact.id });

  const rows = await heldBy(app, contact.id);
  assert.equal(rows.length, 1, 'exactly one identity row');
  assert.equal(rows[0].system, 'phone');
  assert.equal(rows[0].externalId, '+393331234567');

  const profile = await app.readCustomerProfile({ resource: 'contact', id: contact.id });
  const phones = profile.externalIdentities.filter((row) => row.system === 'phone');
  assert.equal(phones.length, 1, 'the card reads the held number from the profile');
});

test('the same number beside the same subject refreshes, beside another refuses 409', async (t) => {
  const { app, contact, other } = await scene(t);
  await app.recordSubjectPhone({
    resource: 'contact', id: contact.id, phone: '+393331234567', actor: OPERATOR,
  });
  const replay = await app.recordSubjectPhone({
    resource: 'contact', id: contact.id, phone: '+393331234567', actor: OPERATOR,
  });
  assert.equal(replay.outcome, 'refreshed', 'the same holding is a refresh, never a second row');
  assert.equal((await heldBy(app, contact.id)).length, 1);

  await assert.rejects(
    () => app.recordSubjectPhone({
      resource: 'contact', id: other.id, phone: '+393331234567', actor: OPERATOR,
    }),
    (error) => error?.code === 'PHONE_ALREADY_HELD' && error?.status === 409,
    'one identifier names one record: held beside another customer it refuses',
  );
  assert.equal((await heldBy(app, other.id)).length, 0, 'a refused holding writes nothing');
});

test('a refused cross-subject holding leaves the winner row and its sighting untouched', async (t) => {
  const { app, contact, other } = await scene(t);
  await app.recordSubjectPhone({
    resource: 'contact', id: contact.id, phone: '+393331234567', actor: OPERATOR,
  });
  const before = (await heldBy(app, contact.id))[0];
  assert.ok(before, 'the winner holds the number');
  await assert.rejects(
    () => app.recordSubjectPhone({
      resource: 'contact', id: other.id, phone: '+393331234567', actor: OPERATOR,
    }),
    (error) => error?.code === 'PHONE_ALREADY_HELD' && error?.status === 409,
    'the loser refuses 409 instead of reporting a foreign refresh as success',
  );
  const after = (await heldBy(app, contact.id))[0];
  assert.equal(after.subjectId, contact.id, 'the row still names the winner');
  assert.equal(after.lastObservedRunId, before.lastObservedRunId, 'no sighting is bumped by the refused hold');
  assert.equal(after.lastObservedAt, before.lastObservedAt, 'no timestamp is bumped by the refused hold');
  assert.equal((await heldBy(app, other.id)).length, 0, 'the loser card never shows the number');
});

test('a company holds a number the same way', async (t) => {
  const { app, company } = await scene(t);
  const recorded = await app.recordSubjectPhone({
    resource: 'company', id: company.id, phone: '+390612345678', actor: OPERATOR,
  });
  assert.equal(recorded.outcome, 'linked');
  assert.deepEqual(recorded.subject, { resource: 'company', id: company.id });
});

test('not E.164, not a subject and not a human refuse', async (t) => {
  const { app, contact } = await scene(t);
  for (const phone of ['3331234567', '+39', 'abc', '+39333abc4567', '']) {
    await assert.rejects(
      () => app.recordSubjectPhone({ resource: 'contact', id: contact.id, phone, actor: OPERATOR }),
      (error) => error?.name === 'ValidationError',
      `not callable E.164 (${phone || 'empty'}) refuses`,
    );
  }
  await assert.rejects(
    () => app.recordSubjectPhone({ resource: 'lead', id: contact.id, phone: '+393331234567', actor: OPERATOR }),
    (error) => error?.code === 'CUSTOMER_DATA_PHONE_SUBJECT_INVALID',
    'only contact and company subjects hold numbers',
  );
  await assert.rejects(
    () => app.recordSubjectPhone({
      resource: 'contact', id: contact.id, phone: '+393331234567', actor: { type: 'agent', id: 'bot' },
    }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
    'holding a number is a human decision',
  );
  assert.equal((await heldBy(app, contact.id)).length, 0, 'refused holdings write nothing');
});
