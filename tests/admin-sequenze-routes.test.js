// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../apps/server/src/index.js';

/**
 * The sequences creation surface (backlog:1d0986a01a7b): `POST
 * /api/sequences/create` rides the declared sequences create-sequence
 * operation. Without the package composed the route answers an honest 404;
 * with it composed the input (server-controlled keys stripped) reaches the
 * operation with the caller actor, and the answer is a 201.
 */

function stubApp(overrides = {}) {
  const calls = [];
  return {
    calls,
    async createSequence(input) {
      calls.push({ method: 'createSequence', input });
      return { sequence: { ...input, id: 9, status: 'draft' }, steps: [], replayed: false };
    },
    ...overrides,
  };
}

async function withServer(app, fn) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('create rides the composed operation with the caller actor', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/sequences/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' },
      body: JSON.stringify({
        spaceId: 'presti',
        sourceKey: 'bo-seq-1',
        name: 'Bentornato',
        triggerLabel: 'lead dal sito',
        stopLabel: null,
        steps: [{ dayOffset: 0, channel: 'whatsapp', templateName: 'Ciao', templateLanguage: 'it', templateVars: [] }],
      }),
    });
    assert.equal(response.status, 201);
    const call = app.calls.find((entry) => entry.method === 'createSequence');
    assert.equal(call.input.name, 'Bentornato');
    assert.equal(call.input.spaceId, 'presti');
    assert.deepEqual(call.input.actor, { type: 'user', id: 'op-1' });
  });
});

test('server-controlled keys never reach the operation', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/sequences/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' },
      body: JSON.stringify({ spaceId: 'presti', sourceKey: 'bo-seq-2', name: 'X', steps: [], actor: { type: 'root', id: 'root' } }),
    });
    assert.equal(response.status, 201);
    const call = app.calls.find((entry) => entry.method === 'createSequence');
    assert.deepEqual(call.input.actor, { type: 'user', id: 'op-1' });
  });
});

test('a non-object body fails closed', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/sequences/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' },
      body: JSON.stringify([1, 2]),
    });
    assert.equal(response.status, 400);
    assert.equal(app.calls.length, 0);
  });
});

test('without the sequences package the route answers 404, never 500', async () => {
  const app = stubApp({ createSequence: undefined });
  delete app.createSequence;
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/sequences/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' },
      body: JSON.stringify({ spaceId: 'presti', sourceKey: 'bo-seq-3', name: 'X', steps: [] }),
    });
    assert.equal(response.status, 404);
  });
});
