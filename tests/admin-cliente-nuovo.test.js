import test from 'node:test';
import { readFileSync } from 'node:fs';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import {
  CLIENTI_NUOVO_ROUTE,
  MANUAL_IMPORT_SYSTEM,
  MANUAL_PHONE_SYSTEM,
  NEW_CUSTOMER_DRAFT_KEY,
  NEW_CUSTOMER_DRAFT_TTL_MS,
  NOTE_NOT_SAVED_WARNING,
  applyRefusalText,
  clearNewCustomerDraft,
  createCustomerFormView,
  isNewCustomerSessionLoss,
  newCustomerDraftKey,
  normalizeResumeEmail,
  normalizeTelefono,
  readNewCustomerDraft,
  saveNewCustomerDraft,
  customerNames,
  sameCustomerNames,
  splitNome,
  stepNeedsRun,
  tabDraftStorage,
  validateCustomerForm,
} from '../apps/admin/public/admin-cliente-nuovo.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The "Nuovo cliente" form (backlog:273de560), against a stub server.
 *
 * What it must prove: "Compila manualmente" opens a customer form (nome,
 * email, telefono, azienda, stato) with Salva and Annulla — never the JSON
 * import tool. Salva creates through the same governed import-apply
 * operation and lands on the new scheda; field errors read in Italian next
 * to the field. Annulla leaves without writing.
 */

const flush = async (times = 24) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

function stubClient(handler) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      let body = options?.body ?? {};
      if (typeof body === 'string') {
        try { body = body === '' ? {} : JSON.parse(body); } catch { /* keep raw */ }
      }
      calls.push({ path, method: options?.method ?? 'GET', body });
      return handler(path, body);
    },
  };
}

const accepted = (subject = { id: 'c1', resource: 'contact' }, reasonCode = 'CREATED_RECORD') => ({
  receipts: [{ outcome: 'accepted', reasonCode, subject }],
});

const render = (client, deps = {}) => {
  const doc = createFakeDocument();
  const mount = createMount();
  let navigated = null;
  const notes = [];
  const view = createCustomerFormView({
    doc,
    mount,
    client,
    navigate: (hash) => { navigated = hash; },
    notify: (message) => { notes.push(message); },
    ...deps,
  });
  return { doc, mount, view, notes, navigated: () => navigated };
};

const field = (mount, name) => mount.findAll('input').find((node) => node.getAttribute('name') === name)
  ?? mount.findAll('select').find((node) => node.getAttribute('name') === name)
  ?? mount.findAll('textarea').find((node) => node.getAttribute('name') === name);

const errorFor = (mount, name) => mount.findAll('small').find((node) => node.getAttribute('data-field') === name);

const setValue = (mount, name, value) => { field(mount, name).value = value; };

const appliesOf = (client) => client.calls.filter((call) => call.path === '/api/customer-data/import/apply');
const notesOf = (client) => client.calls.filter((call) => call.path === '/api/customer-hub/notes');
const valuesOf = (client) => client.calls.filter((call) => call.path === '/api/customer-data/fields/value');

const clickSave = (mount) => {
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-customer').dispatch('click');
};

test('splitNome and normalizeTelefono prepare the governed row', () => {
  assert.deepEqual(splitNome('Mario Rossi'), { firstName: 'Mario', lastName: 'Rossi' });
  assert.deepEqual(splitNome('  Mario   Rossi Verdi  '), { firstName: 'Mario', lastName: 'Rossi Verdi' });
  assert.deepEqual(splitNome(''), { firstName: '', lastName: '' });
  assert.equal(normalizeTelefono('+39 333 123-4567'), '+393331234567');
  assert.equal(normalizeTelefono('(02) 1234 5678'), '0212345678');
});

test('validateCustomerForm refuses empty identity with Italian errors', () => {
  assert.deepEqual(validateCustomerForm({ nome: '', email: '', telefono: '', azienda: '' }), {
    nome: 'Il nome è obbligatorio.',
    general: 'Indica almeno l\u2019email o l\u2019azienda: senza, non si sa chi è il cliente.',
  });
  const badEmail = validateCustomerForm({ nome: 'Mario', email: 'mario@', telefono: '', azienda: '' });
  assert.match(badEmail.email, /non sembra valida/);
  const badPhone = validateCustomerForm({ nome: 'Mario', email: 'm@m.it', telefono: 'abc', azienda: '' });
  assert.match(badPhone.telefono, /cifre/);
  const phoneNoEmail = validateCustomerForm({ nome: 'Mario', email: '', telefono: '+393331234567', azienda: '' });
  assert.match(phoneNoEmail.telefono, /Senza email/);
  assert.deepEqual(validateCustomerForm({ nome: 'Mario', email: 'm@m.it', telefono: '', azienda: '' }), {});
});

test('the form renders every field with Salva and Annulla, in Italian', async () => {
  const { mount, view } = render(stubClient(() => accepted()));
  await view.render();
  for (const name of ['nome', 'cognome', 'email', 'telefono', 'azienda', 'nota']) {
    assert.ok(field(mount, name), `the ${name} control renders`);
    assert.ok(errorFor(mount, name), `the ${name} error slot renders`);
  }
  // backlog:ff8bb60f417f: no Stato — nothing stores it and Modifica has none.
  assert.equal(field(mount, 'stato'), undefined, 'no Stato field');
  const buttons = mount.findAll('button').map((node) => node.textContent);
  assert.ok(buttons.includes('Salva'), 'Salva renders');
  assert.ok(buttons.includes('Annulla'), 'Annulla renders');
  for (const marker of ['Customer Data Operations', 'Rimandato a', 'JSON', 'Righe (', 'Anteprima']) {
    assert.ok(!mount.textContent.includes(marker), `no developer surface names ${JSON.stringify(marker)}`);
  }
});

test('Salva with an empty form shows Italian errors and writes nothing', async () => {
  const client = stubClient(() => accepted());
  const { mount, view } = render(client);
  await view.render();
  clickSave(mount);
  await flush();
  assert.equal(appliesOf(client).length, 0, 'no request leaves the browser before the form is valid');
  assert.match(errorFor(mount, 'nome').textContent, /obbligatorio/);
  assert.match(mount.textContent, /non si sa chi è il cliente/);
});

test('Salva creates the customer and lands on its scheda', async () => {
  const client = stubClient(() => accepted());
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'azienda', 'Palestra Esempio');
  clickSave(rendered.mount);
  await flush();
  const applies = appliesOf(client);
  assert.equal(applies.length, 1, 'one governed apply, not a parallel creation');
  assert.equal(applies[0].body.system, MANUAL_IMPORT_SYSTEM);
  assert.deepEqual(applies[0].body.rows, [{
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario@esempio.it',
    companyName: 'Palestra Esempio',
  }]);
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1');
});

test('Salva notifies onSaved so the Clienti badge recounts at once (f0d425d0)', async () => {
  const client = stubClient(() => accepted());
  let saved = 0;
  const rendered = render(client, { onSaved: () => { saved += 1; } });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1');
  assert.equal(saved, 1, 'the shell recounts the badge without leaving the page');
});

test('a refused apply never notifies onSaved (f0d425d0)', async () => {
  const client = stubClient(() => ({ receipts: [{ outcome: 'rejected', reasonCode: 'AMBIGUOUS_CANDIDATES', subject: null }] }));
  let saved = 0;
  const rendered = render(client, { onSaved: () => { saved += 1; } });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda without a created subject');
  assert.equal(saved, 0, 'no recount without a created customer');
});

test('a throwing onSaved never blocks the landing on the scheda (f0d425d0)', async () => {
  const client = stubClient(() => accepted());
  const rendered = render(client, { onSaved: () => { throw new Error('badge offline'); } });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1');
});

test('a refused note still notifies onSaved: the customer exists (f0d425d0)', async () => {
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      throw Object.assign(new Error('Scrittura del pannello rifiutata'), { status: 400, code: 'BO_CRM_BODY_REFUSED' });
    }
    return accepted({ id: 'c7', resource: 'contact' }, 'CREATED_RECORD');
  });
  let saved = 0;
  const rendered = render(client, { onSaved: () => { saved += 1; } });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', 'Una nota.');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'the operator stays on the form to read the warning');
  assert.equal(saved, 1, 'the badge recounts the created customer at once');
});

test('Salva links the phone with a second single-row apply', async () => {
  const client = stubClient((path, body) => {
    if (body.system === MANUAL_PHONE_SYSTEM) return accepted({ id: 'c1', resource: 'contact' }, 'MATCHED_EXISTING');
    return accepted({ id: 'c1', resource: 'contact' }, 'MATCHED_EXISTING');
  });
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'telefono', '+39 333 1234567');
  clickSave(rendered.mount);
  await flush();
  const applies = appliesOf(client);
  assert.equal(applies.length, 2, 'record first, phone-bearing identity second');
  assert.equal(applies[1].body.system, MANUAL_PHONE_SYSTEM);
  assert.equal(applies[1].body.rows[0].externalId, '+393331234567');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1');
  assert.ok(rendered.notes.some((note) => note.includes('senza duplicati')), 'a matched scheda warns instead of duplicating');
});

test('Salva navigates on the real created-row receipt: accepted, willCreate, named subject (backlog:273de560)', async () => {
  const client = stubClient(() => ({
    receipts: [{ outcome: 'accepted', reasonCode: 'CREATED_RECORD', willCreate: true, subject: { id: 'c9', resource: 'contact' } }],
  }));
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9');
});

test('a refused apply keeps the operator on the form with an Italian reason', async () => {
  const client = stubClient(() => ({ receipts: [{ outcome: 'rejected', reasonCode: 'AMBIGUOUS_CANDIDATES', subject: null }] }));
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda without a created subject');
  assert.match(rendered.mount.textContent, /doppioni/);
  assert.match(applyRefusalText({ reasonCode: 'MISSING_REQUIRED_IDENTITY' }), /non si sa chi è/);
});

test('Annulla navigates back to the list without writing', async () => {
  const client = stubClient(() => accepted());
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  rendered.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-customer').dispatch('click');
  await flush();
  // backlog:ff8bb60f417f: with text typed, Annulla asks first.
  rendered.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'discard-customer').dispatch('click');
  await flush();
  assert.equal(appliesOf(client).length, 0, 'Annulla writes nothing');
  assert.equal(rendered.navigated(), '#/customer-data');
});

test('a leaving route invalidates the form so a late save cannot clear the next screen', async () => {
  const client = stubClient(() => accepted());
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  rendered.view.invalidate();
  await flush();
  assert.equal(rendered.navigated(), null, 'the invalidated save never navigates onto the next screen');
  assert.equal(rendered.mount.findAll('div').filter((node) => node.getAttribute('data-customer-panel') === 'open').length, 0,
    'leaving the route closes the window');
});

test('CLIENTI_NUOVO_ROUTE never points at the import tool', () => {
  assert.equal(CLIENTI_NUOVO_ROUTE, '#/clienti/nuovo');
  assert.ok(!CLIENTI_NUOVO_ROUTE.includes('import'));
});

const PHRASE_PREVIEW = {
  customer: { firstName: 'Daniele', lastName: 'Pelleri', email: 'daniele@gmail.com', phone: '234341', companyName: null },
  note: null,
  fields: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [], value: 'sì', isNew: true }],
  newFields: 1,
};

const phraseClient = ({ ai = true, defs = [] } = {}) => stubClient((path, body) => {
  if (path === '/api/customer-data/phrase/ai-available') return { available: ai };
  if (path === '/api/customer-data/fields') return { definitions: defs };
  if (path === '/api/customer-data/phrase/preview') return PHRASE_PREVIEW;
  if (path === '/api/customer-data/phrase/apply') {
    return { subject: { resource: 'contact', id: 'c7' }, matchedExisting: false, phoneLinked: true, phoneWarning: null, fields: [] };
  }
  if (path === '/api/customer-data/fields/define') {
    return { definition: { key: 'amico', label: 'Amico', type: 'si-no', options: [] }, replayed: false };
  }
  if (path === '/api/customer-data/fields/value') return { value: { key: body.key, value: body.value } };
  if (path === '/api/customer-hub/notes') return { note: { id: 'n1' } };
  return accepted({ id: 'c7', resource: 'contact' }, 'CREATED_RECORD');
});

const clickAction = (mount, action) => {
  mount.findAll('button').find((node) => node.getAttribute('data-action') === action).dispatch('click');
};

test('without the AI the ✦ area stays hidden and the manual path works', async () => {
  const client = phraseClient({ ai: false });
  const rendered = render(client);
  await rendered.view.render();
  assert.ok(!rendered.mount.textContent.includes('Scrivi o incolla'), 'no ✦ area without the adapter');
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'the manual path saves alone');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7');
});

test('with the AI the ✦ area previews the example sentence and Conferma stores it', async () => {
  const client = phraseClient({ ai: true });
  const rendered = render(client);
  await rendered.view.render();
  assert.ok(rendered.mount.textContent.includes('Scrivi o incolla'), 'the ✦ area renders when the AI is on');
  const frase = rendered.mount.findAll('textarea').find((node) => node.getAttribute('name') === 'frase');
  frase.value = 'daniele pelleri email daniele@gmail.com tel 234341 amico sì';
  clickAction(rendered.mount, 'preview-phrase');
  await flush();
  assert.ok(rendered.mount.textContent.includes('Daniele'), 'the preview names the customer');
  assert.ok(rendered.mount.textContent.includes('Amico'), 'the preview names the new field');
  assert.ok(rendered.mount.textContent.includes('campo nuovo'), 'the preview says which fields it creates');
  clickAction(rendered.mount, 'apply-phrase');
  await flush();
  const applies = client.calls.filter((call) => call.path === '/api/customer-data/phrase/apply');
  assert.equal(applies.length, 1, 'the confirm stores through phrase/apply');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7');
});

test('the Nuovo cliente note lands in the cronologia through the single writer', async () => {
  const client = phraseClient({ ai: false });
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', 'Ci ha conosciuti in palestra.');
  clickSave(rendered.mount);
  await flush();
  assert.equal(notesOf(client).length, 1, 'one note through POST /api/customer-hub/notes');
  // Production 07/11: exactly the scheda's «Aggiungi nota» shape — the note
  // travels as `body`; `text` was refused 400 BO_CRM_BODY_REFUSED by the /bo
  // edge, which reads `resource`, `id` and `body` only.
  assert.deepEqual(notesOf(client)[0].body, { resource: 'contact', id: 'c7', body: 'Ci ha conosciuti in palestra.' });
  assert.deepEqual(Object.keys(notesOf(client)[0].body).sort(), ['body', 'id', 'resource'],
    'no extra or missing key: the same three keys the scheda sends');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7');
});

test('a refused note says so beside the form and keeps the way to the created scheda (production 07/11)', async () => {
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      throw Object.assign(new Error('Scrittura del pannello rifiutata'), { status: 400, code: 'BO_CRM_BODY_REFUSED' });
    }
    return accepted({ id: 'c7', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', 'Una nota.');
  clickSave(rendered.mount);
  await flush();
  const warning = rendered.mount.findAll('p').find((node) => node.getAttribute('data-note-warning') !== null);
  assert.ok(warning, 'the warning line sits in the form');
  assert.ok(warning.textContent.includes(NOTE_NOT_SAVED_WARNING), 'the warning reads beside the form, never silent');
  assert.equal(NOTE_NOT_SAVED_WARNING, 'Cliente creato, ma la nota non è stata salvata: aggiungila dalla scheda.');
  assert.equal(rendered.navigated(), null, 'the operator stays on the form to read it');
  const saveButton = rendered.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-customer');
  assert.equal(saveButton.disabled, true, 'Salva stays off: the customer already exists');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'a second Salva writes nothing');
  clickAction(rendered.mount, 'open-created-card');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7', 'Apri la scheda lands on the created customer');
});

test('review #654: the note-refused lock lifts as soon as the operator types again', async () => {
  let applies = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      throw Object.assign(new Error('Scrittura del pannello rifiutata'), { status: 400, code: 'BO_CRM_BODY_REFUSED' });
    }
    applies += 1;
    return accepted({ id: `c${applies}`, resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', 'Una nota.');
  clickSave(rendered.mount);
  await flush();
  const saveButton = rendered.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-customer');
  assert.equal(saveButton.disabled, true, 'locked right after the refusal');
  // Another customer: typing lifts the lock and Salva creates it.
  setValue(rendered.mount, 'nome', 'Anna Bianchi');
  field(rendered.mount, 'nome').dispatch('input');
  setValue(rendered.mount, 'email', 'anna@esempio.it');
  setValue(rendered.mount, 'nota', '');
  assert.equal(saveButton.disabled, false, 'typing lifts the lock');
  const warning = rendered.mount.findAll('p').find((node) => node.getAttribute('data-note-warning') !== null);
  assert.equal(warning.textContent, '', 'the old warning leaves with the lock');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 2, 'the other customer is created, no reload needed');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c2');
});

test('review #654 giro 3: changing only a custom field lifts the note-refused lock', async () => {
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] };
    if (path === '/api/customer-hub/notes') {
      throw Object.assign(new Error('Scrittura del pannello rifiutata'), { status: 400, code: 'BO_CRM_BODY_REFUSED' });
    }
    if (path === '/api/customer-data/fields/value') return { value: { key: 'amico', value: 'sì' } };
    return accepted({ id: 'c7', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', 'Una nota.');
  clickSave(rendered.mount);
  await flush();
  const saveButton = rendered.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-customer');
  assert.equal(saveButton.disabled, true, 'locked after the refusal');
  const amico = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  amico.value = 'sì';
  amico.dispatch('change');
  assert.equal(saveButton.disabled, false, 'a custom field change lifts the lock');
});

test('review #654 giro 3: after a refused phrase note Conferma stays, and a second press retries the note', async () => {
  let notes = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: true };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-data/phrase/preview') return { ...PHRASE_PREVIEW, note: 'Amico di Guido.' };
    if (path === '/api/customer-data/phrase/apply') {
      return { subject: { resource: 'contact', id: 'c7' }, matchedExisting: notes > 0, phoneLinked: true, phoneWarning: null, fields: [] };
    }
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) throw Object.assign(new Error('Scrittura del pannello rifiutata'), { status: 400, code: 'BO_CRM_BODY_REFUSED' });
      return { note: { id: 'n1' } };
    }
    return accepted({ id: 'c7', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client);
  await rendered.view.render();
  rendered.mount.findAll('textarea').find((node) => node.getAttribute('name') === 'frase').value = 'daniele pelleri amico di guido';
  clickAction(rendered.mount, 'preview-phrase');
  await flush();
  clickAction(rendered.mount, 'apply-phrase');
  await flush();
  const confirm = rendered.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'apply-phrase');
  assert.ok(confirm && confirm.hidden !== true, 'Conferma stays on screen after the refused note');
  assert.equal(rendered.navigated(), null, 'the operator stays to read the warning');
  clickAction(rendered.mount, 'apply-phrase');
  await flush();
  assert.equal(notes, 2, 'the second press retries the note');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7');
});

test('+ Aggiungi campo creates a space field and its control reads on the form', async () => {
  const client = phraseClient({ ai: false });
  const rendered = render(client);
  await rendered.view.render();
  clickAction(rendered.mount, 'add-field');
  await flush();
  const label = rendered.mount.findAll('input').find((node) => node.getAttribute('name') === 'nuovo-campo-label');
  label.value = 'Amico';
  clickAction(rendered.mount, 'create-field');
  await flush();
  const defines = client.calls.filter((call) => call.path === '/api/customer-data/fields/define');
  assert.equal(defines.length, 1, 'one governed define');
  assert.equal(defines[0].body.label, 'Amico');
  assert.ok(rendered.notes.some((note) => note.includes('tutte le schede')), 'the confirm says the field is space-wide');
});

test('a manual custom value rides the save beside the customer', async () => {
  const client = phraseClient({ ai: false, defs: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] });
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  const control = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  assert.ok(control, 'the space field reads on the form');
  control.value = 'sì';
  clickSave(rendered.mount);
  await flush();
  assert.equal(valuesOf(client).length, 1, 'one governed value write');
  assert.deepEqual(valuesOf(client)[0].body, { resource: 'contact', id: 'c7', key: 'amico', value: 'sì' });
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7');
});

/**
 * B4 (backlog:5a40c73e54aa): with an expired session, Salva keeps the long
 * note, asks for a new sign-in, and offers the text back after it.
 */
const memoryStore = () => {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
};

const LONG_NOTE = 'Ci ha conosciuti in palestra, cerca un pacchetto da tre allenamenti a settimana. '
  .repeat(12);

const sessionLost = () => {
  const error = new Error('Workspace membership required');
  error.status = 403;
  error.code = 'SHARED_MEMBERSHIP_REFUSED';
  return Promise.reject(error);
};

test('isNewCustomerSessionLoss names only the failures a login can cure', () => {
  assert.equal(isNewCustomerSessionLoss({ status: 401, code: 'UNKNOWN' }), true);
  assert.equal(isNewCustomerSessionLoss({ status: 403, code: 'SHARED_MEMBERSHIP_REFUSED' }), true);
  assert.equal(isNewCustomerSessionLoss({ status: 403, code: 'SESSION_EXPIRED' }), true);
  assert.equal(isNewCustomerSessionLoss({ status: 403, code: 'BO_SPACE_MISMATCH' }), false);
  assert.equal(isNewCustomerSessionLoss({ status: 500, code: 'UNKNOWN' }), false);
  assert.equal(isNewCustomerSessionLoss(new Error('boom')), false);
});

test('Salva with an expired session keeps the long note and asks to sign in again', async () => {
  const store = memoryStore();
  const client = stubClient(() => sessionLost());
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda without a write');
  assert.match(rendered.mount.textContent, /Sessione scaduta/, 'the form names the expired session');
  assert.match(rendered.mount.textContent, /conservato/, 'the form says the text is kept');
  const draft = readNewCustomerDraft(store);
  assert.ok(draft, 'the draft survives the login round-trip in storage');
  assert.equal(draft.nota, LONG_NOTE, 'the long note survives whole, not truncated');
  assert.equal(draft.nome, 'Mario Rossi');
  assert.equal(field(rendered.mount, 'nota').value, LONG_NOTE, 'the typed note stays on screen too');
});

test('after sign-in the form offers the kept text back, then clears it on Salva', async () => {
  const store = memoryStore();
  saveNewCustomerDraft(store, { nome: 'Mario Rossi', email: 'mario@esempio.it', nota: LONG_NOTE });
  const rendered = render(stubClient(() => accepted()), { storage: store });
  await rendered.view.render();
  assert.equal(field(rendered.mount, 'nota').value, LONG_NOTE, 'the note is back after sign-in');
  assert.match(rendered.mount.textContent, /ripristinata/, 'the form says the draft is back');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1', 'Salva still creates after sign-in');
  assert.equal(readNewCustomerDraft(store), null, 'a created customer leaves no draft behind');
});

test('isNewCustomerSessionLoss reads the shell redirect and HTML signals', () => {
  assert.equal(isNewCustomerSessionLoss({ redirected: true }), true);
  assert.equal(isNewCustomerSessionLoss({ invalidResponse: true }), true);
  assert.equal(
    isNewCustomerSessionLoss(Object.assign(new Error('Invalid server response'), { code: 'INVALID_RESPONSE', invalidResponse: true })),
    true,
  );
  assert.equal(
    isNewCustomerSessionLoss(Object.assign(new Error('Invalid server response'), { code: 'INVALID_RESPONSE' })),
    false,
    'a bare invalid response without the shell signal keeps its own error',
  );
});

test('Salva through the shell redirect path keeps the long note and asks to sign in again', async () => {
  const store = memoryStore();
  const htmlLogin = () => Promise.reject(
    Object.assign(new Error('Invalid server response'), { code: 'INVALID_RESPONSE', invalidResponse: true }),
  );
  const client = stubClient(() => htmlLogin());
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda without a write');
  assert.match(rendered.mount.textContent, /Sessione scaduta/, 'the form names the expired session');
  assert.equal(readNewCustomerDraft(store)?.nota, LONG_NOTE, 'the long note survives the HTML login page');
});

test('a session lost after creation keeps the unsaved note and stays on the form', async () => {
  const store = memoryStore();
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda: the shell is leaving for the space login');
  assert.match(rendered.mount.textContent, /Sessione scaduta/, 'the session message replaces the swallowed warning');
  assert.ok(!rendered.notes.some((note) => note.includes('nota non si è salvata')), 'no swallowed warning');
  const draft = readNewCustomerDraft(store);
  assert.ok(draft, 'the unsaved remainder stays in the draft');
  assert.equal(draft.nota, LONG_NOTE, 'the long note is not lost');
});

test('a session lost on the phone link keeps the draft and stays on the form', async () => {
  const store = memoryStore();
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (body.system === MANUAL_PHONE_SYSTEM) {
      return Promise.reject(
        Object.assign(new Error('Invalid server response'), { code: 'INVALID_RESPONSE', redirected: true }),
      );
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'telefono', '+39 333 1234567');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  assert.match(rendered.mount.textContent, /Sessione scaduta/);
  assert.equal(readNewCustomerDraft(store)?.telefono, '+39 333 1234567', 'the unsaved phone stays in the draft');
});

test('a session lost on a custom value keeps the draft and stays on the form', async () => {
  const store = memoryStore();
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') {
      return { definitions: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] };
    }
    if (path === '/api/customer-data/fields/value') {
      return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  const control = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  assert.ok(control, 'the space field reads on the form');
  control.value = 'sì';
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  assert.match(rendered.mount.textContent, /Sessione scaduta/);
  assert.ok(readNewCustomerDraft(store), 'the unsaved remainder stays in the draft');
});

test('the draft key is namespaced by space and shown only to its space and operator', () => {
  const store = memoryStore();
  const scope = { spaceId: 'spA', operator: 'a@esempio.it' };
  assert.equal(
    saveNewCustomerDraft(store, { nome: 'Mario Rossi', email: 'm@esempio.it' }, scope),
    true,
  );
  assert.equal(store.getItem(NEW_CUSTOMER_DRAFT_KEY), null, 'no global PII beside the scoped key');
  assert.ok(store.getItem(newCustomerDraftKey('spA')), 'the scoped key holds the draft');
  assert.equal(readNewCustomerDraft(store, scope)?.nome, 'Mario Rossi', 'same space and operator read it back');
  assert.equal(readNewCustomerDraft(store, { spaceId: 'spB', operator: 'a@esempio.it' }), null, 'another space never reads it');
  assert.equal(readNewCustomerDraft(store, { spaceId: 'spA', operator: 'b@esempio.it' }), null, 'another operator never reads it');
  clearNewCustomerDraft(store, scope);
  assert.equal(store.getItem(newCustomerDraftKey('spA')), null, 'clear drops the scoped key');
});

test('an expired draft never comes back', () => {
  const store = memoryStore();
  store.setItem(NEW_CUSTOMER_DRAFT_KEY, JSON.stringify({
    nome: 'Mario Rossi', email: 'm@esempio.it', savedAt: Date.now() - NEW_CUSTOMER_DRAFT_TTL_MS - 1000,
  }));
  assert.equal(readNewCustomerDraft(store), null, 'stale PII stays unreadable');
  assert.equal(store.getItem(NEW_CUSTOMER_DRAFT_KEY), null, 'the stale key is dropped');
});

test('a stale global draft never passes to another space or operator (backlog:053d5cac)', () => {
  const store = memoryStore();
  store.setItem(NEW_CUSTOMER_DRAFT_KEY, JSON.stringify({
    nome: 'Mario Rossi', email: 'm@esempio.it', nota: LONG_NOTE, savedAt: Date.now(),
  }));
  assert.equal(readNewCustomerDraft(store, { spaceId: 'spA', operator: 'a@esempio.it' }), null,
    'another space never reads the old global draft');
  assert.equal(readNewCustomerDraft(store, { spaceId: 'spA', operator: 'other@esempio.it' }), null,
    'another operator never reads it either');
  assert.equal(store.getItem(NEW_CUSTOMER_DRAFT_KEY), null, 'the stale global key is dropped, not kept');
  assert.equal(store.getItem(newCustomerDraftKey('spA')), null, 'nothing is adopted under the scoped key');
  // A draft kept without a scope still reads back without one (local dev).
  store.setItem(NEW_CUSTOMER_DRAFT_KEY, JSON.stringify({
    nome: 'Mario Rossi', email: 'm@esempio.it', savedAt: Date.now(),
  }));
  assert.equal(readNewCustomerDraft(store)?.nome, 'Mario Rossi', 'the unscoped draft still reads unscoped');
});

test('tabDraftStorage falls back where no tab store exists', () => {
  assert.equal(tabDraftStorage(), null, 'node has no window: the caller falls back');
});

test('after a mid-save session loss the next Salva resumes instead of duplicating', async () => {
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  assert.match(rendered.mount.textContent, /già creato/, 'the form says the customer exists');
  const kept = readNewCustomerDraft(store);
  assert.equal(kept?.created?.id, 'c9', 'the draft carries the created subject');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'no second apply: the scheda is not duplicated');
  assert.equal(notesOf(client).length, 2, 'the failed note is retried once it can succeed');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('a corrected email after the rescue updates the customer, never a duplicate (backlog:053d5cac)', async () => {
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    if (path === '/api/contacts/c9') return { id: 'c9', firstName: 'Mario', lastName: 'Rossi', email: 'altro@esempio.it' };
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  setValue(rendered.mount, 'email', 'altro@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'no second apply: the corrected email never duplicates the scheda');
  const patches = client.calls.filter((call) => call.path === '/api/contacts/c9');
  assert.equal(patches.length, 1, 'the corrected email is written back with one contact update');
  assert.deepEqual(patches[0].body, { email: 'altro@esempio.it' });
  assert.equal(notesOf(client).length, 2, 'the failed note is still retried');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('a wholly different customer after the rescue takes a full apply, never a PATCH (backlog:053d5cac)', async () => {
  const store = memoryStore();
  let notes = 0;
  let applies = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    if (path === '/api/customer-data/import/apply') {
      applies += 1;
      return accepted({ id: applies === 1 ? 'c9' : 'c10', resource: 'contact' }, 'CREATED_RECORD');
    }
    if (path === '/api/contacts/c9') return { id: 'c9', firstName: 'Mario', lastName: 'Rossi', email: 'mario@esempio.it' };
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  // The operator types a genuinely different person, not a correction.
  setValue(rendered.mount, 'nome', 'Luigi Verdi');
  setValue(rendered.mount, 'email', 'luigi@esempio.it');
  setValue(rendered.mount, 'azienda', 'Palestra Nuova');
  clickSave(rendered.mount);
  await flush();
  const calls = appliesOf(client);
  assert.equal(calls.length, 2, 'a different customer takes the full apply, not the rescued subject');
  assert.equal(calls[1].body.rows[0].email, 'luigi@esempio.it', 'the second apply carries the new person');
  assert.equal(client.calls.filter((call) => call.path === '/api/contacts/c9').length, 0,
    'no PATCH overwrites the already-created contact');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c10', 'the resumed save lands on the new scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('a resumed save skips the steps already done before the session died', async () => {
  const store = memoryStore();
  let values = 0;
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') {
      return { definitions: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] };
    }
    if (path === '/api/customer-data/fields/value') {
      values += 1;
      if (values === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { value: { key: body.key, value: body.value } };
    }
    if (body.system === MANUAL_PHONE_SYSTEM) return accepted({ id: 'c9', resource: 'contact' }, 'MATCHED_EXISTING');
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'telefono', '+39 333 1234567');
  const control = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  control.value = 'sì';
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 2, 'record and phone link run once, never again');
  assert.equal(valuesOf(client).length, 2, 'the failed custom write is retried once it can succeed');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9');
});

test('a rescue never marks steps that never ran as done: empty note, custom lost (backlog:5a40c73e54aa)', async () => {
  const store = memoryStore();
  let values = 0;
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') {
      return { definitions: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] };
    }
    if (path === '/api/customer-data/fields/value') {
      values += 1;
      if (values === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { value: { key: body.key, value: body.value } };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  const control = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  control.value = 'sì';
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  const kept = readNewCustomerDraft(store);
  assert.ok(kept, 'the unsaved remainder stays in the draft');
  assert.ok(!kept.done.includes('phone'), 'a phone never typed is not declared done');
  assert.ok(!kept.done.includes('note'), 'an empty note is not declared saved');
  clickSave(rendered.mount);
  await flush();
  assert.equal(valuesOf(client).length, 2, 'the failed custom write restarts after sign-in');
  assert.equal(notesOf(client).length, 0, 'no note is written or declared saved');
  assert.equal(appliesOf(client).length, 1, 'no second apply: the scheda is not duplicated');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('a phone typed after the rescue is linked, not skipped (backlog:5a40c73e54aa)', async () => {
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    if (body.system === MANUAL_PHONE_SYSTEM) return accepted({ id: 'c9', resource: 'contact' }, 'MATCHED_EXISTING');
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  const kept = readNewCustomerDraft(store);
  assert.ok(kept, 'the unsaved remainder stays in the draft');
  assert.ok(!kept.done.includes('phone'), 'a phone never typed is not declared done');
  setValue(rendered.mount, 'telefono', '+39 333 1234567');
  clickSave(rendered.mount);
  await flush();
  const applies = appliesOf(client);
  assert.equal(applies.length, 2, 'record once, phone link once the operator typed it');
  assert.equal(applies[1].body.system, MANUAL_PHONE_SYSTEM, 'the added phone is linked, not dropped');
  assert.equal(notesOf(client).length, 2, 'the failed note is retried once it can succeed');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('stepNeedsRun reruns on value change, never on step state alone (backlog:5a40c73e54aa)', () => {
  const table = [
    // [done, step, before, now, expected, why]
    [[], 'phone', '', '+393331234567', true, 'a step that never ran still runs'],
    [['phone'], 'phone', '', '+393331234567', true, 'a phone typed after the rescue runs even when done'],
    [['phone'], 'phone', '+393331234567', '+393331234567', false, 'an unchanged phone is not relinked'],
    [[], 'note', '', 'nota lunga', true, 'a note that never ran still runs'],
    [['note'], 'note', 'nota lunga', 'nota lunga', false, 'an unchanged note is not reposted'],
    [['note'], 'note', 'nota lunga', 'nota cambiata', true, 'an edited note runs even when done'],
    [['custom'], 'custom', 'sì', 'no', true, 'a custom value changed after the rescue is written'],
    [['custom'], 'custom', 'sì', 'sì', false, 'an unchanged custom value is not rewritten'],
    [[], 'custom', '', '', false, 'an empty input never runs'],
    [['custom'], 'custom', '', '', false, 'an empty input never runs, even when done'],
  ];
  for (const [steps, step, before, now, expected, why] of table) {
    assert.equal(stepNeedsRun(new Set(steps), step, before, now), expected, why);
  }
  assert.equal(stepNeedsRun(null, 'phone', '', '+393331234567'), true, 'no done set still runs a live input');
  assert.equal(stepNeedsRun(null, 'phone', '', ''), false, 'no done set skips an empty input');
});

test('normalizeResumeEmail trims and folds case on both sides (backlog:5a40c73e54aa)', () => {
  assert.equal(normalizeResumeEmail('Mario@Esempio.it '), normalizeResumeEmail('mario@esempio.it'));
  assert.equal(normalizeResumeEmail('  A@B.IT'), 'a@b.it');
  assert.equal(normalizeResumeEmail(null), '');
});

test('a nome changed after the rescue is written back with an update, never dropped (backlog:5a40c73e54aa)', async () => {
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    if (path === '/api/contacts/c9') return { id: 'c9', firstName: 'Mario', lastName: 'Bianchi' };
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  setValue(rendered.mount, 'nome', 'Mario Bianchi');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'no second apply: the scheda is not duplicated');
  const patches = client.calls.filter((call) => call.path === '/api/contacts/c9');
  assert.equal(patches.length, 1, 'the edited nome is written back with one contact update');
  assert.equal(patches[0].method, 'PATCH');
  assert.deepEqual(patches[0].body, { firstName: 'Mario', lastName: 'Bianchi' });
  assert.equal(notesOf(client).length, 2, 'the failed note is still retried');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('an azienda changed after the rescue is declared, never dropped silently (backlog:5a40c73e54aa)', async () => {
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'azienda', 'Palestra Esempio');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  setValue(rendered.mount, 'azienda', 'Palestra Nuova');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'no second apply: the scheda is not duplicated');
  assert.equal(client.calls.filter((call) => call.path === '/api/contacts/c9').length, 0, 'no contact update for an unchanged nome');
  assert.ok(rendered.notes.some((note) => note.includes('azienda')), 'the warning names the azienda that was not saved');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save still lands on the scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('a rescued email with trailing space and case still resumes instead of re-applying (backlog:5a40c73e54aa)', async () => {
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'Mario@Esempio.it ');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'whitespace and case never defeat the resume');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
});

test('a custom value changed after the rescue is saved even when custom was done (backlog:5a40c73e54aa)', async () => {
  const store = memoryStore();
  let values = 0;
  let notes = 0;
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') {
      return { definitions: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] };
    }
    if (path === '/api/customer-data/fields/value') {
      values += 1;
      return { value: { key: body.key, value: body.value } };
    }
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  const control = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  control.value = 'sì';
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  const kept = readNewCustomerDraft(store);
  assert.ok(kept?.done.includes('custom'), 'custom completed before the session died');
  control.value = 'no';
  clickSave(rendered.mount);
  await flush();
  assert.equal(valuesOf(client).length, 2, 'the changed custom value is written, not skipped for the step state');
  assert.deepEqual(valuesOf(client)[1].body, { resource: 'contact', id: 'c9', key: 'amico', value: 'no' });
  assert.equal(appliesOf(client).length, 1, 'no second apply: the scheda is not duplicated');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
  assert.equal(readNewCustomerDraft(store), null, 'a completed save leaves no draft behind');
});

test('an unchanged custom value is not rewritten after the rescue (backlog:5a40c73e54aa)', async () => {
  const store = memoryStore();
  let values = 0;
  let notes = 0;
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') {
      return { definitions: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] };
    }
    if (path === '/api/customer-data/fields/value') {
      values += 1;
      return { value: { key: body.key, value: body.value } };
    }
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  const control = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  control.value = 'sì';
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  clickSave(rendered.mount);
  await flush();
  assert.equal(valuesOf(client).length, 1, 'the unchanged custom value is not rewritten');
  assert.equal(notesOf(client).length, 2, 'the failed note is still retried');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
});

test('after a real reload the kept custom values are back in the form (backlog:053d5cac)', async () => {
  const store = memoryStore();
  saveNewCustomerDraft(
    store,
    { nome: 'Mario Rossi', email: 'mario@esempio.it', nota: LONG_NOTE },
    undefined,
    { custom: { amico: 'sì' } },
  );
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') {
      return { definitions: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }] };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  // A real reload: a fresh view over the same storage, like a new page load.
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  const control = rendered.mount.findAll('select').find((node) => node.getAttribute('data-field-key') === 'amico');
  assert.ok(control, 'the space field reads on the reloaded form');
  assert.equal(control.value, 'sì', 'the kept custom value is back after the reload');
  assert.equal(field(rendered.mount, 'nota').value, LONG_NOTE, 'the long note is back too');
});

test('a refused phone link stays to do and the resume retries it (backlog:053d5cac)', async () => {
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    if (body.system === MANUAL_PHONE_SYSTEM) {
      return { receipts: [{ outcome: 'rejected', reasonCode: 'INVALID_PHONE', subject: null }] };
    }
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'telefono', '+39 333 1234567');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda on a lost session');
  const phoneLinks = () => appliesOf(client).filter((call) => call.body.system === MANUAL_PHONE_SYSTEM);
  assert.equal(phoneLinks().length, 1, 'the first save tried the phone link once');
  const kept = readNewCustomerDraft(store);
  assert.ok(kept, 'the unsaved remainder stays in the draft');
  assert.ok(!kept.done.includes('phone'), 'a refused link is never declared done');
  clickSave(rendered.mount);
  await flush();
  assert.equal(phoneLinks().length, 2, 'the resume retries the refused link');
  assert.equal(appliesOf(client).filter((call) => call.body.system === MANUAL_IMPORT_SYSTEM).length, 1,
    'still no second apply: the scheda is not duplicated');
  assert.ok(rendered.notes.some((note) => /telefono non si è collegato/.test(note)),
    'the refusal warns in Italian');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9', 'the resumed save lands on the scheda');
});

test('«il testo è conservato» shows only when the draft really saved (backlog:053d5cac)', async () => {
  const failingStore = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
  const client = stubClient(() => sessionLost());
  // The submissions layer keeps a working store: only the draft tab store is
  // full, so the failure under test is the draft save alone.
  const rendered = render(client, { storage: memoryStore(), draftStorage: failingStore });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'no scheda without a write');
  assert.match(rendered.mount.textContent, /Sessione scaduta/, 'the form still names the expired session');
  assert.ok(!rendered.mount.textContent.includes('conservato'), 'no kept-text promise the browser could not keep');
  assert.match(rendered.mount.textContent, /non si è salvato in questo browser/, 'the honest message shows instead');
});

test('a generic failure keeps its own error and stores no draft', async () => {
  const store = memoryStore();
  const client = stubClient(() => Promise.reject(Object.assign(new Error('Import unavailable'), { status: 500, code: 'UNKNOWN' })));
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', LONG_NOTE);
  clickSave(rendered.mount);
  await flush();
  assert.match(rendered.mount.textContent, /Riprova più tardi/, 'a broken write keeps its own error');
  assert.equal(readNewCustomerDraft(store), null, 'only a lost session stores the draft');
  clearNewCustomerDraft(store);
});

/* ------------------------------------------------ backlog:ff8bb60f417f (punti 11-12) */

const panelOf = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-customer-panel') === 'open') ?? null;
const action = (mount, name) => mount.findAll('button').find((node) => node.getAttribute('data-action') === name);
const discardBox = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-discard') === '');

test('ff8bb60f417f: Nuovo cliente opens as a window like the scheda panels, focus on Nome before the reads answer', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = stubClient(async (path) => {
    await gate;
    if (path === '/api/customer-data/fields') return { definitions: [] };
    return { available: false };
  });
  const rendered = render(client);
  const pending = rendered.view.render();
  const panel = panelOf(rendered.mount);
  assert.ok(panel, 'the window shows at once, before the field and AI reads answer');
  const classes = String(panel.getAttribute('class')).split(/\s+/);
  assert.ok(classes.includes('bo-scheda-composer'), 'the same frame as Scrivi and Nuova offerta');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.ok(panel.findAll('h4').some((node) => node.textContent === 'Nuovo cliente'), 'the dark head names the purpose');
  assert.ok(action(rendered.mount, 'customer-minimize') && action(rendered.mount, 'customer-close'), 'minimize and close');
  assert.equal(field(rendered.mount, 'nome').__focused, true, 'the focus is on Nome');
  assert.equal(rendered.mount.findAll('h1').length, 0, 'no page title: it is a window');
  release();
  await pending;
  // A second render (route re-entry) never stacks a second window.
  await rendered.view.render();
  assert.equal(rendered.mount.findAll('div').filter((node) => node.getAttribute('data-customer-panel') === 'open').length, 1);
});

test('ff8bb60f417f: Annulla, ✕ and Esc with text ask inline, never with confirm(); empty closes at once', async () => {
  const original = globalThis.confirm;
  let browserConfirms = 0;
  globalThis.confirm = () => { browserConfirms += 1; return true; };
  try {
    // Empty: Annulla closes at once.
    const empty = render(stubClient(() => accepted()));
    await empty.view.render();
    action(empty.mount, 'cancel-customer').dispatch('click');
    assert.equal(empty.navigated(), '#/customer-data', 'nothing typed: Annulla leaves at once');
    assert.equal(panelOf(empty.mount), null, 'and the window closes');

    for (const how of ['annulla', 'close', 'escape']) {
      const rendered = render(stubClient(() => accepted()));
      await rendered.view.render();
      setValue(rendered.mount, 'cognome', 'Rossi');
      const ask = () => {
        if (how === 'annulla') action(rendered.mount, 'cancel-customer').dispatch('click');
        else if (how === 'close') action(rendered.mount, 'customer-close').dispatch('click');
        else panelOf(rendered.mount).dispatch('keydown', { key: 'Escape', preventDefault() {} });
      };
      ask();
      assert.equal(rendered.navigated(), null, `${how}: nothing typed is lost without asking`);
      assert.ok(!discardBox(rendered.mount).classList.contains('hidden'), `${how}: the question shows inline`);
      assert.match(discardBox(rendered.mount).textContent, /Scartare quello che hai scritto\?/);
      assert.equal(action(rendered.mount, 'keep-customer').__focused, true, `${how}: the focus goes to the safe answer`);
      // Esc on the question keeps the text.
      panelOf(rendered.mount).dispatch('keydown', { key: 'Escape', preventDefault() {} });
      assert.ok(discardBox(rendered.mount).classList.contains('hidden'), `${how}: Esc on the question keeps writing`);
      assert.equal(field(rendered.mount, 'cognome').value, 'Rossi', `${how}: the text stays`);
      ask();
      action(rendered.mount, 'keep-customer').dispatch('click');
      assert.ok(discardBox(rendered.mount).classList.contains('hidden'), `${how}: Continua a scrivere goes back`);
      assert.equal(panelOf(rendered.mount) !== null, true);
      ask();
      action(rendered.mount, 'discard-customer').dispatch('click');
      assert.equal(rendered.navigated(), '#/customer-data', `${how}: Scarta leaves`);
      assert.equal(panelOf(rendered.mount), null, `${how}: and closes the window`);
    }
    assert.equal(browserConfirms, 0, 'never the browser confirm()');
  } finally {
    globalThis.confirm = original;
  }
});

test('ff8bb60f417f: after Salva a toast says so, the badge recounts and the window closes', async () => {
  const client = stubClient(() => accepted());
  let saved = 0;
  const rendered = render(client, { onSaved: () => { saved += 1; } });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario');
  setValue(rendered.mount, 'cognome', 'Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.deepEqual(rendered.notes, ['Cliente creato.']);
  assert.equal(saved, 1);
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1');
  assert.equal(panelOf(rendered.mount), null, 'the window closes on the new scheda');
});

test('ff8bb60f417f: Nome and Cognome travel apart, like Modifica; one field alone still splits', async () => {
  assert.deepEqual(customerNames({ nome: 'Anna Maria', cognome: 'Bianchi' }), { firstName: 'Anna Maria', lastName: 'Bianchi' });
  assert.deepEqual(customerNames({ nome: ' Mario  Rossi ', cognome: '' }), { firstName: 'Mario', lastName: 'Rossi' });
  const client = stubClient(() => accepted());
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Anna Maria');
  setValue(rendered.mount, 'cognome', 'Bianchi');
  setValue(rendered.mount, 'email', 'anna@esempio.it');
  clickSave(rendered.mount);
  await flush();
  assert.deepEqual(appliesOf(client)[0].body.rows, [{ firstName: 'Anna Maria', lastName: 'Bianchi', email: 'anna@esempio.it' }]);
});

test('ff8bb60f417f: the kept draft carries Cognome across a lost session', () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  assert.equal(saveNewCustomerDraft(storage, { nome: 'Anna', cognome: 'Bianchi' }, { spaceId: 's1' }), true);
  const draft = readNewCustomerDraft(storage, { spaceId: 's1' });
  assert.equal(draft.cognome, 'Bianchi');
  assert.equal(saveNewCustomerDraft(storage, { nome: '', cognome: 'Bianchi' }, { spaceId: 's2' }), true, 'a Cognome alone is text worth keeping');
});

test('ff8bb60f417f: the question takes the place of Salva/Annulla while asked', async () => {
  const rendered = render(stubClient(() => accepted()));
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Lia');
  const actions = rendered.mount.findAll('div').find((node) => node.getAttribute('class')?.split(/\s+/).includes('bo-cliente-nuovo-actions'));
  action(rendered.mount, 'cancel-customer').dispatch('click');
  assert.ok(actions.classList.contains('hidden'), 'Salva/Annulla step aside');
  action(rendered.mount, 'keep-customer').dispatch('click');
  assert.ok(!actions.classList.contains('hidden'), 'and come back with Continua a scrivere');
  assert.equal(field(rendered.mount, 'nome').__focused, true, 'the focus goes back to the form');
});

/* ------------------------------------------------ review Muse #791 giro 1 */

test('review #791 giro 1: the window lives under the router mount, so the session keep/restore keeps its text', async () => {
  const { captureDrafts, restoreDrafts } = await import('../apps/admin/public/admin-draft-keep.js');
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const first = render(stubClient(() => accepted()));
  await first.view.render();
  setValue(first.mount, 'nome', 'Anna');
  setValue(first.mount, 'cognome', 'Bianchi');
  setValue(first.mount, 'nota', 'Cerca un pacchetto da 10 lezioni');
  // The shell leaves for the login with the router mount as the root.
  assert.equal(captureDrafts({ root: first.mount, hash: '#/clienti/nuovo', space: 's1', storage }), 3);
  const back = render(stubClient(() => accepted()));
  await back.view.render();
  assert.equal(restoreDrafts({ root: back.mount, hash: '#/clienti/nuovo', space: 's1', storage }), 3);
  assert.equal(field(back.mount, 'nome').value, 'Anna');
  assert.equal(field(back.mount, 'cognome').value, 'Bianchi');
  assert.equal(field(back.mount, 'nota').value, 'Cerca un pacchetto da 10 lezioni');
  // The shell hands the form the router mount itself, never a detached host.
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const wiring = app.slice(app.indexOf('const customerFormView = createCustomerFormView('), app.indexOf('const customerFormView = createCustomerFormView(') + 900);
  assert.match(wiring, /\n  mount: moduleView,/);
  assert.doesNotMatch(wiring, /document\.body/);
});

test('review #791 giro 1: a Salva clicked while the window still reads its fields saves once they arrive', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = stubClient(async (path) => {
    if (path === '/api/customer-data/fields') { await gate; return { definitions: [] }; }
    if (path === '/api/customer-data/phrase/ai-available') { await gate; return { available: false }; }
    return accepted();
  });
  const rendered = render(client);
  const pending = rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  clickSave(rendered.mount);
  assert.equal(appliesOf(client).length, 0, 'nothing writes before the window is ready');
  assert.equal(action(rendered.mount, 'save-customer').disabled, true, 'Salva shows it took the click');
  release();
  await pending;
  await flush();
  assert.equal(appliesOf(client).length, 1, 'the early click saves, never silently dropped');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1');
});

test('review #791 giro 1: a corrected Nome/Cognome split after the rescue is written back', async () => {
  assert.equal(sameCustomerNames({ nome: 'Anna', cognome: 'Maria Bianchi' }, { nome: 'Anna Maria', cognome: 'Bianchi' }), false);
  assert.equal(sameCustomerNames({ nome: 'Mario Rossi', cognome: '' }, { nome: 'Mario', cognome: 'Rossi' }), true);
  const store = memoryStore();
  let notes = 0;
  const client = stubClient((path) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') {
      notes += 1;
      if (notes === 1) return Promise.reject(Object.assign(new Error('Workspace membership required'), { status: 401 }));
      return { note: { id: 'n1' } };
    }
    if (path === '/api/contacts/c9') return { id: 'c9' };
    return accepted({ id: 'c9', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client, { storage: store });
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Anna');
  setValue(rendered.mount, 'cognome', 'Maria Bianchi');
  setValue(rendered.mount, 'email', 'anna@esempio.it');
  setValue(rendered.mount, 'nota', 'una nota');
  clickSave(rendered.mount);
  await flush();
  setValue(rendered.mount, 'nome', 'Anna Maria');
  setValue(rendered.mount, 'cognome', 'Bianchi');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 1, 'no second apply');
  const patches = client.calls.filter((call) => call.path === '/api/contacts/c9');
  assert.equal(patches.length, 1, 'the moved split is a real change');
  assert.deepEqual(patches[0].body, { firstName: 'Anna Maria', lastName: 'Bianchi' });
});
