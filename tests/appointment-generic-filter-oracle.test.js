import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpServer } from '../apps/server/src/index.js';

/**
 * Filter oracle on the masked generic appointment list (backlog:9aa5c073,
 * review rev-agent-crm-967-cf6947cd3194 P1).
 *
 * A private booking reads as «Occupato» for anyone but its creator and the
 * administrators — but the collection applied the caller's index filters
 * BEFORE masking. As teammate B (records.read, not the creator, not an
 * administrator) `GET /api/modules/appointment/records?filter.subjectId=X`
 * answered one masked row when the guess matched the hidden customer and
 * zero rows when it did not: the 1-vs-0 difference confirms the hidden
 * customer despite the stripped fields. Same oracle through
 * `filter.serviceKey`, `filter.sourceKey`, `filter.subjectResource` and
 * `filter.sourcePackage`.
 *
 * The cure refuses, for a caller who is not an administrator, any filter on
 * a field the masked «Occupato» projection strips — the same 400 whether or
 * not a matching private row exists, so the refusal itself answers nothing.
 * Filters on fields the masked row keeps (id, status, startsAt,
 * teamMemberId) keep working.
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
  sourceKey: 'gym:oracle:1',
  sourcePackage: 'host',
});

const PUBLIC_ROW = Object.freeze({
  id: 'a-pub',
  status: 'booked',
  startsAt: '2026-11-21T17:00:00.000Z',
  endsAt: '2026-11-21T18:00:00.000Z',
  teamMemberId: 'coach-guido',
  visibility: 'default',
  actorId: 'creator-A',
  subjectResource: 'contact',
  subjectId: 'c-altro',
  serviceKey: 'pt-altro',
  notes: 'niente da nascondere',
  priceCents: 1000,
  currency: 'EUR',
  sourceKey: 'gym:oracle:2',
  sourcePackage: 'host',
});

function stubApp() {
  const calls = [];
  const rows = [PRIVATE_ROW, PUBLIC_ROW];
  const appointment = {
    name: 'appointment',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['create', 'get', 'list', 'update'],
    fields: [
      { name: 'subjectId', type: 'string', required: false, unique: false },
      { name: 'serviceKey', type: 'string', required: false, unique: false },
    ],
    filterableFields: [
      'id',
      'sourceKey',
      'subjectResource',
      'subjectId',
      'teamMemberId',
      'serviceKey',
      'startsAt',
      'status',
      'sourcePackage',
    ],
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
      async update() {
        throw new Error('not used here');
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

const asTeammateB = {
  'x-actor-type': 'user',
  'x-actor-id': 'teammate-B',
  connection: 'close',
};

const get = (base, query) => fetch(
  `${base}/api/modules/appointment/records${query}`,
  { headers: asTeammateB },
).then(async (response) => ({ status: response.status, body: await response.json() }));

test('9aa5c073: a hidden customer is not oracleable through the generic list filters', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    // Baseline: the unfiltered list still carries the private booking, masked.
    const plain = await get(base, '');
    assert.equal(plain.status, 200);
    const masked = plain.body.items.find((row) => row.id === 'a-priv');
    assert.ok(masked, 'the private booking stays in the grid as «Occupato»');
    assert.equal(masked.masked, true);
    assert.ok(!JSON.stringify(masked).includes('c-presti'), 'masked row hides the customer');
    assert.ok(!JSON.stringify(masked).includes('Preferisce il silenzio'), 'masked row hides the notes');

    // The oracle, closed: filtering on a stripped field is refused — with the
    // same 400 whether the guess matches a private row or matches nothing.
    for (const query of [
      '?filter.subjectId=c-presti',
      '?filter.subjectId=someone-else',
      '?filter.serviceKey=pt-single',
      '?filter.sourceKey=gym:oracle:1',
      '?filter.subjectResource=contact',
      '?filter.sourcePackage=host',
    ]) {
      const answer = await get(base, query);
      assert.equal(answer.status, 400, `${query} must be refused, not answered from hidden fields`);
      assert.equal(answer.body?.error?.code, 'VALIDATION_ERROR', query);
    }

    // The refusal answers nothing by itself: a wrong guess and a right guess
    // look identical, and the filtered read never ran for either.
    const refused = app.calls.filter((call) => call.where && 'subjectId' in call.where);
    assert.deepEqual(refused, [], 'no hidden-field filter may reach the read');

    // Filters on fields the masked row keeps still work.
    const byMember = await get(base, '?filter.teamMemberId=coach-guido');
    assert.equal(byMember.status, 200);
    assert.equal(byMember.body.items.length, 2);
    const byStatus = await get(base, '?filter.status=booked');
    assert.equal(byStatus.status, 200);
    assert.equal(byStatus.body.items.length, 2);
    const byStart = await get(base, '?filter.startsAt=2026-11-20T17:00:00.000Z');
    assert.equal(byStart.status, 200);
    assert.deepEqual(byStart.body.items.map((row) => row.id), ['a-priv']);
    assert.equal(byStart.body.items[0].masked, true);
  });
});
