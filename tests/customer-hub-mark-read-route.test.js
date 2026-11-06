import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpServer,
} from '../apps/server/src/http-server.js';
import { NotFoundError } from '../packages/core/src/errors.js';

/**
 * Scheda cliente «segna come letto» (backlog:9e003582).
 *
 * Cosa deve provare: la rotta POST /api/customer-hub/mark-read porta
 * all'operazione i campi del body più l'attore della sessione e risponde
 * 200; un attore nel body viene buttato, mai usato per segnare al posto di
 * un altro; un cliente fantasma rifiuta 404; una risorsa sbagliata rifiuta
 * 400; senza operazione composta la rotta è un 404 onesto. Uno stub tiene
 * tutto istantaneo e deterministico: niente sqlite, niente provider.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'scheda-route',
};

function stubApp({ marks = [], contacts = null, companies = null, markCustomerRead = null } = {}) {
  return {
    services: {
      contacts: {
        get: contacts ?? (async (id) => {
          if (id !== 'c1') throw new NotFoundError('Contact', String(id));
          return { id: 'c1' };
        }),
      },
      companies: {
        get: companies ?? (async (id) => { throw new NotFoundError('Company', String(id)); }),
      },
    },
    ...(markCustomerRead === null ? {} : {
      async markCustomerRead(params) {
        marks.push(params);
        return { subject: { resource: params.resource, id: params.id }, memberId: params.actor?.id, upTo: params.upTo, conversations: [], touched: 0 };
      },
    }),
  };
}

async function post(t, app, path, body) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

const MARK_BASE = { resource: 'contact', id: 'c1', upTo: '2026-11-06T10:02:00.000Z' };

test('9e003582: segna-letto passa body e attore della sessione e risponde 200', async (t) => {
  const marks = [];
  const { status, payload } = await post(t, stubApp({ marks, markCustomerRead: true }), '/api/customer-hub/mark-read', MARK_BASE);
  assert.equal(status, 200);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].resource, 'contact');
  assert.equal(marks[0].id, 'c1');
  assert.equal(marks[0].upTo, '2026-11-06T10:02:00.000Z');
  assert.equal(marks[0].actor?.id, 'scheda-route', 'segna chi ha aperto la scheda, mai un nome del body');
  assert.equal(payload?.memberId, 'scheda-route');
});

test('9e003582: un attore nel body viene buttato, nessuno segna per un altro', async (t) => {
  const marks = [];
  const { status } = await post(t, stubApp({ marks, markCustomerRead: true }), '/api/customer-hub/mark-read', {
    ...MARK_BASE, actor: { type: 'user', id: 'mallory' },
  });
  assert.equal(status, 200);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].actor?.id, 'scheda-route');
});

test('9e003582: segnare un cliente fantasma rifiuta 404, senza lasciare watermark', async (t) => {
  const marks = [];
  const { status, payload } = await post(t, stubApp({ marks, markCustomerRead: true }), '/api/customer-hub/mark-read', {
    ...MARK_BASE, id: 'fantasma',
  });
  assert.equal(status, 404);
  assert.equal(marks.length, 0, 'nessuna segnatura su un cliente che non esiste');
});

test('9e003582: una risorsa sbagliata rifiuta 400', async (t) => {
  const marks = [];
  const { status, payload } = await post(t, stubApp({ marks, markCustomerRead: true }), '/api/customer-hub/mark-read', {
    resource: 'opportunity', id: 'c1', upTo: '2026-11-06T10:02:00.000Z',
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.code, 'VALIDATION_ERROR');
  assert.equal(marks.length, 0);
});

test('9e003582: senza operazione composta la rotta è un 404 onesto', async (t) => {
  const app = stubApp({});
  delete app.markCustomerRead;
  const { status, payload } = await post(t, app, '/api/customer-hub/mark-read', MARK_BASE);
  assert.equal(status, 404);
  assert.equal(payload?.error?.code, 'NOT_FOUND');
});
