// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../apps/server/src/index.js';

/**
 * The calendar HTTP surface (BO-F3): the team-week and slot reads plus the
 * propose/confirm/phrase writes ride the declared appointments operations.
 * Without the package composed every route answers an honest 404; with it
 * composed the reads filter by the named members and the writes validate
 * fail-closed. Driven over real HTTP against a stub app (the full demo app
 * has no appointments package composed).
 */

function stubApp(overrides = {}) {
  const calls = [];
  return {
    calls,
    async readAppointmentTeamWeek(input) {
      calls.push({ method: 'readAppointmentTeamWeek', input });
      return { from: input.from, to: input.to, members: [] };
    },
    async suggestAppointmentSlots(input) {
      calls.push({ method: 'suggestAppointmentSlots', input });
      return { ...input, members: [] };
    },
    async proposeAppointmentBooking(input, actor) {
      calls.push({ method: 'proposeAppointmentBooking', input, actor });
      return { decision: 'confirm-required', draft: input };
    },
    async confirmAppointmentBooking(input, actor) {
      calls.push({ method: 'confirmAppointmentBooking', input, actor });
      return { decision: 'booked', appointment: { ...input, id: 'b1' } };
    },
    async parseBookingPhrase(input, actor) {
      calls.push({ method: 'parseBookingPhrase', input, actor });
      return { draft: { teamMemberId: 'marco' }, dryRun: true, spaceId: input.spaceId };
    },
    async rescheduleAppointmentBooking(input, actor) {
      calls.push({ method: 'rescheduleAppointmentBooking', input, actor });
      return { appointment: { ...input, id: 'b1', status: 'booked' }, moved: true, push: null, pushError: null };
    },
    async cancelAppointmentBooking(input, actor) {
      calls.push({ method: 'cancelAppointmentBooking', input, actor });
      return { appointment: { id: input.id, status: 'cancelled', cancelReason: input.reason }, cancelled: true, push: null, pushError: null };
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

test('team-week reads the named members in the named window', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(
      `${base}/api/appointments/team-week?teamMemberIds=marco,sara&from=2026-10-19T00:00:00.000Z&to=2026-10-26T00:00:00.000Z`,
    );
    assert.equal(response.status, 200);
    const week = app.calls.find((call) => call.method === 'readAppointmentTeamWeek');
    assert.deepEqual(week.input.teamMemberIds, ['marco', 'sara']);
    assert.equal(week.input.from, '2026-10-19T00:00:00.000Z');
  });
});

test('team-week without members fails closed, never the whole team', async () => {
  const app = stubApp({
    async readAppointmentTeamWeek(input) {
      const { readTeamWeek } = await import('../packages/appointments/src/appointments.js');
      return readTeamWeek({ appointments: { listWhere: async () => [] } }, input);
    },
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/appointments/team-week?from=x&to=y`);
    assert.equal(response.status, 400);
  });
});

test('suggest-slots forwards the step granularity', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(
      `${base}/api/appointments/suggest-slots?teamMemberIds=marco&from=2026-10-22T00:00:00.000Z&to=2026-10-23T00:00:00.000Z&slotMinutes=45`,
    );
    assert.equal(response.status, 200);
    const suggest = app.calls.find((call) => call.method === 'suggestAppointmentSlots');
    assert.equal(suggest.input.slotMinutes, 45);
  });
});

test('suggest-slots names the server now so begun steps are cut (backlog:d1e4d90e)', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(
      `${base}/api/appointments/suggest-slots?teamMemberIds=marco&from=2026-10-22T00:00:00.000Z&to=2026-10-23T00:00:00.000Z`,
    );
    assert.equal(response.status, 200);
    const suggest = app.calls.find((call) => call.method === 'suggestAppointmentSlots');
    assert.ok(suggest, 'the suggest operation runs');
    assert.ok(
      typeof suggest.input.nowIso === 'string' && !Number.isNaN(Date.parse(suggest.input.nowIso)),
      'the server passes a valid reference instant',
    );
  });
});

test('propose and confirm ride the caller actor from the request', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const headers = { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' };
    const propose = await fetch(`${base}/api/appointments/propose`, {
      method: 'POST', headers, body: JSON.stringify({ spaceId: 'locale' }),
    });
    assert.equal(propose.status, 200);
    assert.equal(app.calls.find((call) => call.method === 'proposeAppointmentBooking').actor.id, 'op-1');
    const confirm = await fetch(`${base}/api/appointments/confirm`, {
      method: 'POST', headers, body: JSON.stringify({ spaceId: 'locale', confirmed: true }),
    });
    assert.equal(confirm.status, 200);
    assert.match(confirm.headers.get('content-type') ?? '', /application\/json/);
  });
});

test('reschedule moves the named booking through the operation (backlog:3d0fbe7dc8d1)', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/appointments/reschedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' },
      body: JSON.stringify({
        id: 'b1',
        startsAt: '2026-10-22T16:30:00.000Z',
        endsAt: '2026-10-22T17:00:00.000Z',
      }),
    });
    assert.equal(response.status, 200);
    const call = app.calls.find((entry) => entry.method === 'rescheduleAppointmentBooking');
    assert.ok(call, 'the reschedule operation runs');
    assert.equal(call.actor.id, 'op-1');
    assert.equal(call.input.id, 'b1');
    assert.equal(call.input.startsAt, '2026-10-22T16:30:00.000Z');
    const body = await response.json();
    assert.equal(body.moved, true);
    assert.equal(body.appointment.id, 'b1');
  });
});

test('cancel cancels the named booking through the operation with the actor (backlog:5346ab531538)', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/appointments/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' },
      body: JSON.stringify({ id: 'b1', reason: 'Annullato dal calendario' }),
    });
    assert.equal(response.status, 200);
    const call = app.calls.find((entry) => entry.method === 'cancelAppointmentBooking');
    assert.ok(call, 'the cancel operation runs');
    assert.equal(call.actor.id, 'op-1');
    assert.deepEqual(call.input, { id: 'b1', reason: 'Annullato dal calendario' });
    const body = await response.json();
    assert.equal(body.cancelled, true);
    assert.equal(body.appointment.status, 'cancelled');
  });
});

test('phrase drafts through the operation', async () => {
  const app = stubApp();
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/appointments/phrase`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'op-1', 'x-actor-type': 'user' },
      body: JSON.stringify({ spaceId: 'locale', phrase: 'giovedì alle 18 con marco' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.draft.teamMemberId, 'marco');
  });
});

test('without the package composed every calendar route answers 404', async () => {
  const app = stubApp({
    readAppointmentTeamWeek: undefined,
    suggestAppointmentSlots: undefined,
    proposeAppointmentBooking: undefined,
    confirmAppointmentBooking: undefined,
    parseBookingPhrase: undefined,
    rescheduleAppointmentBooking: undefined,
    cancelAppointmentBooking: undefined,
  });
  await withServer(app, async (base) => {
    const headers = { 'content-type': 'application/json' };
    for (const [method, path, body] of [
      ['GET', '/api/appointments/team-week?teamMemberIds=marco&from=a&to=b', null],
      ['GET', '/api/appointments/suggest-slots?teamMemberIds=marco&from=a&to=b', null],
      ['POST', '/api/appointments/propose', {}],
      ['POST', '/api/appointments/confirm', {}],
      ['POST', '/api/appointments/phrase', {}],
      ['POST', '/api/appointments/reschedule', {}],
      ['POST', '/api/appointments/cancel', {}],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method, headers, body: body === null ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  });
});
