import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpServer } from '../apps/server/src/index.js';

/**
 * Generic mutation on a private booking (backlog:9aa5c073, review
 * rev-agent-crm-1088-b49aadcb26d0 P1).
 *
 * The package's own mutation paths answer 404 for anyone but the booking
 * creator and the administrators — the same not-found answer as a missing
 * row, so the mutation cannot reveal that a private booking exists
 * (`refuseUnlessSeesFull`). The generic HTTP surface refused the same call
 * with 403 ForbiddenError instead: a teammate probing ids could tell an
 * existing private booking (403) apart from a missing row (404).
 *
 * The cure answers 404 from the one shared gate the generic PATCH and the
 * generic action POST both cross — never a 403, and the write never runs.
 */

const PRIVATE_ROW = Object.freeze({
  id: 'a-priv',
  status: 'booked',
  startsAt: '2026-11-20T17:00:00.000Z',
  endsAt: '2026-11-20T18:00:00.000Z',
  teamMemberId: 'coach-guido',
  visibility: 'private',
  actorId: 'creator-A',
  subjectResource: 'contact',
  subjectId: 'c-presti',
  serviceKey: 'pt-single',
  notes: 'Preferisce il silenzio',
  priceCents: 4000,
  currency: 'EUR',
  sourceKey: 'gym:mutation:1',
  sourcePackage: 'host',
});

function stubApp() {
  const calls = [];
  const rows = [{ ...PRIVATE_ROW }];
  const appointment = {
    name: 'appointment',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['create', 'get', 'list', 'update'],
    fields: [{ name: 'notes', type: 'string', required: false, unique: false }],
    filterableFields: ['id', 'status', 'teamMemberId', 'startsAt'],
    service: {
      async list({ limit, where } = {}) {
        calls.push({ method: 'list', limit, where });
        return rows.filter((row) => !where
          || Object.entries(where).every(([key, value]) => String(row[key]) === String(value)));
      },
      async get(id) {
        return rows.find((row) => row.id === id) ?? null;
      },
      async create() {
        throw new Error('not used here');
      },
      async update(id, input) {
        calls.push({ method: 'update', id, input });
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) throw new Error('update ran on a missing row');
        rows[index] = { ...rows[index], ...input };
        return rows[index];
      },
    },
  };
  return {
    calls,
    modules: {
      get(name) {
        if (name === 'appointment') return appointment;
        throw new Error(`unknown module ${name}`);
      },
      list() {
        return [appointment];
      },
    },
    actions: {
      listForModule() {
        return [];
      },
    },
    async runAction(input) {
      calls.push({ method: 'runAction', input });
      return { ok: true, recordId: input.recordId };
    },
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

const as = (actorId) => ({
  'x-actor-type': 'user',
  'x-actor-id': actorId,
  'content-type': 'application/json',
  connection: 'close',
});

test("9aa5c073 rev-1088 P1: a teammate's generic PATCH on someone else's private booking answers 404, never 403, and never mutates", async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/modules/appointment/records/a-priv`, {
      method: 'PATCH',
      headers: as('teammate-B'),
      body: JSON.stringify({ notes: 'prova a sovrascrivere' }),
    });
    assert.equal(response.status, 404, 'a private booking must read as not-found, not forbidden');
    const body = await response.json();
    assert.equal(body?.error?.code, 'NOT_FOUND');
    assert.ok(!JSON.stringify(body).includes('c-presti'), 'the refusal leaks no customer');
    assert.ok(!JSON.stringify(body).includes('Preferisce il silenzio'), 'the refusal leaks no notes');
    assert.deepEqual(
      app.calls.filter((call) => call.method === 'update'),
      [],
      'the refused write must never run',
    );

    // A missing row answers exactly the same 404: the two are indistinguishable.
    const missing = await fetch(`${base}/api/modules/appointment/records/a-missing`, {
      method: 'PATCH',
      headers: as('teammate-B'),
      body: JSON.stringify({ notes: 'x' }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json())?.error?.code, 'NOT_FOUND');
  });
});

test('9aa5c073 rev-1088 P1: the creator still patches their own private booking', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/modules/appointment/records/a-priv`, {
      method: 'PATCH',
      headers: as('creator-A'),
      body: JSON.stringify({ notes: 'nota aggiornata' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).notes, 'nota aggiornata');
    assert.equal(app.calls.filter((call) => call.method === 'update').length, 1);
  });
});

test("9aa5c073 rev-1088 P1: a teammate's generic action on someone else's private booking answers 404, never 403, and never runs", async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/modules/appointment/records/a-priv/actions/cancel`, {
      method: 'POST',
      headers: as('teammate-B'),
      body: JSON.stringify({ reason: 'prova' }),
    });
    assert.equal(response.status, 404, 'a private booking must read as not-found, not forbidden');
    assert.equal((await response.json())?.error?.code, 'NOT_FOUND');
    assert.deepEqual(
      app.calls.filter((call) => call.method === 'runAction'),
      [],
      'the refused action must never run',
    );
  });
});

test('9aa5c073 rev-1088 P1: the creator still runs a generic action on their own private booking', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/modules/appointment/records/a-priv/actions/cancel`, {
      method: 'POST',
      headers: as('creator-A'),
      body: JSON.stringify({ reason: 'paziente chiede' }),
    });
    assert.equal(response.status, 200);
    assert.equal(app.calls.filter((call) => call.method === 'runAction').length, 1);
  });
});
