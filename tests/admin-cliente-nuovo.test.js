import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENTI_NUOVO_ROUTE,
  MANUAL_IMPORT_SYSTEM,
  MANUAL_PHONE_SYSTEM,
  applyRefusalText,
  createCustomerFormView,
  normalizeTelefono,
  splitNome,
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
  assert.equal(client.calls.length, 0, 'no request leaves the browser before the form is valid');
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
  assert.equal(client.calls.length, 1, 'one governed apply, not a parallel creation');
  assert.equal(client.calls[0].path, '/api/customer-data/import/apply');
  assert.equal(client.calls[0].body.system, MANUAL_IMPORT_SYSTEM);
  assert.deepEqual(client.calls[0].body.rows, [{
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
  assert.equal(client.calls.length, 2, 'record first, phone-bearing identity second');
  assert.equal(client.calls[1].body.system, MANUAL_PHONE_SYSTEM);
  assert.equal(client.calls[1].body.rows[0].externalId, '+393331234567');
  assert.equal(rendered.navigated(), '#/customer-card/contact/c1');
  assert.ok(rendered.notes.some((note) => note.includes('senza duplicati')), 'a matched scheda warns instead of duplicating');
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
  assert.equal(client.calls.length, 0, 'Annulla writes nothing');
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
