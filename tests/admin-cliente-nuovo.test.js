import test from 'node:test';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import {
  CLIENTI_NUOVO_ROUTE,
  MANUAL_IMPORT_SYSTEM,
  MANUAL_PHONE_SYSTEM,
  NEW_CUSTOMER_DRAFT_KEY,
  NEW_CUSTOMER_DRAFT_TTL_MS,
  applyRefusalText,
  clearNewCustomerDraft,
  createCustomerFormView,
  isNewCustomerSessionLoss,
  newCustomerDraftKey,
  normalizeResumeEmail,
  normalizeTelefono,
  readNewCustomerDraft,
  saveNewCustomerDraft,
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
  for (const name of ['nome', 'email', 'telefono', 'azienda', 'stato', 'nota']) {
    assert.ok(field(mount, name), `the ${name} control renders`);
    assert.ok(errorFor(mount, name) ?? (name === 'stato' || name === 'nota'), `the ${name} error slot renders`);
  }
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
  assert.equal(appliesOf(client).length, 0, 'Annulla writes nothing');
  assert.equal(rendered.navigated(), '#/customer-data');
});

test('a leaving route invalidates the form so a late save cannot clear the next screen', async () => {
  const client = stubClient(() => accepted());
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  rendered.view.invalidate();
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), null, 'the invalidated save never navigates onto the next screen');
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
  assert.deepEqual(notesOf(client)[0].body, { resource: 'contact', id: 'c7', text: 'Ci ha conosciuti in palestra.' });
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7');
});

test('a refused note warns but never blocks the created customer', async () => {
  const client = stubClient((path, body) => {
    if (path === '/api/customer-data/phrase/ai-available') return { available: false };
    if (path === '/api/customer-data/fields') return { definitions: [] };
    if (path === '/api/customer-hub/notes') throw Object.assign(new Error('no'), { status: 503 });
    return accepted({ id: 'c7', resource: 'contact' }, 'CREATED_RECORD');
  });
  const rendered = render(client);
  await rendered.view.render();
  setValue(rendered.mount, 'nome', 'Mario Rossi');
  setValue(rendered.mount, 'email', 'mario@esempio.it');
  setValue(rendered.mount, 'nota', 'Una nota.');
  clickSave(rendered.mount);
  await flush();
  assert.equal(rendered.navigated(), '#/customer-card/contact/c7', 'the customer still lands on its scheda');
  assert.ok(rendered.notes.some((note) => note.includes('nota non si è salvata')), 'the warning names the note');
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

test('a pre-scoping global draft is adopted once under the scoped key', () => {
  const store = memoryStore();
  store.setItem(NEW_CUSTOMER_DRAFT_KEY, JSON.stringify({
    nome: 'Mario Rossi', email: 'm@esempio.it', nota: LONG_NOTE, savedAt: Date.now(),
  }));
  const draft = readNewCustomerDraft(store, { spaceId: 'spA', operator: 'a@esempio.it' });
  assert.equal(draft?.nota, LONG_NOTE, 'the in-flight text moves, not lost');
  assert.equal(store.getItem(NEW_CUSTOMER_DRAFT_KEY), null, 'no global PII left behind');
  assert.ok(store.getItem(newCustomerDraftKey('spA')), 'the draft now lives under the scoped key');
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

test('a changed identity after the rescue falls back to a full apply', async () => {
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
  setValue(rendered.mount, 'email', 'altro@esempio.it');
  setValue(rendered.mount, 'nota', '');
  clickSave(rendered.mount);
  await flush();
  assert.equal(appliesOf(client).length, 2, 'a new identity re-applies instead of reusing the old subject');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c9');
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
