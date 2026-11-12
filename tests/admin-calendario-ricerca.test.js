// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:d128847d21fc: a customer search the server read only in part
 * (complete:false) never answers a flat «Nessun cliente corrisponde».
 */

function client(answer) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/customer-data/customers')) return answer;
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function search(answer, text) {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client: client(answer), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const field = mount.querySelector('input[name="customerSearch"]');
  field.value = text;
  field.dispatch('input');
  for (let round = 0; round < 7; round += 1) await new Promise((resolve) => setImmediate(resolve));
  return mount.querySelector('[data-role="customer-results"]').textContent;
}

test('d128847d21fc: an empty answer over a partial list says the list is partial', async () => {
  const text = await search({ items: [], total: 0, complete: false }, 'Zzz');
  assert.match(text, /elenco è parziale/, text);
});

test('d128847d21fc: an empty answer over a complete list keeps the plain sentence', async () => {
  const text = await search({ items: [], total: 0, complete: true }, 'Zzz');
  assert.match(text, /Nessun cliente corrisponde\. Prova con un altro nome\./, text);
});

test('7d82fd84: items over a partial list still say the list is partial', async () => {
  const text = await search(
    { items: [{ name: 'Ada Rossi', resource: 'contact', id: 'c1' }], total: 1, complete: false },
    'Ada',
  );
  assert.match(text, /Ada Rossi/, text);
  assert.match(text, /L’elenco è parziale/, text);
});

test('7d82fd84: items over a complete list say nothing about partial', async () => {
  const text = await search(
    { items: [{ name: 'Ada Rossi', resource: 'contact', id: 'c1' }], total: 1, complete: true },
    'Ada',
  );
  assert.match(text, /Ada Rossi/, text);
  assert.doesNotMatch(text, /parziale/, text);
});
