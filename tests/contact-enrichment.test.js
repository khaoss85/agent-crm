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
    people: 1, enriched: 1, created: 1, candidates: 0,
    skippedOptOut: 0, skippedNoIdentity: 0, skippedMalformed: 0,
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
  seedPerson(fake, {
    resourceName: 'people/c1',
    emailAddresses: [{ value: 'uno@prestigroup.example' }],
    phoneNumbers: [{ canonicalForm: '+393330000001' }],
  });
  seedPerson(fake, {
    resourceName: 'people/c2',
    names: [{ givenName: 'Due', familyName: 'Senza' }],
    emailAddresses: [],
    phoneNumbers: [],
  });
  seedPerson(fake, {
    resourceName: 'people/c3',
    emailAddresses: [{ value: 'tre@prestigroup.example' }],
    phoneNumbers: [{ canonicalForm: '+393330000003' }],
  });

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

test('a person whose provider strings fail validation is skipped while the run continues', async (t) => {
  const { app } = await scene(t, 'enrichment-poison-throws', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  fake.seedPerson({
    resourceName: 'people/good',
    names: [{ givenName: 'Buono', familyName: 'Socio' }],
    emailAddresses: [{ value: 'buono2@prestigroup.example' }],
  });
  // An overlong org title throws out of personFields; a control character
  // in the only email throws out of emailShape; an unusable resource name
  // refuses the person. None of them aborts the run.
  fake.seedPerson({
    resourceName: 'people/overlong',
    names: [{ givenName: 'Lungo', familyName: 'Titolo' }],
    emailAddresses: [{ value: 'lungo@prestigroup.example' }],
    organizations: [{ name: 'Presti Group', title: 'x'.repeat(400) }],
  });
  fake.seedPerson({
    resourceName: 'people/control',
    names: [{ givenName: 'Ctrl', familyName: 'Char' }],
    emailAddresses: [{ value: 'ctrl\x07@prestigroup.example' }],
  });
  fake.seedPerson({
    resourceName: `people/${'y'.repeat(300)}`,
    names: [{ givenName: 'Lungo', familyName: 'Id' }],
    emailAddresses: [{ value: 'lungoid@prestigroup.example' }],
  });

  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(summary.counts.people, 4);
  assert.equal(summary.counts.enriched, 1);
  assert.equal(summary.counts.created, 1);
  assert.equal(summary.counts.skippedMalformed, 3);
  assert.equal(contactsCount(app), 1, 'only the valid person became a contact');
});

test('a provider resource name outside the handle discipline refuses the person, never the run', async (t) => {
  const { app } = await scene(t, 'enrichment-resource-name', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  fake.seedPerson({
    resourceName: `people/${'z'.repeat(300)}`,
    names: [{ givenName: 'Lungo', familyName: 'Id' }],
    emailAddresses: [{ value: 'lungoid@prestigroup.example' }],
  });
  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(summary.counts.skippedMalformed, 1);
  assert.equal(
    app.modules.get('external-identity').service.listWhere({ status: 'active' }).length,
    0, 'no overlong or control-carrying id landed in a stored row');
});

test('a malformed-phone-only call refuses before creating any contact', async (t) => {
  const { app } = await scene(t, 'enrichment-phone-only');
  const before = contactsCount(app);
  await assert.rejects(
    app.applyContactEnrichment({
      actor: ACTOR, email: 'solo@prestigroup.example',
      fields: { phone: 'not-a-phone' }, source: 'email-signature',
    }),
    (error) => error.message === 'enrichment needs at least one field to fill');
  await assert.rejects(
    app.applyContactEnrichment({
      actor: ACTOR, email: 'solo@prestigroup.example',
      fields: { phone: 42 }, source: 'email-signature',
    }),
    (error) => error.message === 'enrichment needs at least one field to fill');
  assert.equal(contactsCount(app), before, 'a skipped-only receipt invents no customer');
  assert.equal(
    app.modules.get('external-identity').service
      .listWhere({ sourceKey: 'email:solo@prestigroup.example' }).length,
    0, 'not even the email identity is linked');
});

test('signature dates, VAT numbers and fax lines never become phones', () => {
  const dated = parseEmailSignature(['Luca Rossi', 'Riunione 12/05/2024', 'luca@prestigroup.example'].join('\n'));
  assert.equal(dated.phone, null, 'a date is not a phone');
  const vat = parseEmailSignature(['Luca Rossi', 'P.IVA 01234567890', 'luca@prestigroup.example'].join('\n'));
  assert.equal(vat.phone, null, 'a VAT number is not a phone');
  const fax = parseEmailSignature(['Luca Rossi', 'Fax: +39 02 1234567', 'luca@prestigroup.example'].join('\n'));
  assert.equal(fax.phone, null, 'a fax line is not a phone');
  const intl = parseEmailSignature(['Luca Rossi', '+39 333 123 4567', 'luca@prestigroup.example'].join('\n'));
  assert.equal(intl.phone, '+393331234567', 'an explicitly international number still parses');
});

test('the two enrichment record sets export like the metadata and README promise', async (t) => {
  const { app } = await scene(t, 'enrichment-export');
  await app.applyContactEnrichment({
    actor: ACTOR, email: 'exa@prestigroup.example',
    fields: { firstName: 'Exa' }, source: 'email-signature', sourceDetail: 'msg-x',
  });
  const fields = await app.exportCustomerRecords({ resource: 'enriched-field' });
  assert.equal(fields.complete, true);
  assert.ok(fields.rows.length >= 1, 'the stored enriched field exports');
  await app.optOutContactEnrichment({ actor: ACTOR, email: 'exa@prestigroup.example', reason: 'test' });
  const optOuts = await app.exportCustomerRecords({ resource: 'enrichment-opt-out' });
  assert.equal(optOuts.complete, true);
  assert.equal(optOuts.rows.length, 1, 'the recorded refusal exports');
});

test('an opt-out racing an in-flight enrichment leaves no active enriched field', async (t) => {
  const root = project(t, {});
  const dbPath = join(root, 'data', 'enrichment-optout-race.sqlite');
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const one = createAccordoApp({ dbPath, busyTimeoutMs: 15000 });
  const two = createAccordoApp({ dbPath, busyTimeoutMs: 15000 });
  t.after(() => { one.close(); two.close(); });

  async function raceOnce(tag) {
    const email = `${tag}@prestigroup.example`;
    await one.applyContactEnrichment({
      actor: ACTOR, email, fields: { firstName: 'Corsa' }, source: 'email-signature', runId: `seed-${tag}`,
    });
    const contactId = one.modules.get('external-identity').service
      .listWhere({ sourceKey: `email:${email}` })[0].subjectId;
    const ops = [
      () => one.applyContactEnrichment({
        actor: ACTOR, email, fields: { role: 'Socio' }, source: 'email-signature', runId: `race-${tag}`,
      }),
      () => two.optOutContactEnrichment({ actor: ACTOR, email, reason: 'race' }),
    ];
    const results = await Promise.allSettled(ops.map((op) => op()));
    for (let i = 0; i < results.length; i += 1) {
      // A transient busy conflict retries once: the invariant below must
      // hold for the settled outcome, never for a half-run race.
      if (results[i].status === 'rejected' && results[i].reason?.code === 'CONFLICT') {
        results[i] = await ops[i]().then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        );
      }
      if (results[i].status === 'rejected') {
        assert.equal(results[i].reason?.code, 'ENRICHMENT_OPTED_OUT',
          `a race ends in refusal, never a raw storage error: ${results[i].reason?.message}`);
      }
    }
    const optOuts = one.modules.get('enrichment-opt-out').service
      .listWhere({ subjectResource: 'contact', subjectId: contactId });
    assert.equal(optOuts.length, 1, 'the refusal is recorded whichever side won');
    const active = one.modules.get('enriched-field').service
      .listWhere({ subjectResource: 'contact', subjectId: contactId, status: 'active' });
    assert.equal(active.length, 0, 'the purge wins over the in-flight enrichment in every order');
  }

  await raceOnce('corsa-uno');
  await raceOnce('corsa-due');
});

test('conflicting evidence becomes a candidate only: no enriched field lands on either side', async (t) => {
  const { app } = await scene(t, 'enrichment-conflict-fields');
  // Contact A owns phone P through signature enrichment.
  await app.applyContactEnrichment({
    actor: ACTOR, email: 'anna@prestigroup.example',
    fields: { firstName: 'Anna', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-a',
  });
  // Contact B exists independently.
  const created = await app.resolveChannelSender({
    channel: 'email', handle: 'bruno@prestigroup.example', email: 'bruno@prestigroup.example',
    firstName: 'Bruno', lastName: 'Bianchi', companyName: 'Presti Group', actor: ACTOR,
  });
  assert.equal(created.outcome, 'created');
  const bId = app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'email:bruno@prestigroup.example' })[0].subjectId;
  const aId = app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'email:anna@prestigroup.example' })[0].subjectId;
  const aRowsBefore = enrichedRows(app, aId).length;

  // The same tainted request names B by email and A by phone.
  const answer = await app.applyContactEnrichment({
    actor: ACTOR, email: 'bruno@prestigroup.example',
    fields: { firstName: 'X', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-b',
  });
  assert.equal(answer.candidatesWritten, 1, 'the conflict is recorded for a human');
  assert.equal(answer.applied.length, 0, 'ambiguous evidence stores no field on either side');
  assert.equal(enrichedRows(app, bId).length, 0, 'no firstName X is misattributed to B');
  assert.equal(enrichedRows(app, aId).length, aRowsBefore, 'A gains nothing from the ambiguous request');
  const candidates = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rule, 'contact-enrichment');
});

test('a conflict naming an opted-out contact writes no candidate', async (t) => {
  const { app } = await scene(t, 'enrichment-optout-conflict', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  seedPerson(fake, { resourceName: 'people/c1', emailAddresses: [{ value: 'luca@prestigroup.example' }] });
  await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  await app.optOutContactEnrichment({ actor: ACTOR, email: 'luca@prestigroup.example', reason: 'test' });

  // Contact B exists; the same Google id now carries B's email.
  const socio = await app.resolveChannelSender({
    channel: 'email', handle: 'socio@prestigroup.example', email: 'socio@prestigroup.example',
    firstName: 'Socio', lastName: 'Altro', companyName: 'Altra Srl', actor: ACTOR,
  });
  assert.equal(socio.outcome, 'created');
  const second = createFakeGoogleContacts();
  second.seedPerson({
    resourceName: 'people/c1',
    names: [{ givenName: 'Luca', familyName: 'Rossi' }],
    emailAddresses: [{ value: 'socio@prestigroup.example' }],
  });
  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: second });
  assert.equal(summary.counts.skippedOptOut, 1, 'the opted-out side refuses the candidate path');
  assert.equal(summary.counts.candidates, 0, 'no row naming the opted-out contact is written after the purge');
  const candidates = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
  assert.equal(candidates.length, 0, 'the opt-out stays final: no new row names that subject');
});

test('a conflict naming an opted-out contact on the email path writes no candidate', async (t) => {
  const { app } = await scene(t, 'enrichment-optout-conflict-email-path');
  // Contact A owns phone P through signature enrichment, then opts out.
  await app.applyContactEnrichment({
    actor: ACTOR, email: 'anna@prestigroup.example',
    fields: { firstName: 'Anna', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-a',
  });
  await app.optOutContactEnrichment({ actor: ACTOR, email: 'anna@prestigroup.example', reason: 'test' });
  // Contact B exists independently.
  const created = await app.resolveChannelSender({
    channel: 'email', handle: 'bruno@prestigroup.example', email: 'bruno@prestigroup.example',
    firstName: 'Bruno', lastName: 'Bianchi', companyName: 'Presti Group', actor: ACTOR,
  });
  assert.equal(created.outcome, 'created');
  const before = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' }).length;

  // The same tainted request names B by email and opted-out A by phone.
  await assert.rejects(
    app.applyContactEnrichment({
      actor: ACTOR, email: 'bruno@prestigroup.example',
      fields: { firstName: 'X', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-b',
    }),
    (error) => error.code === 'ENRICHMENT_OPTED_OUT');
  const after = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' }).length;
  assert.equal(after, before, 'no candidate naming the opted-out contact is written after its purge');
});

test('a google id-vs-email conflict refuses when the email side opted out', async (t) => {
  const { app } = await scene(t, 'enrichment-optout-conflict-email-side', { googleContacts: true });
  const fake = createFakeGoogleContacts();
  seedPerson(fake, { resourceName: 'people/c1', emailAddresses: [{ value: 'luca@prestigroup.example' }] });
  await app.importGoogleContacts({ actor: ACTOR, adapter: fake });

  // Contact B exists and opts out; the same Google id now carries B's email.
  const socio = await app.resolveChannelSender({
    channel: 'email', handle: 'socio@prestigroup.example', email: 'socio@prestigroup.example',
    firstName: 'Socio', lastName: 'Altro', companyName: 'Altra Srl', actor: ACTOR,
  });
  assert.equal(socio.outcome, 'created');
  await app.optOutContactEnrichment({ actor: ACTOR, email: 'socio@prestigroup.example', reason: 'test' });
  const second = createFakeGoogleContacts();
  second.seedPerson({
    resourceName: 'people/c1',
    names: [{ givenName: 'Luca', familyName: 'Rossi' }],
    emailAddresses: [{ value: 'socio@prestigroup.example' }],
  });
  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: second });
  assert.equal(summary.counts.skippedOptOut, 1, 'the opted-out email side refuses the candidate path');
  assert.equal(summary.counts.candidates, 0, 'no row naming the opted-out contact is written after the purge');
  const candidates = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
  assert.equal(candidates.length, 0, 'the opt-out stays final: no new row names that subject');
});

test('tainted evidence invents no contact: a new email with a claimed phone stays unresolved', async (t) => {
  const { app } = await scene(t, 'enrichment-tainted-new-email');
  // Contact A owns phone P through signature enrichment.
  await app.applyContactEnrichment({
    actor: ACTOR, email: 'anna@prestigroup.example',
    fields: { firstName: 'Anna', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-a',
  });
  const before = contactsCount(app);
  const aRowsBefore = enrichedRows(app, app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'email:anna@prestigroup.example' })[0].subjectId).length;

  // A brand-new email arrives carrying A's phone: ambiguous evidence.
  const answer = await app.applyContactEnrichment({
    actor: ACTOR, email: 'nuovo@prestigroup.example',
    fields: { firstName: 'Nuovo', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-n',
  });
  assert.equal(answer.outcome, 'unresolved', 'a conflict that stores nothing is never reported as created');
  assert.equal(answer.contact, null, 'no contact is invented from tainted evidence');
  assert.equal(answer.candidatesWritten, 0, 'no pair can name a subject that was never created');
  assert.deepEqual(answer.applied, [], 'ambiguous evidence stores no field anywhere');
  assert.equal(contactsCount(app), before, 'the contact count is byte-identical');
  assert.equal(
    app.modules.get('external-identity').service.listWhere({ sourceKey: 'email:nuovo@prestigroup.example' }).length,
    0, 'not even the email identity is linked');
  assert.equal(enrichedRows(app, app.modules.get('external-identity').service
    .listWhere({ sourceKey: 'email:anna@prestigroup.example' })[0].subjectId).length,
  aRowsBefore, 'A gains nothing from the ambiguous request');
});

test('a conflict between existing contacts reports candidate, never enriched', async (t) => {
  const { app } = await scene(t, 'enrichment-conflict-outcome');
  await app.applyContactEnrichment({
    actor: ACTOR, email: 'anna@prestigroup.example',
    fields: { firstName: 'Anna', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-a',
  });
  await app.resolveChannelSender({
    channel: 'email', handle: 'bruno@prestigroup.example', email: 'bruno@prestigroup.example',
    firstName: 'Bruno', lastName: 'Bianchi', companyName: 'Presti Group', actor: ACTOR,
  });
  const answer = await app.applyContactEnrichment({
    actor: ACTOR, email: 'bruno@prestigroup.example',
    fields: { firstName: 'X', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-b',
  });
  assert.equal(answer.outcome, 'candidate', 'a conflict that stores nothing is never reported as enriched');
  assert.equal(answer.candidatesWritten, 1);
  assert.deepEqual(answer.applied, []);
});

test('an import person with a new email but a claimed phone is skipped, never created', async (t) => {
  const { app } = await scene(t, 'enrichment-tainted-import', { googleContacts: true });
  await app.applyContactEnrichment({
    actor: ACTOR, email: 'anna@prestigroup.example',
    fields: { firstName: 'Anna', phone: '+393331111111' }, source: 'email-signature', sourceDetail: 'msg-a',
  });
  const before = contactsCount(app);
  const fake = createFakeGoogleContacts();
  fake.seedPerson({
    resourceName: 'people/c9',
    names: [{ givenName: 'Nuovo', familyName: 'Socio' }],
    emailAddresses: [{ value: 'nuovo@prestigroup.example' }],
    phoneNumbers: [{ canonicalForm: '+393331111111' }],
  });
  const summary = await app.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(summary.counts.created, 0, 'no contact is invented from tainted evidence');
  assert.equal(summary.counts.enriched, 0, 'a person that stores nothing is never counted as enriched');
  assert.equal(summary.counts.candidates, 0, 'no pair can name a subject that was never created');
  assert.equal(contactsCount(app), before, 'the contact count is byte-identical');
});

test('a busy database fails loudly instead of counting contention as malformed', async (t) => {
  const root = project(t, { googleContacts: true });
  const dbPath = join(root, 'data', 'enrichment-busy.sqlite');
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const holder = createAccordoApp({ dbPath });
  const importer = createAccordoApp({ dbPath, busyTimeoutMs: 0 });
  t.after(() => {
    try { holder.database.raw.exec('ROLLBACK'); } catch { /* already released */ }
    holder.close();
    importer.close();
  });

  const fake = createFakeGoogleContacts();
  seedPerson(fake);
  const first = await importer.importGoogleContacts({ actor: ACTOR, adapter: fake });
  assert.equal(first.counts.created, 1);

  // Another writer holds the write lock past the (zero) busy timeout.
  holder.database.raw.exec('BEGIN IMMEDIATE');
  const again = createFakeGoogleContacts();
  seedPerson(again, {
    resourceName: 'people/c2',
    names: [{ givenName: 'Nuova', familyName: 'Persona' }],
    emailAddresses: [{ value: 'nuova@prestigroup.example' }],
  });
  await assert.rejects(
    importer.importGoogleContacts({ actor: ACTOR, adapter: again }),
    (error) => error.code === 'CONFLICT',
    'contention aborts the run loudly: the person is never bucketed as skipped-malformed in a success receipt');
});
