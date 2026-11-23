// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { aiBlockOf, calendarRefusalText, createCalendarioView, isProviderFailure } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:afa97ffe5a4d (production 18/11, live a7bd751 con agent-crm
 * 0b31f09: «30 minuti con daniele pelleri giovedì…» → 502
 * LLM_PROVIDER_FAILED, a schermo «Ricerca non riuscita. Riprova più
 * tardi.»). Un errore del provider AI ritenta una volta e poi dice in
 * italiano che l'assistente non risponde, proponendo il modulo manuale.
 */

const PHRASE = '30 minuti con daniele pelleri giovedì';

function providerClient({ failures, phraseAnswer = { draft: null } } = {}) {
  const calls = [];
  let seen = 0;
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path === '/api/appointments/phrase') {
        seen += 1;
        if (seen <= failures) throw Object.assign(new Error('provider failed'), { status: 502, code: 'LLM_PROVIDER_FAILED' });
        return phraseAnswer;
      }
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle() {
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A fake document whose focus() tracks activeElement like a browser. */
function focusingDocument() {
  const doc = /** @type {any} */ (createFakeDocument());
  const create = doc.createElement;
  doc.createElement = (/** @type {string} */ tag) => {
    const node = create(tag);
    node.focus = () => { node.__focused = true; doc.activeElement = node; };
    return node;
  };
  return doc;
}

async function askPhrase(client) {
  const doc = focusingDocument();
  const mount = createMount();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  const box = mount.querySelector('textarea[name="phrase"]');
  box.value = PHRASE;
  box.dispatch('input');
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await settle();
  return { doc, mount };
}

const phrasePosts = (client) => client.calls.filter((path) => path === '/api/appointments/phrase').length;

test('afa97ffe5a4d: the provider error retries the same POST once, then the answer lands', async () => {
  const client = providerClient({ failures: 1 });
  const { mount } = await askPhrase(client);
  assert.equal(phrasePosts(client), 2, 'one retry of the same POST, never a third');
  assert.ok(mount.textContent.includes('Nessuna bozza dalla frase'), mount.textContent);
  assert.ok(!mount.textContent.includes('non risponde'), 'a recovered retry says nothing about the outage');
});

test('afa97ffe5a4d: two provider errors say in Italian the assistant is not answering and offer the manual form', async () => {
  const client = providerClient({ failures: 2 });
  const { mount } = await askPhrase(client);
  assert.equal(phrasePosts(client), 2, 'exactly one retry, then the card gives up');
  const card = mount.querySelector('.cal-ai');
  const line = 'L’assistente non risponde: riprova tra poco, oppure compila l’appuntamento a mano.';
  assert.ok(card.textContent.includes(line), card.textContent);
  assert.ok(!card.textContent.includes('Ricerca non riuscita'), 'never the generic line on a named provider failure');
  const button = card.findAll('button').find((node) => node.textContent === 'Compila a mano');
  assert.ok(button, 'the card proposes the manual form');
  button.dispatch('click');
  const notes = mount.querySelector('input[name="notes"]');
  assert.equal(notes.value, PHRASE, 'the phrase rides into the Note field');
});

test('afa97ffe5a4d: a non-provider error retries nothing and keeps the generic line', async () => {
  const calls = [];
  const client = {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path === '/api/appointments/phrase') throw Object.assign(new Error('boom'), { status: 500, code: 'UNKNOWN' });
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      throw new Error(`unexpected path ${path}`);
    },
  };
  const { mount } = await askPhrase(client);
  assert.equal(phrasePosts(client), 1, 'no retry outside the provider failure');
  assert.ok(mount.textContent.includes('Ricerca non riuscita. Riprova più tardi.'), mount.textContent);
});

test('afa97ffe5a4d Codex P2 #1062: the retry resends the asked phrase, never a mid-flight edit', async () => {
  const bodies = [];
  const doc = focusingDocument();
  const mount = createMount();
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path === '/api/appointments/phrase') {
        if (bodies.length === 0) {
          // The operator keeps typing while the first POST is still pending.
          const box = mount.querySelector('textarea[name="phrase"]');
          box.value = '30 minuti con marco rossi venerdì';
          box.dispatch('input');
        }
        bodies.push(JSON.parse(String(options?.body ?? '{}'))?.phrase);
        if (bodies.length === 1) throw Object.assign(new Error('provider failed'), { status: 502, code: 'LLM_PROVIDER_FAILED' });
        return { draft: null };
      }
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      throw new Error(`unexpected path ${path}`);
    },
  };
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  const box = mount.querySelector('textarea[name="phrase"]');
  box.value = PHRASE;
  box.dispatch('input');
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await settle();
  assert.equal(bodies.length, 2, 'the provider error retries the same POST once');
  assert.equal(bodies[0], PHRASE, 'the first POST asks the typed phrase');
  assert.equal(bodies[1], PHRASE, 'the retry resends the asked phrase, not the mid-flight edit');
});

test('afa97ffe5a4d: the provider failure words and the block kind per code', () => {
  assert.equal(isProviderFailure({ code: 'LLM_PROVIDER_FAILED' }), true);
  assert.equal(isProviderFailure({ code: 'LLM_RATE_LIMITED' }), false, 'only the failed provider retries');
  assert.equal(isProviderFailure(null), false);
  assert.equal(aiBlockOf({ code: 'LLM_PROVIDER_FAILED' }), 'down');
  assert.equal(aiBlockOf({ code: 'LLM_RATE_LIMITED' }), null, 'a rate limit is still not a block');
  assert.match(calendarRefusalText({ code: 'LLM_PROVIDER_FAILED' }), /assistente non risponde/);
});
