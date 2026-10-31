import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpServer,
} from '../apps/server/src/http-server.js';
import { ValidationError } from '../packages/core/src/errors.js';

/**
 * Scheda cliente «Aggiungi telefono» and «Chiama dal CRM» routes
 * (voce 105563eea902).
 *
 * What they must prove: the phone route holds the number through the
 * composed operation and answers 201; the calls route dials the
 * server-derived card number only through an active voice connection and
 * answers 201, while a missing voice connection refuses 409
 * VOICE_CONNECTION_NOT_ACTIVE (the card then falls back to `tel:`) and a
 * card with no callable number refuses 409 CHANNEL_CALL_NO_RECIPIENT. A
 * stub app keeps this instant and deterministic: no sqlite, no provider.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'scheda-route',
};

const VOICE = { channel: 'voice', status: 'active', connectionKey: 'voice-conn:presti:1' };
const CARD = { email: 'guido@palestra-esempio.it', phone: { available: true, value: '+393331234567' }, socials: [] };
const CARD_NO_PHONE = { email: 'guido@palestra-esempio.it', phone: { available: false, value: null }, socials: [] };

function stubApp({ card = CARD, connectors = [VOICE], calls = [], phones = [] } = {}) {
  return {
    services: {
      contacts: { get: async (id) => { if (id !== 'c1') throw Object.assign(new Error('no such contact'), { status: 404, code: 'NOT_FOUND' }); return { id: 'c1' }; } },
      companies: { get: async () => { throw Object.assign(new Error('no such company'), { status: 404, code: 'NOT_FOUND' }); } },
    },
    async recordSubjectPhone(params) {
      if (!/^\+[1-9]\d{6,14}$/.test(String(params.phone ?? ''))) {
        throw new ValidationError('the phone number must be callable E.164', { field: 'phone' });
      }
      const receipt = { outcome: 'linked', system: 'phone', externalId: params.phone };
      phones.push({ ...params });
      return receipt;
    },
    async readCustomerCard() { return card; },
    async readSyncState() { return { connectors }; },
    async logSubjectCall(params) {
      const row = { id: 'call-1', replayed: false, ...params };
      calls.push(params);
      return row;
    },
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

const PHONE_BASE = { resource: 'contact', id: 'c1', phone: '+393331234567' };
const CALL_BASE = {
  resource: 'contact', id: 'c1', spaceId: 'presti', callKey: 'call-route-1',
  outcome: 'completed', durationSec: 60, teamAuthorId: 'scheda-route',
};

test('105563eea902: Aggiungi telefono stores the number and answers 201', async (t) => {
  const phones = [];
  const { status, payload } = await post(t, stubApp({ phones }), '/api/customer-hub/phone', PHONE_BASE);
  assert.equal(status, 201);
  assert.equal(payload?.outcome, 'linked');
  assert.equal(payload?.externalId, '+393331234567');
  assert.equal(phones.length, 1);
  assert.equal(phones[0].phone, '+393331234567', 'the stored number is the body number');
  assert.equal(phones[0].actor?.type, 'user', 'the human actor travels to the operation');
});

test('105563eea902: a non-E.164 phone refuses at the operation, nothing stored', async (t) => {
  const phones = [];
  const { status, payload } = await post(t, stubApp({ phones }), '/api/customer-hub/phone', {
    ...PHONE_BASE, phone: '3331234567',
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.code, 'VALIDATION_ERROR');
  assert.equal(phones.length, 0);
});

test('105563eea902: Chiama dal CRM dials the card number through voice and answers 201', async (t) => {
  const calls = [];
  const { status, payload } = await post(t, stubApp({ calls }), '/api/customer-hub/calls', {
    ...CALL_BASE, to: '+19998887777',
  });
  assert.equal(status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].remoteHandle, '+393331234567', 'the dialed number is server-derived from the card, never the caller to');
  assert.equal(calls[0].callKey, 'call-route-1');
  assert.equal(calls[0].resource, 'contact');
  assert.equal(payload?.remoteHandle, '+393331234567');
});

test('105563eea902: a caller-supplied teamAuthorId is ignored, the signed-in operator authors', async (t) => {
  const calls = [];
  const { status } = await post(t, stubApp({ calls }), '/api/customer-hub/calls', {
    ...CALL_BASE, teamAuthorId: 'someone-else',
  });
  assert.equal(status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].teamAuthorId, 'scheda-route',
    'authorship is server-derived from the actor, never a caller claim');
});

test('105563eea902: without an active voice connection the call refuses 409', async (t) => {
  const calls = [];
  const { status, payload } = await post(
    t, stubApp({ calls, connectors: [] }), '/api/customer-hub/calls', CALL_BASE,
  );
  assert.equal(status, 409);
  assert.equal(payload?.error?.code, 'VOICE_CONNECTION_NOT_ACTIVE');
  assert.equal(calls.length, 0, 'no call the CRM never placed is logged');
});

test('105563eea902: a card with no callable number refuses 409 before voice', async (t) => {
  const calls = [];
  const { status, payload } = await post(
    t, stubApp({ calls, card: CARD_NO_PHONE }), '/api/customer-hub/calls', CALL_BASE,
  );
  assert.equal(status, 409);
  assert.equal(payload?.error?.code, 'CHANNEL_CALL_NO_RECIPIENT');
  assert.equal(calls.length, 0);
});

test('105563eea902: a call without spaceId or callKey refuses 400', async (t) => {
  const calls = [];
  const app = stubApp({ calls });
  const noSpace = await post(t, app, '/api/customer-hub/calls', { ...CALL_BASE, spaceId: '  ' });
  assert.equal(noSpace.status, 400);
  const noKey = await post(t, app, '/api/customer-hub/calls', { ...CALL_BASE, callKey: '' });
  assert.equal(noKey.status, 400);
  assert.equal(calls.length, 0);
});
