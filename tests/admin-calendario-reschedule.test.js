// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarioView,
  calendarRefusalText,
  isMovableAppointment,
} from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:3d0fbe7dc8d1 — reproTest: nel calendario /bo un appuntamento si
 * sposta (trascina il corpo o modulo «Sposta») e si allunga dal bordo; parte
 * POST /api/appointments/reschedule e la griglia mostra il nuovo orario. Se
 * il server rifiuta, l'evento torna al suo posto con un messaggio italiano.
 * Il modulo è anche la via garantita a 390 px, dove il trascinamento è
 * scomodo. Il trascinamento via pointer non è simulato qui (il fake DOM non
 * ha closest/geometrie): condivide commitEventMove con il modulo, provato qui.
 */

const WEEK = () => ({
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [
    {
      teamMemberId: 'marco',
      appointments: [
        {
          id: 'a1',
          status: 'booked',
          startsAt: '2026-10-22T16:00:00.000Z',
          endsAt: '2026-10-22T16:30:00.000Z',
          serviceKey: 'taglio',
          teamMemberId: 'marco',
          priceCents: 4500,
          currency: 'EUR',
          notes: null,
          sourceKey: 'calendario:marco:1:c1',
          subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
        },
        {
          id: 'a2',
          status: 'cancelled',
          startsAt: '2026-10-23T09:00:00.000Z',
          endsAt: '2026-10-23T09:30:00.000Z',
          serviceKey: 'barba',
          teamMemberId: 'marco',
          priceCents: 2000,
          currency: 'EUR',
          notes: null,
          sourceKey: 'calendario:marco:2:c2',
          subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null, label: null },
        },
      ],
    },
  ],
});

function stubClient({ week, failRescheduleWith = null } = {}) {
  const calls = [];
  return {
    calls,
    week,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/spine/memberships') {
        // No roster: the typed member filter stays, like the older week tests.
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      if (path.startsWith('/api/customer-data/customers')) return { items: [] };
      if (path.startsWith('/api/customer-data/profile/')) {
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (path.startsWith('/api/appointments/team-week')) return week;
      if (path === '/api/appointments/reschedule') {
        if (failRescheduleWith) throw failRescheduleWith;
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        const member = week.members[0];
        const row = member.appointments.find((entry) => String(entry.id) === String(body.id ?? body.sourceKey ?? ''));
        assert.ok(row, 'the reschedule names a painted booking');
        row.startsAt = body.startsAt;
        row.endsAt = body.endsAt;
        return { appointment: { ...row }, moved: true, push: null, pushError: null };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openWeek() {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = WEEK();
  const client = stubClient({ week });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  assert.ok(filter, 'the member filter paints');
  filter.value = 'marco';
  const show = mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana'));
  assert.ok(show, 'the show-week button paints');
  show.dispatch('click');
  await settle();
  return { doc, mount, client, week };
}

function eventButton(mount, id) {
  const button = mount.findAll('button').find((node) => node.getAttribute('data-event-id') === id);
  assert.ok(button, `event ${id} paints`);
  return button;
}

async function selectEvent(mount, id) {
  eventButton(mount, id).dispatch('click', { target: eventButton(mount, id) });
  await settle();
}

function moveForm(mount) {
  const form = mount.querySelector('div[data-role="move-form"]');
  assert.ok(form, 'the Sposta form paints beside the selected event');
  return form;
}

function fillMove(form, { date, start, end }) {
  form.querySelector('input[name="move-date"]').value = date;
  form.querySelector('input[name="move-start"]').value = start;
  form.querySelector('input[name="move-end"]').value = end;
}

function submitMove(form) {
  const submit = form.findAll('button').find((node) => node.textContent.includes('Sposta'));
  assert.ok(submit, 'the Sposta submit paints');
  submit.dispatch('click');
}

test('3d0fbe7d: only held bookings move, refusals speak Italian', () => {
  assert.equal(isMovableAppointment({ status: 'booked' }), true);
  assert.equal(isMovableAppointment({ status: 'confirmed' }), true);
  assert.equal(isMovableAppointment({ status: 'cancelled' }), false);
  assert.equal(isMovableAppointment({ status: 'done' }), false);
  assert.equal(isMovableAppointment({ status: 'no-show' }), false);
  assert.match(calendarRefusalText({ code: 'APPOINTMENTS_OVERLAP' }) ?? '', /occupata/);
  assert.match(calendarRefusalText({ code: 'APPOINTMENTS_REMINDER_AFTER_SLOT' }) ?? '', /promemoria/);
  assert.match(calendarRefusalText({ code: 'APPOINTMENTS_INVALID_STATE' }) ?? '', /chiuso/);
});

test('3d0fbe7d: movable events paint the stretch handle, closed ones do not', async () => {
  const { mount } = await openWeek();
  const held = eventButton(mount, 'a1');
  assert.equal(held.getAttribute('data-movable'), '1');
  assert.ok(
    held.findAll('span').some((node) => (node.getAttribute('class') ?? '').includes('cal-resize')),
    'the held event has the bottom-edge stretch handle',
  );
  const closed = eventButton(mount, 'a2');
  assert.equal(closed.getAttribute('data-movable'), '0');
  assert.ok(
    !closed.findAll('span').some((node) => (node.getAttribute('class') ?? '').includes('cal-resize')),
    'a closed event has no stretch handle',
  );
});

test('3d0fbe7d: the Sposta form moves the booking through the reschedule route', async () => {
  const { mount, client, week } = await openWeek();
  await selectEvent(mount, 'a1');
  const form = moveForm(mount);
  // The phone path: named fields, no drag needed (backlog:3d0fbe7dc8d1 AC-3).
  assert.ok(form.querySelector('input[name="move-date"]'), 'day field paints');
  assert.ok(form.querySelector('input[name="move-start"]'), 'start field paints');
  assert.ok(form.querySelector('input[name="move-end"]'), 'end field paints');
  fillMove(form, { date: '2026-10-22', start: '18:30', end: '19:00' });
  submitMove(form);
  await settle(15);
  const reschedule = client.calls.find((call) => call.path === '/api/appointments/reschedule');
  assert.ok(reschedule, 'the move fires POST /api/appointments/reschedule');
  const body = typeof reschedule.body === 'string' ? JSON.parse(reschedule.body) : reschedule.body;
  assert.equal(body.id, 'a1');
  assert.ok(Date.parse(body.startsAt) < Date.parse(body.endsAt), 'the slot keeps its duration order');
  const row = week.members[0].appointments.find((entry) => entry.id === 'a1');
  assert.equal(row.startsAt, body.startsAt, 'the grid keeps the new start');
  assert.equal(row.endsAt, body.endsAt, 'the grid keeps the new end');
  assert.ok(
    mount.findAll('p').some((node) => node.textContent.includes('Spostato a')),
    'the grid confirms the new time beside the event',
  );
});

test('3d0fbe7d: a refused move stays put with an Italian note', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = WEEK();
  const before = { startsAt: week.members[0].appointments[0].startsAt, endsAt: week.members[0].appointments[0].endsAt };
  const refusal = new Error('overlap');
  refusal.code = 'APPOINTMENTS_OVERLAP';
  refusal.status = 409;
  const client = stubClient({ week, failRescheduleWith: refusal });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  await selectEvent(mount, 'a1');
  const form = moveForm(mount);
  fillMove(form, { date: '2026-10-22', start: '18:30', end: '19:00' });
  submitMove(form);
  await settle(15);
  const row = week.members[0].appointments.find((entry) => entry.id === 'a1');
  assert.equal(row.startsAt, before.startsAt, 'the event stays where it was');
  assert.equal(row.endsAt, before.endsAt, 'the end stays where it was');
  assert.ok(
    mount.findAll('p').some((node) => node.textContent.includes('occupata')),
    'the refusal reads Italian beside the event',
  );
});

test('3d0fbe7d: bad move fields fail closed in Italian before any request', async () => {
  const { mount, client } = await openWeek();
  await selectEvent(mount, 'a1');
  const form = moveForm(mount);
  fillMove(form, { date: 'non-una-data', start: '18:30', end: '19:00' });
  submitMove(form);
  await settle();
  assert.ok(
    !client.calls.some((call) => call.path === '/api/appointments/reschedule'),
    'no request leaves with bad fields',
  );
  assert.ok(
    mount.findAll('p').some((node) => node.textContent.includes('validi')),
    'bad fields get an Italian note',
  );
});
