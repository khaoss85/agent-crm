// @ts-check

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_DEBOUNCE_MS, createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:29bb3f2c0d64 (production 08/11, pilot fc3fa62): the Calendar
 * customer search sent one request per keystroke. On the small web instance
 * they queued — about 30 s on the first round («L'elenco non si è potuto
 * leggere»), then about 5 s each, against 0.5 s for one read alone. Typing
 * now waits SEARCH_DEBOUNCE_MS of quiet, a newer search aborts the one in
 * flight, and an old answer never paints over a newer one.
 */

const flush = async () => {
  for (let round = 0; round < 6; round += 1) await Promise.resolve();
};

function searchClient() {
  /** @type {Array<{path: string, signal: any, resolve: (value: any) => void, reject: (error: any) => void}>} */
  const searches = [];
  return {
    searches,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/customer-data/customers')) {
        return new Promise((resolve, reject) => {
          const entry = { path, signal: /** @type {any} */ (options).signal ?? null, resolve, reject };
          entry.signal?.addEventListener?.('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
          searches.push(entry);
        });
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function openView(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createFakeDocument();
  const mount = createMount();
  const client = searchClient();
  const space = { id: 'space-a' };
  const storage = {
    getItem: (key) => (key === 'accordo.activeSpace' ? space.id : null),
    setItem: () => {},
    removeItem: () => {},
  };
  const view = createCalendarioView({ doc, mount, client, storage, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await flush();
  // The live field: a repaint replaces it, so it is looked up on each use.
  const field = () => mount.querySelector('input[name="customerSearch"]');
  const type = (text) => { const node = field(); node.value = text; node.dispatch('input'); };
  const results = () => mount.querySelector('[data-role="customer-results"]')?.textContent ?? '';
  return { view, client, type, results, mount, space };
}

const qOf = (path) => new URL(path, 'http://x.test').searchParams.get('q');

test('29bb3f2c0d64: five fast keystrokes send one request, after the quiet time', async (t) => {
  const { client, type } = await openView(t);
  for (const text of ['Pr', 'Pro', 'Prov', 'Prova', 'Prova ']) {
    type(text);
    t.mock.timers.tick(80);
  }
  await flush();
  assert.equal(client.searches.length, 0, 'nothing is read while the operator types');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  assert.equal(client.searches.length, 1, 'one request for the whole word');
  assert.equal(qOf(client.searches[0].path), 'Prova');
  assert.equal(SEARCH_DEBOUNCE_MS, 300);
});

test('29bb3f2c0d64: a newer search aborts the one in flight and its late answer never paints', async (t) => {
  const { client, type, results } = await openView(t);
  type('Ada');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  assert.equal(client.searches.length, 1);
  const first = client.searches[0];
  type('Prova');
  assert.equal(first.signal?.aborted, true, 'the old request is aborted at the next keystroke');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  assert.equal(client.searches.length, 2);
  client.searches[1].resolve({ items: [{ resource: 'contact', id: 'p1', name: 'Prova verifica' }], complete: true });
  await flush();
  // The old answer arrives late anyway (a server that ignored the abort).
  first.resolve({ items: [{ resource: 'contact', id: 'a1', name: 'Ada Rossi' }], complete: true });
  await flush();
  assert.match(results(), /Prova verifica/);
  assert.doesNotMatch(results(), /Ada Rossi/, 'the stale answer never paints over the newer one');
  assert.doesNotMatch(results(), /non si è potuto leggere/, 'an aborted request is no failure');
});

test('29bb3f2c0d64: leaving the Calendar drops a search still waiting', async (t) => {
  const { view, client, type } = await openView(t);
  type('Prova');
  view.invalidate();
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  assert.equal(client.searches.length, 0, 'no request after the route away');
});

test('review #690 (P1): a space switch drops the customer search of the old space', async (t) => {
  const { view, client, type, results, mount, space } = await openView(t);
  // A request of space A is in flight, and a second keystroke waits.
  type('Ada');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  assert.equal(client.searches.length, 1);
  const inFlight = client.searches[0];
  assert.match(inFlight.path, /spaceId=space-a/);
  type('Adal');
  // The operator switches to space B before any answer.
  space.id = 'space-b';
  await view.render();
  await flush();
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS * 2);
  await flush();
  assert.equal(client.searches.length, 1, 'the pending timer of space A never fires under B');
  assert.equal(inFlight.signal?.aborted, true, 'the request of space A is aborted');
  // Even an answer that arrives anyway never paints in B.
  inFlight.resolve({ items: [{ resource: 'contact', id: 'a1', name: 'Ada di A' }], complete: true });
  await flush();
  assert.doesNotMatch(results(), /Ada di A/, 'no customer of A in B');
  assert.equal(mount.querySelector('input[name="customerSearch"]').value, '', 'the query of A does not carry over');
});

test('review #690 (P1): an answer read for another space never paints, even without an abort', async (t) => {
  const { client, type, results, space } = await openView(t);
  type('Ada');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  // The space changes under the view (another tab) with no repaint yet.
  space.id = 'space-b';
  client.searches[0].resolve({ items: [{ resource: 'contact', id: 'a1', name: 'Ada di A' }], complete: true });
  await flush();
  assert.doesNotMatch(results(), /Ada di A/);
});

test('review #690 (P2): picking a customer ends the search, no read lands after the choice', async (t) => {
  const { client, type, results, mount } = await openView(t);
  type('Ada');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS);
  await flush();
  client.searches[0].resolve({ items: [{ resource: 'contact', id: 'a1', name: 'Ada Rossi' }], complete: true });
  await flush();
  // A further keystroke is pending when the operator picks the shown name.
  type('Ada R');
  const choice = mount.findAll('button').find((node) => node.textContent === 'Ada Rossi');
  assert.ok(choice, 'the result is listed');
  choice.dispatch('click');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS * 2);
  await flush();
  assert.equal(client.searches.length, 1, 'no search starts after the choice');
  assert.ok(mount.findAll('p').some((node) => node.getAttribute('data-role') === 'customer-pick' && node.textContent === 'Ada Rossi'), 'the pick stands');
  // «Cambia cliente» resets with nothing pending either.
  const change = mount.findAll('button').find((node) => node.textContent === 'Cambia cliente');
  change.dispatch('click');
  t.mock.timers.tick(SEARCH_DEBOUNCE_MS * 2);
  await flush();
  assert.equal(client.searches.length, 1, 'no search after the reset');
  assert.equal(results(), '', 'an empty search box, no stale rows');
});
