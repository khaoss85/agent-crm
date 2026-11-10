import test from 'node:test';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import {
  addFieldForm,
  applyPhrase,
  defineField,
  fetchFieldDefs,
  fetchFieldValues,
  fieldControl,
  formatCustomValue,
  phraseAiAvailable,
  postSubjectNote,
  previewPhrase,
  saveFieldValue,
} from '../apps/admin/public/admin-custom-fields.js';
import { bindAdminMutations } from '../apps/admin/public/admin-submission.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The shared custom-fields layer (backlog:434cc39a), against a stub server.
 *
 * What it must prove: the seven framework routes are called with the
 * governed shapes, an older server without the routes degrades (empty
 * definitions, hidden ✦), every field type builds its control and reads
 * back, and + Aggiungi campo posts the definition.
 */

function stubClient(handler) {
  const calls = [];
  const inner = {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      let body = options?.body ?? {};
      if (typeof body === 'string') {
        try { body = body === '' ? {} : JSON.parse(body); } catch { /* keep raw */ }
      }
      calls.push({ path, method: options?.method ?? 'GET', body });
      return handler(path, body, options);
    },
  };
  // The helpers never bind themselves: in production the cliente-nuovo and
  // customer-card views hand them a bound client (#567, #581). The test
  // wires the same; `calls` stays readable on the wrapper for the assertions.
  const { client } = bindAdminMutations(inner);
  client.calls = calls;
  return client;
}

const flush = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

test('fetchFieldDefs reads the space definitions, [] on an older server', async () => {
  const defs = [{ key: 'amico', label: 'Amico', type: 'si-no', options: [] }];
  const client = stubClient(() => ({ definitions: defs }));
  assert.deepEqual(await fetchFieldDefs(client), defs);
  assert.equal(client.calls[0].path, '/api/customer-data/fields');
  const older = stubClient(() => { throw Object.assign(new Error('gone'), { status: 404 }); });
  assert.deepEqual(await fetchFieldDefs(older), []);
});

test('defineField posts label, type and options for scelta', async () => {
  const client = stubClient(() => ({ definition: { key: 'canale', label: 'Canale', type: 'scelta' }, replayed: false }));
  await defineField(client, { label: 'Canale', type: 'scelta', options: ['WA', 'IG'] });
  assert.equal(client.calls[0].path, '/api/customer-data/fields/define');
  assert.deepEqual(client.calls[0].body, { label: 'Canale', type: 'scelta', options: ['WA', 'IG'] });
});

test('fetchFieldValues and saveFieldValue name the subject and the key', async () => {
  const client = stubClient((path) => {
    if (path.startsWith('/api/customer-data/fields/values')) {
      return { values: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [], value: 'sì' }] };
    }
    return { value: { key: 'amico', value: 'sì' } };
  });
  const values = await fetchFieldValues(client, 'contact', 'c1');
  assert.equal(values[0].value, 'sì');
  await saveFieldValue(client, { resource: 'contact', id: 'c1', key: 'amico', value: 'no' });
  assert.equal(client.calls[1].path, '/api/customer-data/fields/value');
  assert.deepEqual(client.calls[1].body, { resource: 'contact', id: 'c1', key: 'amico', value: 'no' });
});

test('phraseAiAvailable is true only when the server says so', async () => {
  assert.equal(await phraseAiAvailable(stubClient(() => ({ available: true }))), true);
  assert.equal(await phraseAiAvailable(stubClient(() => ({ available: false }))), false);
  assert.equal(await phraseAiAvailable(stubClient(() => { throw new Error('down'); })), false);
});

test('previewPhrase and applyPhrase use the governed phrase routes', async () => {
  const client = stubClient((path) => {
    if (path.endsWith('/preview')) {
      return { customer: { firstName: 'Daniele', lastName: '', email: 'daniele@gmail.com', phone: '234341', companyName: null }, note: null, fields: [{ key: 'amico', label: 'Amico', type: 'si-no', options: [], value: 'sì', isNew: true }], newFields: 1 };
    }
    return { subject: { resource: 'contact', id: 'c7' }, matchedExisting: false, phoneLinked: false, phoneWarning: null, fields: [] };
  });
  const preview = await previewPhrase(client, 'daniele pelleri email daniele@gmail.com tel 234341 amico sì');
  assert.equal(preview.customer.firstName, 'Daniele');
  assert.equal(preview.fields[0].key, 'amico');
  const applied = await applyPhrase(client, { customer: preview.customer, fields: preview.fields });
  assert.equal(applied.subject.id, 'c7');
  assert.equal(client.calls[1].path, '/api/customer-data/phrase/apply');
});

test('postSubjectNote posts through the single writer', async () => {
  const client = stubClient(() => ({ note: { id: 'n1' } }));
  await postSubjectNote(client, { resource: 'contact', id: 'c7', text: 'Ci ha conosciuti in palestra.' });
  assert.equal(client.calls[0].path, '/api/customer-hub/notes');
  // The scheda's own shape (production 07/11): `body`, never `text`.
  assert.deepEqual(client.calls[0].body, { resource: 'contact', id: 'c7', body: 'Ci ha conosciuti in palestra.' });
});

test('postSubjectNote folds textarea line breaks to spaces (verifier 09/11)', async () => {
  const client = stubClient(() => ({ note: { id: 'n1' } }));
  // Red before the cure: the raw text travelled with its line break, and
  // the framework refused it 400 (safe text allows no control characters),
  // so a two-line note was lost even though the refusal warning showed.
  await postSubjectNote(client, {
    resource: 'contact', id: 'c7', text: 'Ci ha conosciuti in palestra.\nCerca un pacchetto serale.',
  });
  assert.deepEqual(client.calls[0].body,
    { resource: 'contact', id: 'c7', body: 'Ci ha conosciuti in palestra. Cerca un pacchetto serale.' });
  assert.match(client.calls[0].body.body, /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]*$/,
    'no control character survives in the posted body');
});

// Production 07/11, space 2f07eeb9: the framework route answers a BARE
// array, and `answer.values` on an array is Array.prototype.values — the
// card read every saved value as none and showed «—». Exactly that payload.
const PROD_VALUES = [{
  key: 'amico-verifica-l1', label: 'Amico verifica L1', type: 'si-no', options: [],
  createdBy: 'u1', value: 'sì', updatedAt: '2026-11-07T16:23:09.466Z', updatedBy: 'u1',
}];

test('fetchFieldValues reads the bare array the framework route answers (production 07/11)', async () => {
  const client = stubClient(() => PROD_VALUES);
  const values = await fetchFieldValues(client, 'contact', '07ec5a4f-7205-404a-95df-cbf6d4346120');
  assert.equal(values.length, 1, 'the bare array is the list, not Array.prototype.values');
  assert.equal(values[0].value, 'sì');
  assert.deepEqual(await fetchFieldValues(stubClient(() => ({ values: PROD_VALUES })), 'contact', 'c1'), PROD_VALUES,
    'an enveloped answer still reads');
  assert.deepEqual(await fetchFieldValues(stubClient(() => ({ values: 'x' })), 'contact', 'c1'), []);
});

test('fetchFieldDefs reads the bare array the framework route answers', async () => {
  const defs = [{ key: 'amico-verifica-l1', label: 'Amico verifica L1', type: 'si-no', options: [] }];
  assert.deepEqual(await fetchFieldDefs(stubClient(() => defs)), defs);
  assert.deepEqual(await fetchFieldDefs(stubClient(() => ({ fields: defs }))), defs);
});

test('a Sì/No value reads the same in every older representation', () => {
  for (const value of ['sì', 'Sì', 'si', 'yes', true, 'true']) {
    assert.equal(formatCustomValue({ type: 'si-no' }, value), 'sì', `${JSON.stringify(value)} reads sì`);
  }
  for (const value of ['no', 'No', false, 'false']) {
    assert.equal(formatCustomValue({ type: 'si-no' }, value), 'no', `${JSON.stringify(value)} reads no`);
  }
});

test('the Sì/No edit control round-trips the stored form', () => {
  const doc = createFakeDocument();
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.setAttribute('class', cls);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const def = { key: 'amico-verifica-l1', label: 'Amico verifica L1', type: 'si-no', options: [] };
  assert.equal(fieldControl(el, def, 'sì').read(), 'sì', 'the stored sì opens selected and saves sì');
  assert.equal(fieldControl(el, def, true).read(), 'sì');
  assert.equal(fieldControl(el, def, 'no').read(), 'no');
  assert.equal(fieldControl(el, def, null).read(), '', 'never set opens empty');
});

test('formatCustomValue reads Italian, null when never set', () => {
  assert.equal(formatCustomValue({ type: 'si-no' }, 'sì'), 'sì');
  assert.equal(formatCustomValue({ type: 'si-no' }, 'no'), 'no');
  assert.equal(formatCustomValue({ type: 'testo' }, 'Padel'), 'Padel');
  assert.equal(formatCustomValue({ type: 'testo' }, null), null);
  assert.equal(formatCustomValue({ type: 'testo' }, ''), null);
});

test('fieldControl builds one control per type and reads back', () => {
  const doc = createFakeDocument();
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.setAttribute('class', cls);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const text = fieldControl(el, { key: 'hobby', label: 'Hobby', type: 'testo', options: [] }, 'Padel');
  assert.equal(text.read(), 'Padel');
  const numero = fieldControl(el, { key: 'rate', label: 'Rata', type: 'numero', options: [] });
  numero.set('1200');
  assert.equal(numero.read(), '1200');
  const data = fieldControl(el, { key: 'nascita', label: 'Nascita', type: 'data', options: [] });
  assert.equal(data.control.getAttribute('type'), 'date');
  const sino = fieldControl(el, { key: 'amico', label: 'Amico', type: 'si-no', options: [] }, 'sì');
  assert.equal(sino.read(), 'sì');
  const scelta = fieldControl(el, { key: 'canale', label: 'Canale', type: 'scelta', options: ['WA', 'IG'] });
  scelta.set('IG');
  assert.equal(scelta.read(), 'IG');
});

test('+ Aggiungi campo posts the definition and reports it back', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.setAttribute('class', cls);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let defined = null;
  const form = addFieldForm(el, { onDefine: async (input) => { defined = input; return { definition: input }; } });
  mount.appendChild(form.wrap);
  const label = mount.findAll('input').find((node) => node.getAttribute('name') === 'nuovo-campo-label');
  label.value = 'Amico';
  const save = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'create-field');
  save.dispatch('click');
  await flush();
  assert.deepEqual(defined, { label: 'Amico', type: 'testo', options: undefined });
});

test('+ Aggiungi campo refuses an empty label without calling the server', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.setAttribute('class', cls);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let called = 0;
  const form = addFieldForm(el, { onDefine: async () => { called += 1; return null; } });
  mount.appendChild(form.wrap);
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'create-field').dispatch('click');
  await flush();
  assert.equal(called, 0);
  assert.match(mount.textContent, /nome al campo/);
});
