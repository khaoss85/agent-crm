import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Voce c6c56dad: da una domanda nasce un campo riempito dall'AI, con fonte.
 *
 * Contesto (Kombo, rifatto in stile agentico): la persona dice l'obiettivo in
 * una frase («usano già un gestionale?») e l'agente propone il campo; la
 * persona approva, l'AI riempie dai messaggi con la fonte. Estende 434cc39a
 * (campi personalizzati) e b9f6a2b58e00 (estrazione AI con fonte).
 *
 * What it must prove, one test per acceptance line (fake AI adapters: the
 * framework never holds a key):
 * - da una domanda nasce un campo dello spazio con formato testo, sì/no o
 *   punteggio: la proposta scrive niente, la conferma definisce;
 * - ogni valore proposto ha la fonte: senza fonte il campo resta vuoto, mai
 *   inventato;
 * - i clienti nuovi vengono riempiti senza azione della persona, entro il
 *   tetto di spesa: oltre il tetto niente si scrive e l'AI non si chiama;
 * - il campo si usa in filtri e colonne come gli altri campi personalizzati.
 */

const OPERATOR = { type: 'user', id: 'scheda-op' };

const SOURCES = [
  { kind: 'channel-message', text: 'ciao, usiamo il gestionale FattureSmart da due anni', detail: 'wa:541' },
];

/** Deterministic test double: fixed answers per field key, no randomness. */
function fakeFillAdapter(answers, calls = null) {
  return {
    async extractFieldValue({ key, question, sources }) {
      if (calls) calls.push({ key, question, kinds: sources.map((source) => source.kind) });
      assert.ok(typeof key === 'string' && key !== '');
      assert.ok(typeof question === 'string' && question !== '');
      assert.ok(Array.isArray(sources) && sources.length > 0);
      return answers[key] === undefined ? {} : answers[key];
    },
  };
}

function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  for (const method of ['defineCustomField', 'listCustomFields', 'setCustomFieldValue',
    'readCustomFieldValues', 'proposeFieldFromQuestion', 'fillAiFieldValues']) {
    assert.equal(typeof app[method], 'function', `the customer-data package offers ${method}`);
  }
  return { app };
}

async function newContact(app, firstName = 'Guido') {
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  return app.services.contacts.create({
    companyId: company.id, firstName, lastName: 'Presti', email: `${firstName.toLowerCase()}@palestra-esempio.it`,
  });
}

test('da una domanda nasce un campo punteggio: la proposta scrive niente, la conferma definisce', async (t) => {
  const { app } = scene(t);
  const adapter = {
    async extractField({ question }) {
      assert.match(question, /gestionale/);
      return { label: 'Gestionale', type: 'punteggio' };
    },
  };
  const proposal = await app.proposeFieldFromQuestion({
    actor: OPERATOR, question: 'usano già un gestionale?', adapter,
  });
  assert.equal(proposal.key, 'gestionale');
  assert.equal(proposal.label, 'Gestionale');
  assert.equal(proposal.type, 'punteggio');
  assert.deepEqual(await app.listCustomFields({}), [], 'the proposal writes nothing');

  const defined = await app.defineCustomField({ actor: OPERATOR, label: proposal.label, type: proposal.type });
  assert.equal(defined.definition.key, 'gestionale');
  assert.equal(defined.replayed, false);
  assert.deepEqual((await app.listCustomFields({})).map((def) => def.type), ['punteggio']);

  await assert.rejects(
    () => app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'numero' }),
    (error) => error?.code === 'CUSTOM_FIELD_DEFINITION_CONFLICT',
    'the first decision wins: a divergent type behind the same key refuses',
  );
});

test('senza AI la proposta rifiuta; un tipo non riempibile non si propone', async (t) => {
  const { app } = scene(t);
  await assert.rejects(
    () => app.proposeFieldFromQuestion({ actor: OPERATOR, question: 'usano già un gestionale?' }),
    (error) => error?.code === 'CUSTOMER_FIELD_AI_UNAVAILABLE',
    'without an adapter the preview refuses and the manual path stays',
  );
  await assert.rejects(
    () => app.proposeFieldFromQuestion({
      actor: OPERATOR,
      question: 'quando scade?',
      adapter: { async extractField() { return { label: 'Scadenza', type: 'data' }; } },
    }),
    /solo testo/,
    'the AI proposes only testo, sì-no or punteggio',
  );
});

test('ogni valore AI ha la fonte: senza fonte il campo resta vuoto, mai inventato', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'punteggio' });
  await app.defineCustomField({ actor: OPERATOR, label: 'Amico', type: 'si-no' });
  const contact = await newContact(app);

  const outcome = await app.fillAiFieldValues({
    actor: OPERATOR,
    resource: 'contact',
    id: contact.id,
    fields: [
      { key: 'gestionale', question: 'usano già un gestionale?' },
      { key: 'amico', question: 'è un amico?' },
    ],
    sources: SOURCES,
    adapter: fakeFillAdapter({
      gestionale: { value: '72', source: 'channel-message' },
      amico: { value: 'sì' },
    }),
  });
  assert.equal(outcome.filled.length, 1);
  assert.equal(outcome.filled[0].key, 'gestionale');
  assert.equal(outcome.filled[0].value, '72');
  assert.equal(outcome.filled[0].source, 'channel-message');
  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /senza fonte/);

  const values = await app.readCustomFieldValues({ resource: 'contact', id: contact.id });
  assert.equal(values.find((entry) => entry.key === 'gestionale')?.value, '72');
  assert.equal(values.find((entry) => entry.key === 'gestionale')?.source, 'channel-message');
  assert.equal(values.find((entry) => entry.key === 'amico')?.value, null, 'no source, no value: never invented');

  const stored = app.modules.get('custom-field-value').service
    .listWhere({ subjectResource: 'contact', subjectId: contact.id, fieldKey: 'amico' });
  assert.equal(stored.length, 0, 'a sourceless proposal stores no row at all');
});

test('un valore fuori formato resta fuori: il campo resta vuoto', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'punteggio' });
  const contact = await newContact(app, 'Maria');

  const outcome = await app.fillAiFieldValues({
    actor: OPERATOR,
    resource: 'contact',
    id: contact.id,
    fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
    sources: SOURCES,
    adapter: fakeFillAdapter({ gestionale: { value: 'centocinquanta', source: 'channel-message' } }),
  });
  assert.equal(outcome.filled.length, 0);
  assert.match(outcome.skipped[0].reason, /non accetta/);
  const values = await app.readCustomFieldValues({ resource: 'contact', id: contact.id });
  assert.equal(values.find((entry) => entry.key === 'gestionale')?.value, null);

  await assert.rejects(
    () => app.setCustomFieldValue({ actor: OPERATOR, resource: 'contact', id: contact.id, key: 'gestionale', value: '150' }),
    /0 a 100/,
    'a score over 100 refuses naming the field',
  );
  const manual = await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'gestionale', value: '85%',
  });
  assert.equal(manual.value.value, '85', 'the canonical score reads as plain digits');
  assert.equal(manual.value.source, null, 'a hand-entered value carries no source');
});

test('i clienti nuovi si riempiono senza mano; oltre il tetto niente si scrive e l’AI non si chiama', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'punteggio' });
  const contact = await newContact(app);

  const open = await app.fillAiFieldValues({
    actor: OPERATOR,
    resource: 'contact',
    id: contact.id,
    fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
    sources: SOURCES,
    spendGuard: () => 'ok',
    adapter: fakeFillAdapter({ gestionale: { value: '72', source: 'channel-message' } }),
  });
  assert.equal(open.filled.length, 1, 'no human confirmation per value: the fill stores');
  const values = await app.readCustomFieldValues({ resource: 'contact', id: contact.id });
  assert.equal(values.find((entry) => entry.key === 'gestionale')?.value, '72');

  const other = await newContact(app, 'Marco');
  const calls = [];
  const capped = await app.fillAiFieldValues({
    actor: OPERATOR,
    resource: 'contact',
    id: other.id,
    fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
    sources: SOURCES,
    spendGuard: () => ({ ok: false, reason: 'tetto di spesa AI raggiunto' }),
    adapter: fakeFillAdapter({ gestionale: { value: '72', source: 'channel-message' } }, calls),
  });
  assert.equal(capped.filled.length, 0);
  assert.match(capped.skipped[0].reason, /tetto di spesa/);
  assert.equal(calls.length, 0, 'over the cap the AI is never called');
  const empty = await app.readCustomFieldValues({ resource: 'contact', id: other.id });
  assert.equal(empty.find((entry) => entry.key === 'gestionale')?.value, null);
});

test('il punteggio vive in filtri e colonne come gli altri campi', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Punteggio lead', type: 'punteggio' });
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const hot = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  });
  const cold = await app.services.contacts.create({
    companyId: company.id, firstName: 'Maria', lastName: 'Rossi', email: 'maria@palestra-esempio.it',
  });
  await app.setCustomFieldValue({ actor: OPERATOR, resource: 'contact', id: hot.id, key: 'punteggio-lead', value: '90' });

  const list = await app.listCustomers({});
  assert.ok(Array.isArray(list.customColumns));
  assert.equal(list.customColumns.find((column) => column.key === 'punteggio-lead')?.label, 'Punteggio lead');
  const row = list.items.find((item) => item.id === hot.id);
  assert.equal(row?.customFields.find((entry) => entry.key === 'punteggio-lead')?.value, '90');

  const filtered = await app.listCustomers({ campo: 'punteggio-lead', valore: '90' });
  assert.ok(filtered.items.some((item) => item.id === hot.id));
  assert.ok(!filtered.items.some((item) => item.id === cold.id));
});

test('una firma su più righe non blocca il riempimento', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'punteggio' });
  const contact = await newContact(app, 'Pietro');

  const outcome = await app.fillAiFieldValues({
    actor: OPERATOR,
    resource: 'contact',
    id: contact.id,
    fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
    sources: [{ kind: 'email-signature', text: 'Guido Presti\nPalestra Esempio\nusiamo FattureSmart', detail: 'sig:1' }],
    adapter: fakeFillAdapter({ gestionale: { value: '72', source: 'email-signature' } }),
  });
  assert.equal(outcome.filled.length, 1, 'a multiline source reads, it never rejects the fill');
  assert.equal(outcome.filled[0].value, '72');

  await assert.rejects(
    () => app.fillAiFieldValues({
      actor: OPERATOR,
      resource: 'contact',
      id: contact.id,
      fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
      sources: [{ kind: 'email-signature', text: 'riga pulita\u0000e poi un controllo' }],
      adapter: fakeFillAdapter({ gestionale: { value: '72', source: 'email-signature' } }),
    }),
    /control characters/,
    'other control characters still refuse',
  );
});

test('un guasto dell’AI si diagnostica senza mostrare i testi', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'punteggio' });
  const contact = await newContact(app, 'Paola');

  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const failure = new Error('provider down');
    failure.code = 'PROVIDER_AUTH';
    const outcome = await app.fillAiFieldValues({
      actor: OPERATOR,
      resource: 'contact',
      id: contact.id,
      fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
      sources: SOURCES,
      adapter: { async extractFieldValue() { throw failure; } },
    });
    assert.equal(outcome.filled.length, 0);
    assert.match(outcome.skipped[0].reason, /resta vuoto/, 'the user-facing reason stays generic');

    await assert.rejects(
      () => app.proposeFieldFromQuestion({
        actor: OPERATOR,
        question: 'usano già un gestionale?',
        adapter: { async extractField() { throw failure; } },
      }),
      (error) => error?.code === 'CUSTOMER_FIELD_AI_UNUSABLE',
    );
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((line) => line.includes('PROVIDER_AUTH')), 'the diagnostic names the cause');
  assert.ok(!logged.some((line) => line.includes('FattureSmart')), 'the diagnostic never echoes source text');
});

test('stesso valore, fonte diversa: la scrittura avviene e replayed resta falso (review giro 2 P2)', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'punteggio' });
  const contact = await newContact(app, 'Rita');

  await app.fillAiFieldValues({
    actor: OPERATOR,
    resource: 'contact',
    id: contact.id,
    fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
    sources: SOURCES,
    adapter: fakeFillAdapter({ gestionale: { value: '72', source: 'channel-message' } }),
  });

  const manual = await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'gestionale', value: '72',
  });
  assert.equal(manual.value.source, null, 'the hand-typed score rewrites the row with no source');
  assert.equal(manual.replayed, false, 'same digits, new provenance: a real write, never a replay');

  const refill = await app.fillAiFieldValues({
    actor: OPERATOR,
    resource: 'contact',
    id: contact.id,
    fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
    sources: SOURCES,
    adapter: fakeFillAdapter({ gestionale: { value: '72', source: 'channel-message' } }),
  });
  assert.equal(refill.filled.length, 1);
  const reread = await app.setCustomFieldValue({
    actor: OPERATOR, resource: 'contact', id: contact.id, key: 'gestionale', value: '72', source: 'channel-message',
  });
  assert.equal(reread.replayed, true, 'same value and same source: nothing rewritten, a true replay');

  const values = await app.readCustomFieldValues({ resource: 'contact', id: contact.id });
  assert.equal(values.find((entry) => entry.key === 'gestionale')?.source, 'channel-message');
});

test('scheda sconosciuta: il riempimento rifiuta senza chiamare l’AI (review giro 2 P1)', async (t) => {
  const { app } = scene(t);
  await app.defineCustomField({ actor: OPERATOR, label: 'Gestionale', type: 'punteggio' });

  const calls = [];
  const guardCalls = [];
  await assert.rejects(
    () => app.fillAiFieldValues({
      actor: OPERATOR,
      resource: 'contact',
      id: 'contatto-inesistente',
      fields: [{ key: 'gestionale', question: 'usano già un gestionale?' }],
      sources: SOURCES,
      spendGuard: () => { guardCalls.push('cap'); return 'ok'; },
      adapter: fakeFillAdapter({ gestionale: { value: '72', source: 'channel-message' } }, calls),
    }),
    (error) => error?.code === 'SUBJECT_NOT_FOUND' && error?.status === 404,
    'an unknown subject refuses instead of filling',
  );
  assert.equal(calls.length, 0, 'no spend on a missing scheda: the adapter never runs');
  assert.equal(guardCalls.length, 0, 'the cap check comes after the subject exists');
});
