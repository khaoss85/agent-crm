// @ts-check

/**
 * Backlog 4cfa30c164ca (verifica Mac 13/11 20:49Z, pilota 925e6dd con
 * agent-crm ae930cf): dopo Esc sui menu «+ Nuovo spazio» e
 * «Invita persona» il focus va su BODY invece di tornare al pulsante.
 * Il menu «+ Nuovo spazio» è già provato in tests/admin-spazi-accessi.test.js
 * (backlog:dd570f6d501e); qui si prova «Invita persona», per entrambe le
 * strade con cui Esc arriva: il gestore sul menu e quello a livello
 * documento (il caso vero, dove render() ha già tolto il pulsante dal DOM
 * e il focus sta sul body).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaziAccessiView } from '../apps/admin/public/admin-spazi-accessi.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const SPACE = 'spazio-1';

function stubClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/context') {
        return {
          identity: { subject: 'google|sessione-test' },
          membership: { role: 'owner', subject: 'google|sessione-test' },
          roles: { owner: [], operator: [], observer: [] },
        };
      }
      if (path === '/api/spine/memberships') {
        return { items: [{ subject: 'google|sessione-test', role: 'owner', status: 'active' }] };
      }
      if (path.startsWith('/api/space-permissions/effective')) return { spaceId: SPACE, overrides: [] };
      if (path.startsWith('/api/connectors/activity')) return { spaceId: SPACE, needsFix: 0 };
      if (path.startsWith('/api/connectors')) return { spaceId: SPACE, connectors: [] };
      if (path.includes('/api/modules/data-quality-issue/records')) return { items: [] };
      if (path.includes('/api/modules/duplicate-candidate/records')) return { items: [] };
      if (path.startsWith('/api/customer-data/customers')) {
        return { items: [], page: 1, pageSize: 10, pages: 0, total: 0, totalIsExact: true };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
}

function makeView(doc) {
  const mount = createMount();
  const seen = { toast: [], navigated: [] };
  const v = createSpaziAccessiView({
    doc,
    mount,
    client: stubClient(),
    navigate: (hash) => seen.navigated.push(hash),
    spaces: () => [{ id: SPACE, name: 'Negozio', initials: 'NE' }],
    activeSpaceId: () => SPACE,
    onPickSpace: () => {},
    toast: (message, error = false) => seen.toast.push({ message, error }),
  });
  return { mount, view: v };
}

const inviteToggle = (mount) => mount.querySelector('button[data-menu="invita-persona"]');
const inviteMenu = (mount) => mount.querySelector('div[aria-label="Invita persona"]');

test('4cfa30c164ca: Escape nel menu «Invita persona» lo chiude e il focus torna al pulsante', async () => {
  const { mount, view: v } = makeView(createFakeDocument());
  await v.render();
  await flush();
  assert.ok(inviteToggle(mount), 'il pulsante «Invita persona» c’è');
  await inviteToggle(mount).listeners.click[0]();
  await flush();
  assert.ok(inviteMenu(mount), 'il menu si apre');
  inviteMenu(mount).dispatch('keydown', { key: 'Escape' });
  await flush();
  assert.equal(inviteMenu(mount), null, 'Escape chiude il menu');
  assert.equal(inviteToggle(mount).getAttribute('aria-expanded'), 'false', 'il pulsante dice che il menu è chiuso');
  assert.equal(inviteToggle(mount).__focused, true, 'il focus torna al pulsante che ha aperto il menu');
});

test('4cfa30c164ca: Escape a livello documento con «Invita persona» aperto chiude e ridà il focus al pulsante', async () => {
  const doc = createFakeDocument();
  // Il finto documento non ha ascoltatori: gli si dà la superficie che un
  // documento vero ha, così il test percorre la strada del browser, dove
  // dopo render() il focus sta sul body e Esc arriva solo al documento.
  const docListeners = Object.create(null);
  doc.addEventListener = (type, handler) => { (docListeners[type] ??= []).push(handler); };
  const fireDoc = (type, event) => { for (const handler of docListeners[type] ?? []) handler(event); };
  const { mount, view: v } = makeView(doc);
  await v.render();
  await flush();
  await inviteToggle(mount).listeners.click[0]();
  await flush();
  assert.ok(inviteMenu(mount), 'il menu si apre');
  fireDoc('keydown', { key: 'Escape', target: null });
  await flush();
  assert.equal(inviteMenu(mount), null, 'Escape chiude il menu');
  assert.equal(inviteToggle(mount).__focused, true, 'il focus torna al pulsante anche dalla strada del documento');
});
