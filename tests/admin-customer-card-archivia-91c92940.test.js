// Voce 91c92940274c (Dan 19/11): archivia, ripristina ed elimina un contatto
// dalla testata della scheda — un clic per archiviare (con «Annulla»), una
// conferma sul posto per eliminare, «Ripristina» su un archiviato.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const CARD = {
  subject: { resource: 'contact', id: 'c1' },
  name: 'Prova Archivio',
  status: { value: 'lead' },
};

function client({ card = CARD, fail = null } = {}) {
  const writes = [];
  return {
    writes,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      if (method !== 'GET') {
        writes.push({ path, method });
        if (fail) throw fail;
        return { ok: true };
      }
      if (path.includes('/api/customer-hub/card/')) return card;
      if (path.includes('/api/customer-hub/timeline/')) return { entries: { items: [] } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

async function open(options = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const toasts = [];
  const api = client(options);
  await createCustomerCardView({
    doc,
    mount,
    client: api,
    navigate: (hash) => { navigated.push(hash); },
    toast: (text, error, extra) => { toasts.push({ text, error: Boolean(error), extra }); },
  }).renderCard('contact', 'c1');
  const button = (action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
  return { mount, api, navigated, toasts, button };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('91c92940: «Archivia» è un clic, torna a Clienti e il toast tiene «Annulla» che ripristina', async () => {
  const { api, navigated, toasts, button } = await open();
  assert.ok(button('contact-archive'), 'Archivia è nella testata');
  button('contact-archive').dispatch('click');
  await settle();
  assert.deepEqual(api.writes[0], { path: '/api/contacts/c1/archive', method: 'POST' });
  assert.equal(navigated.at(-1), '#/customer-data');
  const archived = toasts.find((entry) => entry.text === 'Prova Archivio archiviato');
  assert.ok(archived && archived.extra?.action?.label === 'Annulla', JSON.stringify(toasts));
  await archived.extra.action.run();
  assert.deepEqual(api.writes[1], { path: '/api/contacts/c1/restore', method: 'POST' });
  assert.equal(navigated.at(-1), '#/customer-card/contact/c1');
});

test('91c92940: «Elimina» chiede sul posto e scrive solo dopo «Elimina per sempre»; «Annulla» non scrive', async () => {
  const { mount, api, navigated, button } = await open();
  const strip = () => mount.findAll('div').find((node) => node.getAttribute('data-confirm') === 'contact-delete');
  assert.equal(strip().getAttribute('hidden'), '', 'la conferma è chiusa');
  button('contact-delete').dispatch('click');
  assert.equal(strip().getAttribute('hidden'), null, 'la conferma si apre sul posto');
  assert.ok(strip().textContent.includes('Eliminare Prova Archivio per sempre?'));
  button('contact-delete-cancel').dispatch('click');
  assert.equal(api.writes.length, 0, 'Annulla non scrive niente');
  button('contact-delete').dispatch('click');
  button('contact-delete-confirm').dispatch('click');
  await settle();
  assert.deepEqual(api.writes[0], { path: '/api/contacts/c1', method: 'DELETE' });
  assert.equal(navigated.at(-1), '#/customer-data');
});

test('91c92940: un contatto con offerte dice che si può solo archiviare, e resta sulla scheda', async () => {
  const fail = Object.assign(new Error('conflict'), { status: 409, code: 'CONTACT_HAS_OPPORTUNITIES' });
  const { mount, navigated, button } = await open({ fail });
  button('contact-delete').dispatch('click');
  button('contact-delete-confirm').dispatch('click');
  await settle();
  assert.ok(mount.textContent.includes('ha offerte collegate: si può archiviare, non eliminare'), mount.textContent);
  assert.equal(navigated.length, 0, 'nessun cambio di schermata');
  assert.ok(button('contact-archive'), 'Archivia resta a portata');
});

test('91c92940: un contatto archiviato mostra «Archiviato» e «Ripristina», non Archivia né Elimina', async () => {
  const { mount, api, button } = await open({ card: { ...CARD, archivedAt: '2026-11-20T09:00:00.000Z' } });
  assert.ok(mount.textContent.includes('Archiviato'));
  assert.equal(button('contact-archive'), undefined);
  assert.equal(button('contact-delete'), undefined);
  button('contact-restore').dispatch('click');
  await settle();
  assert.deepEqual(api.writes[0], { path: '/api/contacts/c1/restore', method: 'POST' });
});

test('review Muse #1107 (P2): con un\'archiviazione in volo, un ridisegno non riabilita i bottoni e non parte un secondo POST', async () => {
  let release;
  const doc = createFakeDocument();
  const mount = createMount();
  const writes = [];
  const api = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options.method ?? 'GET') !== 'GET') {
        writes.push(path);
        await new Promise((resolve) => { release = resolve; });
        return { ok: true };
      }
      if (path.includes('/api/customer-hub/card/')) return CARD;
      if (path.includes('/api/customer-hub/timeline/')) return { entries: { items: [] } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
  const view = createCustomerCardView({ doc, mount, client: api, navigate: () => {}, toast: () => {} });
  await view.renderCard('contact', 'c1');
  const button = (action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
  button('contact-archive').dispatch('click');
  await settle();
  await view.renderCard('contact', 'c1');
  assert.equal(button('contact-archive').getAttribute('disabled'), '', 'the repainted Archivia is still off');
  assert.equal(button('contact-delete').getAttribute('disabled'), '', 'and so is Elimina');
  button('contact-archive').dispatch('click');
  await settle();
  assert.equal(writes.length, 1, 'one POST only');
  release();
  await settle();
});

test('91c92940: la card senza archivedAt (prima della condizione su #1077) mostra Archivia ed Elimina', async () => {
  const { button } = await open();
  assert.ok(button('contact-archive'));
  assert.equal(button('contact-restore'), undefined);
});
