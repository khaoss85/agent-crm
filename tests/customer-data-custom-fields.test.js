import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Voce 434cc39a: custom fields — the operator-decided scheda properties.
 *
 * A scheda has the properties its space decided: the operator adds a field
 * once («+ Aggiungi campo») and the field reads on every scheda, in the
 * filters and in the list columns. The AI way in («✦ Scrivi o incolla»)
 * parses one Italian sentence into the base customer plus proposals, shows
 * the preview, and only the human confirmation writes.
 *
 * What it must prove (MEM_ACC_REUSE: no new table, no master customer row —
 * two managed record modules beside the records the packages already own):
 * - from the example sentence the preview proposes name, email, phone and
 *   the new «amico» sì/no field; the confirm stores the customer with those
 *   values (fake AI adapter: the framework never holds a key);
 * - «+ Aggiungi campo» reads space-wide: in every scheda, in the filters
 *   and in the columns;
 * - an edit rewrites the value and reads back after the reload (one row);
 * - without the AI the ✦ area stays hidden: the preview refuses with
 *   CUSTOMER_PHRASE_AI_UNAVAILABLE and the manual path works;
 * - the Nuovo cliente note lands in the cronologia through the existing
 *   subject-note endpoint (the apply never writes it: single writer).
 */

const OPERATOR = { type: 'user', id: 'scheda-op' };

/** Deterministic test double: regexes over the sentence, no randomness. */
function fakeAdapterFor(answer) {
  return {
    async extractCustomer({ text }) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      return answer;
    },
  };
}

const EXAMPLE_ANSWER = {
  firstName: 'daniele',
  lastName: 'pelleri',
  email: 'daniele@gmail.com',
  phone: '234341',
  note: 'prefers email',
  fields: [{ key: 'amico', label: 'Amico', type: 'si-no', value: 'sì' }],
};

function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  for (const method of ['defineCustomField', 'listCustomFields', 'setCustomFieldValue',
    'readCustomFieldValues', 'parseCustomerPhrase', 'applyCustomerPhrase',
    'customerPhraseAiAvailable']) {
    assert.equal(typeof app[method], 'function', `the customer-data package offers ${method}`);
  }
  return { app };
}

test('the example sentence previews name, email, phone and the new «amico» field, and the confirm stores them', async (t) => {
  const { app } = scene(t);
  const preview = await app.parseCustomerPhrase({
    actor: OPERATOR,
    phrase: 'daniele pelleri email daniele@gmail.com tel 234341 amico sì',
    adapter: fakeAdapterFor(EXAMPLE_ANSWER),
  });
  assert.equal(preview.customer.firstName, 'daniele');
  assert.equal(preview.customer.lastName, 'pelleri');
  assert.equal(preview.customer.email, 'daniele@gmail.com');
  assert.equal(preview.customer.phone, '234341');
  assert.equal(preview.note, 'prefers email');
  assert.equal(preview.fields.length, 1);
  assert.equal(preview.fields[0].key, 'amico');
  assert.equal(preview.fields[0].label, 'Amico');
  assert.equal(preview.fields[0].type, 'si-no');
  assert.equal(preview.fields[0].value, 'sì');
  assert.equal(preview.fields[0].isNew, true);
  assert.equal(preview.newFields, 1);

  const applied = await app.applyCustomerPhrase({
    actor: OPERATOR, customer: preview.customer, fields: preview.fields,
  });
  assert.equal(applied.subject.resource, 'contact');
  assert.ok(applied.subject.id);
  assert.equal(applied.phoneWarning, null);
  assert.equal(applied.fields.length, 1);
  assert.equal(applied.fields[0].key, 'amico');
  assert.equal(applied.fields[0].value, 'sì');

  const values = await app.readCustomFieldValues({
    resource: applied.subject.resource, id: applied.subject.id,
  });
  assert.equal(values.length, 1);
  assert.equal(values[0].key, 'amico');
  assert.equal(values[0].value, 'sì');
});

test('+ Aggiungi campo reads space-wide: every scheda, the filters and the columns', async (t) => {
  const { app } = scene(t);
  const defined = await app.defineCustomField({ actor: OPERATOR, label: 'Amico', type: 'si-no' });
  assert.equal(defined.definition.key, 'amico');
  assert.equal(defined.replayed, false);
  const replayed = await app.defineCustomField({ actor: OPERATOR, label: 'Amico', type: 'si-no' });
  assert.equal(replayed.replayed, true, 'retrying the identical definition replays, never doubles');

  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  });
  const other = await app.services.contacts.create({
    companyId: company.id, firstName: 'Maria', lastName: 'Rossi', email: 'maria@palestra-esempio.it',
  });
  await app.setCustomFieldValue({ actor: OPERATOR, resource: 'contact', id: contact.id, key: 'amico', value: 'sì' });

  const mine = await app.readCustomFieldValues({ resource: 'contact', id: contact.id });
  assert.equal(mine.find((entry) => entry.key === 'amico')?.value, 'sì');
  const theirs = await app.readCustomFieldValues({ resource: 'contact', id: other.id });
  assert.equal(theirs.find((entry) => entry.key === 'amico')?.value, null, 'every scheda reads the field, unset here');

  const list = await app.listCustomers({});
  assert.ok(Array.isArray(list.customColumns));
  assert.equal(list.customColumns.find((column) => column.key === 'amico')?.label, 'Amico');
  const row = list.items.find((item) => item.id === contact.id);
  assert.equal(row?.customFields.find((entry) => entry.key === 'amico')?.value, 'sì');

  const filtered = await app.listCustomers({ campo: 'amico', valore: 'sì' });
  assert.ok(filtered.items.some((item) => item.id === contact.id));
  assert.ok(!filtered.items.some((item) => item.id === other.id));

  await assert.rejects(
    () => app.listCustomers({ campo: 'fantasma' }),
    (error) => error?.code === 'CUSTOM_FIELD_UNKNOWN',
    'a filter over an unknown field refuses instead of answering an empty page',
  );
});

test('an edit rewrites the single row: the reload reads the edit', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Amico', type: 'si-no' });
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  });
  const first = await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'amico', value: 'sì',
  });
  assert.equal(first.replayed, false);
  const second = await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'amico', value: 'no',
  });
  assert.equal(second.replayed, false);
  assert.equal(second.value.value, 'no');

  const stored = app.modules.get('custom-field-value').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id, fieldKey: 'amico' });
  assert.equal(stored.length, 1, 'one row per subject and field, never a second row');
  const values = await app.readCustomFieldValues({ resource: 'contact', id: contact.id });
  assert.equal(values.find((entry) => entry.key === 'amico')?.value, 'no');

  await assert.rejects(
    () => app.setCustomFieldValue({ actor: OPERATOR, resource: 'contact', id: contact.id, key: 'sconosciuto', value: 'x' }),
    (error) => error?.code === 'CUSTOM_FIELD_UNKNOWN',
    'a value without a definition refuses: the framework never invents a field',
  );
});

test('without the AI the ✦ area stays hidden and the manual path works', async (t) => {
  const { app } = scene(t);
  const probe = await app.customerPhraseAiAvailable({});
  assert.equal(probe.available, false, 'the reference composition wires no adapter: the admin hides ✦');

  await assert.rejects(
    () => app.parseCustomerPhrase({ actor: OPERATOR, phrase: 'daniele pelleri email daniele@gmail.com' }),
    (error) => error?.code === 'CUSTOMER_PHRASE_AI_UNAVAILABLE' && error?.status === 503,
    'no adapter, no run: the preview refuses instead of running anything',
  );

  const probeWithFake = await app.customerPhraseAiAvailable({ adapter: fakeAdapterFor(EXAMPLE_ANSWER) });
  assert.equal(probeWithFake.available, true);

  const defined = await app.defineCustomField({ actor: OPERATOR, label: 'Livello', type: 'scelta', options: ['base', 'pro'] });
  assert.equal(defined.definition.key, 'livello');
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Daniele', lastName: 'Pelleri', email: 'daniele@gmail.com',
  });
  await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'livello', value: 'pro',
  });
  const values = await app.readCustomFieldValues({ resource: 'contact', id: contact.id });
  assert.equal(values.find((entry) => entry.key === 'livello')?.value, 'pro');
});

test('an E.164 phrase phone links through the governed phone path and reads on the list row', async (t) => {
  const { app } = scene(t);
  const answer = { ...EXAMPLE_ANSWER, phone: '+393331234567' };
  const preview = await app.parseCustomerPhrase({
    actor: OPERATOR,
    phrase: 'daniele pelleri email daniele@gmail.com tel +393331234567 amico sì',
    adapter: fakeAdapterFor(answer),
  });
  const applied = await app.applyCustomerPhrase({
    actor: OPERATOR, customer: preview.customer, fields: preview.fields,
  });
  assert.equal(applied.phoneLinked, true, 'the governed phone operation takes the E.164 number');
  assert.equal(applied.phoneWarning, null);
  const list = await app.listCustomers({});
  const row = list.items.find((item) => item.id === applied.subject.id);
  assert.equal(row?.phone?.value, '+393331234567', 'the list shows the confirmed phone, never null');
  assert.equal(row?.phone?.system, 'phone', 'a recognized phone system, so the scheda can dial it');
});

test('a company-only phrase keeps its confirmed phone: no email, no drop', async (t) => {
  const { app } = scene(t);
  const preview = await app.parseCustomerPhrase({
    actor: OPERATOR,
    phrase: 'acme azienda tel +393331112223',
    adapter: fakeAdapterFor({
      firstName: 'Acme',
      companyName: 'Acme',
      phone: '+393331112223',
      fields: [],
    }),
  });
  assert.equal(preview.customer.companyName, 'Acme');
  assert.equal(preview.customer.email, null);
  const applied = await app.applyCustomerPhrase({
    actor: OPERATOR, customer: preview.customer, fields: preview.fields,
  });
  assert.equal(applied.phoneLinked, true, 'the company subject links the phone like a contact');
  assert.equal(applied.phoneWarning, null, 'nothing the human confirmed is dropped');
  const list = await app.listCustomers({});
  const row = list.items.find((item) => item.id === applied.subject.id);
  assert.equal(row?.phone?.value, '+393331112223', 'the list shows the confirmed phone, never null');
  assert.equal(row?.phone?.system, 'phone', 'a recognized phone system, so the scheda can dial it');
});

test('a JSON-shaped adapter from the wire never switches the phrase AI on', async (t) => {
  const { app } = scene(t);
  // A JSON body can never carry a function: `{}` must read exactly like no
  // adapter at all, so a caller cannot force the ✦ area on — or the AI off
  // when the host composes its own. The probe discriminates the regression
  // (a bare `{}` used to read as available:true); the preview locks the 503.
  const probe = await app.customerPhraseAiAvailable({ adapter: {} });
  assert.equal(probe.available, false, 'a JSON-shaped adapter never switches the AI on');
  await assert.rejects(
    () => app.parseCustomerPhrase({
      actor: OPERATOR,
      phrase: 'daniele pelleri email daniele@gmail.com',
      adapter: {},
    }),
    (error) => error?.code === 'CUSTOMER_PHRASE_AI_UNAVAILABLE' && error?.status === 503,
    'a forged adapter cannot stand in for the composed one',
  );
});

test('a refused field value rolls the whole phrase apply back: no customer, no definitions, no values', async (t) => {
  const { app } = scene(t);
  const countBefore = (await app.listCustomers({})).items.length;
  await assert.rejects(
    () => app.applyCustomerPhrase({
      actor: OPERATOR,
      customer: { firstName: 'daniele', lastName: 'pelleri', email: 'daniele@gmail.com' },
      fields: [
        { key: 'amico', label: 'Amico', type: 'si-no', value: 'sì' },
        { key: 'livello-num', label: 'Livello num', type: 'numero', value: 'non-un-numero' },
      ],
    }),
    (error) => error?.code === 'VALIDATION_ERROR',
    'the bad numeric value refuses the whole confirmation',
  );
  assert.equal((await app.listCustomers({})).items.length, countBefore, 'no partial customer survives');
  assert.deepEqual(await app.listCustomFields({}), [], 'no partial definition survives');
});

test('past 500 definitions every key still reads: columns and the campo filter see the oldest key', async (t) => {
  const { app } = scene(t);
  const total = 503;
  for (let index = 0; index < total; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await app.defineCustomField({ actor: OPERATOR, key: `extra-${index}`, label: `Extra ${index}`, type: 'testo' });
  }
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  });
  await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'extra-0', value: 'primo',
  });
  const list = await app.listCustomers({});
  assert.equal(list.customColumns.length, total, 'every defined field is a column, not a 500-row page');
  assert.ok(list.customColumns.some((column) => column.key === 'extra-0'), 'the oldest key is still listed');
  const filtered = await app.listCustomers({ campo: 'extra-0', valore: 'primo' });
  assert.ok(filtered.items.some((item) => item.id === contact.id), 'a filter over an old key matches');
});

test('an unreadable value store refuses a campo filter instead of an exact-looking empty page', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Amico', type: 'si-no' });
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  });
  await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'amico', value: 'sì',
  });
  const service = app.modules.get('custom-field-value').service;
  const original = service.listWhere.bind(service);
  service.listWhere = async () => { throw new Error('boom-storage'); };
  try {
    await assert.rejects(
      () => app.listCustomers({ campo: 'amico', valore: 'sì' }),
      (error) => error?.code === 'CUSTOMER_LIST_UNAVAILABLE' && error?.status === 409,
      'with a filter the failure refuses instead of answering an exact empty page',
    );
    const open = await app.listCustomers({});
    assert.ok(open.items.length >= 1, 'without a filter the list still reads, with null values');
  } finally {
    service.listWhere = original;
  }
});

test('the Nuovo cliente note lands in the cronologia through the single writer', async (t) => {
  const { app } = scene(t);
  const preview = await app.parseCustomerPhrase({
    actor: OPERATOR,
    phrase: 'daniele pelleri email daniele@gmail.com tel 234341 amico sì',
    adapter: fakeAdapterFor(EXAMPLE_ANSWER),
  });
  const applied = await app.applyCustomerPhrase({
    actor: OPERATOR, customer: preview.customer, fields: preview.fields,
  });
  const before = await app.readCustomFieldValues({
    resource: applied.subject.resource, id: applied.subject.id,
  });
  assert.ok(!before.some((entry) => entry.key === 'note'), 'the apply writes values, never the note');

  const note = await app.recordSubjectNote({
    actor: OPERATOR, resource: applied.subject.resource, id: applied.subject.id, body: preview.note,
  });
  assert.ok(note, 'the note is recorded');
  const activities = app.modules.get('work-activity').service.list({ limit: 500 });
  const mine = activities.filter((row) => row?.kind === 'note'
    && row?.subjectResource === applied.subject.resource && row?.subjectId === applied.subject.id);
  assert.equal(mine.length, 1, 'exactly the one note, beside the customer');
  assert.ok(String(mine[0]?.body ?? '').includes('prefers email'), 'the note reads back for the scheda cronologia');
});
