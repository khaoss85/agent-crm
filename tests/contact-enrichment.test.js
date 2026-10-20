import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, project } from './helpers/customer-data-project.js';
import { createFakeGoogleContacts } from '../packages/customer-data/src/google-contacts-fake.js';
import { parseEmailSignature } from '../packages/customer-data/src/signature-fields.js';

/**
 * **Contact enrichment from free sources (backlog:3de717335694).**
 *
 * Google Contacts of the space (fake People API, no network, no paid
 * service) and locally parsed email signatures fill contact gaps. Every
 * enriched field is stored beside the contact record with its source and
 * observation date; the contact record itself is never written, so manual
 * data wins by construction. Conflicts become duplicate candidates, and an
 * opted-out subject is never enriched again while its enriched fields are
 * purged. The Google source stays behind its flag until the Google
 * verification approves the contacts.readonly scope.
 */

const ACTOR = { type: 'user', id: 'enrichment' };

async function scene(t, tag, options = {}) {
  const root = project(t, options);
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

function contactRow(app, email) {
  return app.database.raw.prepare(
    'SELECT first_name AS firstName, last_name AS lastName, email, role FROM contacts WHERE email = ?',
  ).get(email);
}

function contactsCount(app) {
  return app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
}

function enrichedRows(app, contactId) {
  return app.modules.get('enriched-field').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId });
}

function seedPerson(fake, overrides = {}) {
  return fake.seedPerson({
    resourceName: 'people/c1',
    names: [{ givenName: 'Luca', familyName: 'Rossi' }],
    emailAddresses: [{ value: 'luca@prestigroup.example' }],
    phoneNumbers: [{ canonicalForm: '+393331234567' }],
    organizations: [{ name: 'Presti Group', title: 'Istruttore' }],
    ...overrides,
  });
}

test('the Google source stays behind its flag until verification approves the scope', async (t) => {
  const { app } = await scene(t, 'enrichment-flag-off');
  const fake = createFakeGoogleContacts();
  seedPerson(fake);

  await assert.rejects(
    app.importGoogleContacts({ actor: ACTOR, adapter: fake }),
    (error) => error.code === 'ENRICHMENT_GOOGLE_CONTACTS_DISABLED');
  await assert.rejects(
    app.applyContactEnrichment({
      actor: ACTOR, email: 'luca@prestigroup.example',
      fields: { firstName: 'Luca' }, source: 'google-contacts',
    }),
    (error) => error.code === 'ENRICHMENT_GOOGLE_CONTACTS_DISABLED');

  // The signature source needs no Google scope and works with the flag off.
  const answer = await app.applyContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example',
    fields: { firstName: 'Luca' }, source: 'email-signature', sourceDetail: 'msg-1',
  });
  assert.equal(answer.outcome, 'created');
  assert.equal(contactsCount(app), 1);
});

test('a Google import creates the contact and stores every field with source and date', async (t) => {
  const { app } = await scene(t, 'enrichment-import-create', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  seedPerson(fake);

  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(summary.outcome, 'imported');
  assert.deepEqual(summary.counts, {
    people: 1, enriched: 1, created: 1, candidates: 0, skippedOptOut: 0, skippedNoIdentity: 0,
  });

  const contact = contactRow(app, 'luca@prestigroup.example');
  assert.ok(contact, 'the person became a contact');

  const rows = enrichedRows(app, app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'google-contacts:people/c1' })[0].subjectId);
  assert.ok(rows.length >= 4, 'names, role, company and phone are stored beside the record');
  for (const row of rows) {
    assert.equal(row.source, 'google-contacts');
    assert.equal(row.sourceDetail, 'people/c1');
    assert.equal(row.status, 'active');
    assert.ok(typeof row.observedAt === 'string' && row.observedAt !== '', 'every enriched field carries its date');
  }
  const byField = new Map(rows.map((row) => [row.field, row.value]));
  assert.equal(byField.get('firstName'), 'Luca');
  assert.equal(byField.get('phone'), '+393331234567');

  // The Google id is linked, so a second import replays instead of duplicating.
  const again = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(again.counts.created, 0);
  assert.equal(again.counts.enriched, 1);
  assert.equal(contactsCount(app), 1, 'no second contact for the same person');
  assert.equal(
    enrichedRows(app, rows[0].subjectId).filter((row) => row.status === 'active').length,
    rows.length,
    'a replay refreshes the same rows instead of writing new ones');
});

test('enrichment never rewrites the contact record: manual data wins by construction', async (t) => {
  const { app } = await scene(t, 'enrichment-manual-wins');
  const created = await app.resolveChannelSender({
    channel: 'email', handle: 'anna@prestigroup.example',
    firstName: 'Anna', lastName: 'Bianchi', companyName: 'Presti Group', actor: ACTOR,
  });
  assert.equal(created.outcome, 'created');
  const before = contactRow(app, 'anna@prestigroup.example');

  const answer = await app.applyContactEnrichment({
    actor: ACTOR, email: 'anna@prestigroup.example',
    fields: { firstName: 'Annalisa', lastName: 'Rossi', role: 'Socio' },
    source: 'email-signature', sourceDetail: 'msg-9',
  });
  assert.equal(answer.outcome, 'enriched');

  assert.deepEqual(contactRow(app, 'anna@prestigroup.example'), before,
    'first name, last name and role on the record are byte-identical after enrichment');
  const rows = enrichedRows(app, created.contact.id).filter((row) => row.status === 'active');
  assert.equal(rows.length, 3, 'the source evidence is still kept beside the record');
  assert.ok(rows.every((row) => row.source === 'email-signature' && row.sourceDetail === 'msg-9'));
});

test('a person whose Google id and email name different contacts becomes a candidate, never a second contact', async (t) => {
  const { app } = await scene(t, 'enrichment-conflict', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  seedPerson(fake, { resourceName: 'people/c1', emailAddresses: [{ value: 'luca@prestigroup.example' }] });
  const first = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(first.counts.created, 1);

  // The same Google id now carries another contact's email.
  const second = createFakeGoogleContacts();
  second.seedPerson({
    resourceName: 'people/c1',
    names: [{ givenName: 'Luca', familyName: 'Rossi' }],
    emailAddresses: [{ value: 'socio@prestigroup.example' }],
  });
  const socio = await app.resolveChannelSender({
    channel: 'email', handle: 'socio@prestigroup.example', email: 'socio@prestigroup.example',
    firstName: 'Socio', lastName: 'Altro', companyName: 'Altra Srl', actor: ACTOR,
  });
  assert.equal(socio.outcome, 'created');
  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: second });
  assert.equal(summary.counts.candidates, 1);
  assert.equal(summary.counts.created, 0);
  assert.equal(contactsCount(app), 2, 'no contact was fused or added');

  const candidates = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rule, 'contact-enrichment');
  const luca = contactRow(app, 'luca@prestigroup.example');
  assert.ok(luca, 'the original contact is untouched');
});

test('opt-out stops every new enrichment and purges the enriched fields', async (t) => {
  const { app } = await scene(t, 'enrichment-opt-out', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  seedPerson(fake);
  await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  const contactId = app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'google-contacts:people/c1' })[0].subjectId;
  assert.ok(enrichedRows(app, contactId).some((row) => row.status === 'active'));

  const left = await app.optOutContactEnrichment({
    actor: ACTOR, email: 'luca@prestigroup.example', reason: 'asked at the desk',
  });
  assert.equal(left.outcome, 'opted-out');
  assert.ok(left.purged > 0, 'the active enriched fields are purged');

  const rows = enrichedRows(app, contactId);
  assert.ok(rows.length > 0, 'the purge keeps tombstones instead of erasing history');
  assert.ok(rows.every((row) => row.status === 'purged'), 'no active enriched field survives');
  assert.ok(rows.every((row) => row.value === null), 'purged values are cleared, not kept');
  const optOuts = app.modules.get('enrichment-opt-out').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId });
  assert.equal(optOuts.length, 1, 'the refusal itself is recorded');

  await assert.rejects(
    app.applyContactEnrichment({
      actor: ACTOR, email: 'luca@prestigroup.example',
      fields: { role: 'Socio' }, source: 'email-signature',
    }),
    (error) => error.code === 'ENRICHMENT_OPTED_OUT');

  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(summary.counts.skippedOptOut, 1);
  assert.equal(summary.counts.enriched, 0);

  const identities = app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId, status: 'active' });
  assert.ok(identities.length > 0, 'channel identities stay: they route messages, they are not enrichment');
});

test('paging walks the whole address book and a person without identity is skipped, never invented', async (t) => {
  const { app } = await scene(t, 'enrichment-pages', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  seedPerson(fake, { resourceName: 'people/c1', emailAddresses: [{ value: 'uno@prestigroup.example' }] });
  seedPerson(fake, {
    resourceName: 'people/c2',
    names: [{ givenName: 'Due', familyName: 'Senza' }],
    emailAddresses: [],
    phoneNumbers: [],
  });
  seedPerson(fake, { resourceName: 'people/c3', emailAddresses: [{ value: 'tre@prestigroup.example' }] });

  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: fake, pageSize: 1 });
  assert.equal(summary.counts.people, 3);
  assert.equal(summary.counts.created, 2);
  assert.equal(summary.counts.skippedNoIdentity, 1);
  assert.equal(contactsCount(app), 2, 'the identity-less person invented no contact');
});

test('two connections racing the same enrichment produce one contact and no raw error', async (t) => {
  const root = project(t, {});
  const dbPath = join(root, 'data', 'enrichment-race.sqlite');
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const one = createAccordoApp({ dbPath });
  const two = createAccordoApp({ dbPath, busyTimeoutMs: 5000 });
  t.after(() => { one.close(); two.close(); });

  const input = (tag) => ({
    actor: ACTOR, email: 'gara@prestigroup.example',
    fields: { firstName: 'Gara', phone: '+393330000009' }, source: 'email-signature', runId: tag,
  });
  const results = await Promise.allSettled([
    one.applyContactEnrichment(input('race-one')),
    two.applyContactEnrichment(input('race-two')),
  ]);

  assert.equal(contactsCount(one), 1, 'the losing connection creates no duplicate contact');
  const ids = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value.contact.id);
  assert.ok(ids.length > 0, 'at least one connection enriched');
  assert.ok(ids.every((id) => id === ids[0]), 'every winner names the same contact');
  for (const result of results) {
    if (result.status === 'rejected') {
      assert.doesNotMatch(String(result.reason?.message ?? ''), /SQLITE_|constraint failed/i,
        'a race must not surface a raw storage error');
    }
  }
  const rows = enrichedRows(one, ids[0]).filter((row) => row.status === 'active');
  assert.equal(rows.filter((row) => row.field === 'firstName').length, 1, 'one row per field');
});

test('one poisoned person aborts nothing: garbage entries are skipped, not stored', async (t) => {
  const { app } = await scene(t, 'enrichment-poison', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  fake.seedPerson({
    resourceName: 'people/c9',
    names: [{ givenName: 42, familyName: null }],
    emailAddresses: [{ value: 42 }, { value: 'buono@prestigroup.example' }],
    phoneNumbers: [{ canonicalForm: 'not-a-phone' }],
    organizations: 'not-an-object',
  });
  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(summary.counts.enriched, 1);
  const rows = enrichedRows(app, app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'google-contacts:people/c9' })[0].subjectId);
  assert.ok(rows.every((row) => typeof row.value === 'string'), 'no garbage value landed in a row');
  assert.ok(!rows.some((row) => row.field === 'phone'), 'the undialable phone was skipped');
});

test('an email signature parses to contact fields and hostile text refuses', async (t) => {
  const parsed = parseEmailSignature(
    ['Marco Verdi', 'Istruttore sala pesi | Presti Group', 'Tel: +39 333 765 4321', 'marco@prestigroup.example'].join('\n'),
    { messageId: 'msg-7' },
  );
  assert.equal(parsed.firstName, 'Marco');
  assert.equal(parsed.lastName, 'Verdi');
  assert.equal(parsed.email, 'marco@prestigroup.example');
  assert.equal(parsed.phone, '+393337654321');
  assert.equal(parsed.sourceDetail, 'msg-7');

  const labeled = parseEmailSignature('Anna Bianchi\nRuolo: Receptionist\nAzienda: Presti Group');
  assert.equal(labeled.role, 'Receptionist');
  assert.equal(labeled.companyName, 'Presti Group');

  const street = parseEmailSignature('Via Roma 12, Milano\nTel 02 123456');
  assert.equal(street.firstName, null, 'a street line is not a person name');
  assert.equal(street.phone, '02123456');

  assert.throws(() => parseEmailSignature('Luca Rossi\x07', {}), /control characters/,
    'control characters refuse instead of landing in a row');

  // The parsed fields flow straight into enrichment with source and date.
  const { app } = await scene(t, 'enrichment-signature-apply');
  const answer = await app.applyContactEnrichment({
    actor: ACTOR, email: parsed.email,
    fields: {
      firstName: parsed.firstName, lastName: parsed.lastName, role: parsed.role, phone: parsed.phone,
    },
    source: 'email-signature', sourceDetail: parsed.sourceDetail,
  });
  assert.equal(answer.outcome, 'created');
  const rows = enrichedRows(app, answer.contact.id).filter((row) => row.status === 'active');
  assert.ok(rows.every((row) => row.source === 'email-signature'));
});
