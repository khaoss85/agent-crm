import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpServer,
} from '../apps/server/src/http-server.js';
import { AppError } from '../packages/core/index.js';

/**
 * Scheda cliente «Arricchito dall'AI» (backlog:e5e3e886, seguito di
 * backlog:b9f6a2b58e00).
 *
 * Production 13/11: «Aggiorna» faceva solo GET /api/customer-data/enriched
 * (items:[]) e in meno di 1 s mostrava «Nessun dato nuovo» — prometteva
 * un'azione che non faceva. L'avvio dell'estrazione esisteva solo nella
 * vecchia scheda /customers/<identity>.
 *
 * What this must prove against the real route: «Aggiorna» starts one
 * extraction run with a POST carrying the linked sources
 * (/api/customer-data/enriched/:resource/:id/extract), gated
 * `records.write` like every other write; the session actor travels to the
 * operation while a body actor is stripped; without the package composed
 * the route answers an honest 404 naming the operation; without an AI
 * adapter the refusal travels as 503 ENRICHMENT_AI_UNAVAILABLE, never
 * «Nessun dato nuovo».
 *
 * A stub app keeps this instant and deterministic: no sqlite, no provider.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'extract-route',
};

const SOURCES = [{
  kind: 'channel-message',
  text: 'Ciao, sono Guido, mi alleno la sera dopo le 19',
  detail: 'whatsapp:+393331234567',
}];

function stubApp({ calls = [], withExtract = true, extract = null } = {}) {
  return {
    ...(withExtract ? {
      async extractCustomerEnrichment(params) {
        calls.push(params);
        if (typeof extract === 'function') return extract(params);
        return {
          status: 'done',
          subject: { resource: params.resource, id: params.id },
          runId: 'run-1',
          counts: { proposed: 1, replayed: 0, alreadyActive: 0, skippedDismissed: 0 },
          proposals: [{
            id: 'p1', field: 'note', value: 'si allena la sera',
            source: 'channel-message', sourceDetail: 'whatsapp:+393331234567',
            observedAt: '2026-11-13T08:00:00.000Z',
          }],
        };
      },
    } : {}),
  };
}

async function request(t, app, method, path, body) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

const PATH = '/api/customer-data/enriched/contact/c1/extract';

test('e5e3e886: POST extract starts one run over the linked sources and answers its proposals', async (t) => {
  const calls = [];
  const { status, payload } = await request(t, stubApp({ calls }), 'POST', PATH, { sources: SOURCES });
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resource, 'contact');
  assert.equal(calls[0].id, 'c1');
  assert.deepEqual(calls[0].sources, SOURCES);
  assert.equal(calls[0].actor?.type, 'user', 'the human actor travels to the operation');
  assert.equal(calls[0].actor?.id, 'extract-route');
  assert.deepEqual(payload?.proposals?.map((proposal) => proposal.field), ['note']);
  assert.equal(payload?.proposals[0]?.source, 'channel-message');
});

test('e5e3e886: a body actor is stripped, the session actor runs', async (t) => {
  const calls = [];
  const { status } = await request(t, stubApp({ calls }), 'POST', PATH, {
    sources: SOURCES, actor: { type: 'user', id: 'someone-else' },
  });
  assert.equal(status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor?.id, 'extract-route',
    'a caller-supplied actor never reaches the operation');
});

test('e5e3e886: without the package composed the route answers an honest 404', async (t) => {
  const { status, payload } = await request(t, stubApp({ withExtract: false }), 'POST', PATH, { sources: SOURCES });
  assert.equal(status, 404);
  assert.match(String(payload?.error?.message ?? payload?.error?.code ?? ''), /customer enrichment extraction/i,
    'the 404 names the missing operation');
});

test('e5e3e886: without an AI adapter the refusal travels as 503, never silent', async (t) => {
  const { status, payload } = await request(t, stubApp({
    extract: () => {
      throw new AppError('no AI extraction is active for this space', { code: 'ENRICHMENT_AI_UNAVAILABLE', status: 503 });
    },
  }), 'POST', PATH, { sources: SOURCES });
  assert.equal(status, 503);
  assert.equal(payload?.error?.code, 'ENRICHMENT_AI_UNAVAILABLE');
});

test('e5e3e886: the old read stays a GET — POST on it is not the extraction', async (t) => {
  const calls = [];
  const { status } = await request(t, stubApp({ calls }), 'POST', '/api/customer-data/enriched/contact/c1', { sources: SOURCES });
  assert.notEqual(status, 200);
  assert.equal(calls.length, 0, 'no extraction run starts off-route');
});
