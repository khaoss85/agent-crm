import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { consumeAgentPrefill, createAgentiView } from '../apps/admin/public/admin-agenti.js';

/**
 * backlog:a391aa36c661: «Apri Agenti →» from the assistant carries the
 * phrase to the card — the Agenti view reads it once and pre-fills the
 * card's draft, without overwriting what the operator already typed.
 */

const NOW = '2026-11-07T10:00:00.000Z';
const RIAGGANCIO = { id: 1, sourceKey: 'agent:presti:riaggancio', spaceId: 'presti', name: 'Riaggancio', role: 'Ricontatta i clienti', status: 'active' };

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

function driveClient() {
  const calls = [];
  return {
    calls,
    request: async (path, options = {}) => {
      const method = String(options.method ?? 'GET').toUpperCase();
      calls.push({ path, method });
      if (path.startsWith('/api/agents/catalog')) return { agents: [] };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: [{ ...RIAGGANCIO }] };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: [] };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('consumeAgentPrefill reads the carried phrase once, then it is gone', () => {
  const store = fakeStorage({ 'bo.agenti.prefill': JSON.stringify({ sourceKey: RIAGGANCIO.sourceKey, phrase: 'occupati dei lead' }) });
  assert.deepEqual(consumeAgentPrefill(store), { sourceKey: RIAGGANCIO.sourceKey, phrase: 'occupati dei lead' });
  assert.equal(consumeAgentPrefill(store), null, 'read-once: a repaint never replays it');
});

test('consumeAgentPrefill refuses hostile or empty payloads, still consuming them', () => {
  for (const raw of ['{not json', JSON.stringify({ sourceKey: '', phrase: 'x' }), JSON.stringify({ sourceKey: 'k' }), '']) {
    const store = fakeStorage({ 'bo.agenti.prefill': raw });
    assert.equal(consumeAgentPrefill(store), null, JSON.stringify(raw));
    assert.equal(store.getItem('bo.agenti.prefill'), null, 'nothing stale survives');
  }
  assert.equal(consumeAgentPrefill(fakeStorage()), null, 'no store entry, no phrase');
  assert.equal(consumeAgentPrefill(null), null, 'no store at all, no phrase');
});

test('«Apri Agenti →» pre-fills the card draft with the carried phrase', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const prefillStorage = fakeStorage({
    'bo.agenti.prefill': JSON.stringify({ sourceKey: RIAGGANCIO.sourceKey, phrase: 'occupati dei lead' }),
  });
  const view = createAgentiView({ doc, mount, client: driveClient(), prefillStorage, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const input = mount.querySelector(`input[name="talk-${RIAGGANCIO.sourceKey}"]`);
  assert.ok(input, 'the card input is painted');
  assert.equal(input.value, 'occupati dei lead');
  assert.equal(prefillStorage.getItem('bo.agenti.prefill'), null, 'consumed on the first paint');
});

test('a repaint never overwrites what the operator already typed', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const prefillStorage = fakeStorage({
    'bo.agenti.prefill': JSON.stringify({ sourceKey: RIAGGANCIO.sourceKey, phrase: 'occupati dei lead' }),
  });
  const view = createAgentiView({ doc, mount, client: driveClient(), prefillStorage, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const input = mount.querySelector(`input[name="talk-${RIAGGANCIO.sourceKey}"]`);
  input.value = 'fai da te';
  input.dispatch('input', {});
  view.paint();
  const again = mount.querySelector(`input[name="talk-${RIAGGANCIO.sourceKey}"]`);
  assert.equal(again.value, 'fai da te', 'the carried phrase lost the race, the operator wins');
});

test('a phrase for an unknown card is dropped, never painted', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const prefillStorage = fakeStorage({
    'bo.agenti.prefill': JSON.stringify({ sourceKey: 'agent:presti:sconosciuto', phrase: 'ciao' }),
  });
  const view = createAgentiView({ doc, mount, client: driveClient(), prefillStorage, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  assert.equal(mount.querySelector('input[name="talk-agent:presti:sconosciuto"]'), null);
  assert.equal(prefillStorage.getItem('bo.agenti.prefill'), null, 'a stale key never survives');
});
