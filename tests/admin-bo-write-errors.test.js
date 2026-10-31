// @ts-check

/**
 * Backoffice write refusals (backlog:9046f940).
 *
 * What the supervisor saw in production on 2026-10-30 with real usage: in
 * Spazi e accessi, after «Conferma» on an AI switch, the write failed (405)
 * and the switch flipped back with no message; in the Calendario the error
 * stayed generic («Prenotazione non riuscita. Riprova più tardi.») even when
 * fields were missing. Every failed write must say what happened and what to
 * do, in Italian, next to the command — and empty required fields are named
 * before anything is sent.
 *
 * This file proves the contract without a browser: the shared write-error
 * helper maps 405 and 422 to Italian texts, the booking pre-check names the
 * missing fields, and both views render the refusal next to the command.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { humanWriteError } from '../apps/admin/public/admin-core.js';
import { missingBookingFields } from '../apps/admin/public/admin-calendario.js';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

function writeError(message, { code = 'BOOM', status = 500 } = {}) {
  return Object.assign(new Error(message), { code, status });
}

// The shared write helper: 405 and 422 get their own Italian text, the
// technical detail stays in the log and never reaches the DOM.
test('humanWriteError names a 405 refusal in Italian', () => {
  const text = humanWriteError(writeError('Method Not Allowed', { code: 'METHOD_NOT_ALLOWED', status: 405 }), {
    failed: 'La modifica non è riuscita. Riprova più tardi.',
  });
  assert.match(text, /non permette/, 'the 405 says the operation is not allowed');
  assert.match(text, /[Cc]hiedi|riprova/, 'the 405 says what to do');
  assert.ok(!/METHOD_NOT_ALLOWED|Method Not Allowed|405/.test(text), 'no technical detail leaks');
});

test('humanWriteError names a 422 refusal in Italian', () => {
  const text = humanWriteError(writeError('price is required', { code: 'VALIDATION_FAILED', status: 422 }), {
    failed: 'Prenotazione non riuscita. Riprova più tardi.',
  });
  assert.match(text, /non sono validi|dati/, 'the 422 names invalid data');
  assert.match(text, /[Cc]ontrolla|riprova/, 'the 422 says what to do');
  assert.ok(!/VALIDATION_FAILED|price is required/.test(text), 'no technical detail leaks');
});

test('humanWriteError falls back to the caller text otherwise', () => {
  const text = humanWriteError(writeError('backend down'), {
    failed: 'La modifica non è riuscita. Riprova più tardi.',
  });
  assert.equal(text, 'La modifica non è riuscita. Riprova più tardi.');
});

// The booking pre-check: empty required fields are named in Italian, and a
// full form reports nothing.
test('missingBookingFields names every empty field in Italian', () => {
  assert.deepEqual(
    missingBookingFields({ teamMemberId: '', serviceKey: '', date: '', start: '', end: '' }, false),
    ['cliente', 'persona del team', 'servizio', 'giorno', 'inizio', 'fine'],
  );
  assert.deepEqual(
    missingBookingFields(
      { teamMemberId: 'marco', serviceKey: 'taglio', date: '2026-10-22', start: '16:00', end: '16:30' },
      true,
    ),
    [],
  );
  assert.deepEqual(
    missingBookingFields(
      { teamMemberId: '  marco  ', serviceKey: 'taglio', date: '2026-10-22', start: '', end: '' },
      true,
    ),
    ['inizio', 'fine'],
    'whitespace-only fields count as missing',
  );
});

function calendarioClient({ failConfirmWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/appointments/confirm' && failConfirmWith) throw failConfirmWith;
      if (path === '/api/appointments/propose' || path === '/api/appointments/confirm') {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        return { decision: 'booked', appointment: { ...body, id: 'b1', status: 'confirmed' }, replayed: false, spaceId: 'locale' };
      }
      if (path.startsWith('/api/appointments/team-week')) return { members: [] };
      if (path.startsWith('/api/customer-data/customers')) return { items: [], page: 1, pageSize: 10, pages: 0 };
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path === '/api/spine/memberships') return { items: [] };
      throw Object.assign(new Error(`unexpected ${path}`), { code: 'NOT_FOUND', status: 404 });
    },
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// The manual form with empty fields sends nothing: the missing fields are
// named in Italian next to the form.
test('an empty booking names the missing fields before sending', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = calendarioClient();
  const view = createCalendarioView({
    doc, mount, client, storage: memoryStorage(), now: () => new Date('2026-10-25T10:00:00Z'),
  });
  await view.render();
  await flush();
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  assert.ok(confirm, 'the manual Conferma exists');
  confirm.dispatch('click');
  await flush();
  assert.ok(!client.calls.some((call) => call.path === '/api/appointments/confirm'), 'nothing is sent with empty fields');
  assert.ok(!client.calls.some((call) => call.path === '/api/appointments/propose'), 'not even the propose is sent');
  assert.match(mount.textContent, /Mancano dei dati/, 'the missing fields are named in Italian');
  assert.match(mount.textContent, /cliente/, 'the missing customer is named');
});

// A filled form that the server refuses with 422 shows the Italian
// invalid-data text next to the form — never the generic note alone.
test('a 422 booking shows the Italian invalid-data text', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = calendarioClient({
    failConfirmWith: writeError('priceCents must be positive', { code: 'VALIDATION_FAILED', status: 422 }),
  });
  const storage = memoryStorage();
  storage.setItem('accordo.bo.customer-pick.appointment', JSON.stringify({
    resource: 'contact', id: 'c1', name: 'Guido Presti',
  }));
  const view = createCalendarioView({
    doc, mount, client, storage, now: () => new Date('2026-10-25T10:00:00Z'),
  });
  await view.render();
  await flush();
  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  byName('teamMemberId').value = 'marco';
  byName('serviceKey').value = 'taglio';
  byName('date').value = '2026-10-22';
  byName('start').value = '16:00';
  byName('end').value = '16:30';
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  confirm.dispatch('click');
  await flush();
  assert.ok(client.calls.some((call) => call.path === '/api/appointments/confirm'), 'the filled form is sent');
  assert.match(mount.textContent, /non sono validi/, 'the 422 renders its Italian text next to the form');
  assert.ok(!/VALIDATION_FAILED|priceCents/.test(mount.textContent), 'no technical detail leaks into the page');
});
