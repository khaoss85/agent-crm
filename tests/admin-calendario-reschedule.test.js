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
          // A closed booking that still paints (backlog:5346ab531538: a
          // cancelled one leaves the grid, a done one stays).
          status: 'done',
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
  // Dan 11/11: the form opens from the popover's «Modifica o sposta» icon.
  if (!mount.querySelector('div[data-role="move-form"]')) {
    const edit = mount.querySelector('button[data-action="event-edit"]');
    assert.ok(edit, 'the popover carries «Modifica o sposta»');
    edit.dispatch('click');
  }
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

/**
 * closest() stand-in for pointer targets: the fake DOM has no
 * Element.closest, so the dragged nodes get one that walks parentNode like
 * the real one (class, [attr="value"], and comma lists — the only selectors
 * the calendar's pointer path uses).
 */
function attachClosest(node) {
  node.closest = (selector) => {
    const parts = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
    let current = node;
    while (current) {
      for (const part of parts) {
        if (part.startsWith('.')) {
          const wanted = part.slice(1);
          if ((current.getAttribute?.('class') ?? '').split(/\s+/).includes(wanted)) return current;
        } else {
          const attr = part.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/);
          if (attr && current.getAttribute?.(attr[1]) === attr[2]) return current;
        }
      }
      current = current.parentNode ?? null;
    }
    return null;
  };
  for (const child of node.childNodes ?? []) attachClosest(child);
}

const DRAG_WEEK = () => ({
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [
    {
      teamMemberId: 'marco',
      appointments: [
        {
          id: 'a9',
          status: 'booked',
          // 14:00–15:00 in Rome (CEST, UTC+2): mid-grid, room to move both ways.
          startsAt: '2026-10-22T12:00:00.000Z',
          endsAt: '2026-10-22T13:00:00.000Z',
          serviceKey: 'taglio',
          teamMemberId: 'marco',
          priceCents: 4500,
          currency: 'EUR',
          notes: null,
          sourceKey: 'calendario:marco:9:c9',
          subject: { resource: 'contact', id: 'c9', owner: 'host', ownerPackage: null, label: 'Bea' },
        },
      ],
    },
  ],
});

async function openPointerWeek({ failRescheduleWith = null, wait = undefined } = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = DRAG_WEEK();
  const client = stubClient({ week, failRescheduleWith });
  const toasts = [];
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z'),
    toast: (message, error) => toasts.push({ message, error: error === true }),
    ...(wait ? { wait } : {}),
  });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  const button = eventButton(mount, 'a9');
  const col = button.parentNode;
  attachClosest(mount);
  // 1 px per minute from 09:00: clientY 300 is 14:00, 330 is 14:30, 390 is 15:30.
  col.getBoundingClientRect = () => ({ top: 0, height: 540 });
  return { doc, mount, client, week, view, col, toasts };
}

function resizeHandleOf(mount) {
  const button = eventButton(mount, 'a9');
  const handle = button.findAll('span').find((node) => node.getAttribute('data-role') === 'event-resize');
  assert.ok(handle, 'the stretch handle paints on the event');
  return { button, handle };
}

test('3d0fbe7d: dragging the bottom edge stretches the booking (review #757 P2)', async () => {
  const { mount, client, week, col } = await openPointerWeek();
  const { handle } = resizeHandleOf(mount);
  const before = { ...week.members[0].appointments[0] };
  col.dispatch('pointerdown', { target: handle, button: 0, clientY: 330 });
  col.dispatch('pointermove', { clientY: 390 });
  col.dispatch('pointerup', {});
  await settle(15);
  const reschedule = client.calls.find((call) => call.path === '/api/appointments/reschedule');
  assert.ok(reschedule, 'the stretch fires POST /api/appointments/reschedule');
  const body = typeof reschedule.body === 'string' ? JSON.parse(reschedule.body) : reschedule.body;
  assert.equal(Date.parse(body.startsAt), Date.parse(before.startsAt), 'the start stays where it was');
  assert.ok(Date.parse(body.endsAt) > Date.parse(before.endsAt), 'the end moves later');
});

test('3d0fbe7d: grabbing mid-event keeps the grab offset, jitter sends nothing (review #757 P2)', async () => {
  const first = await openPointerWeek();
  const pressBody = eventButton(first.mount, 'a9');
  // A press at 14:30 on a 14:00–15:00 event, released in the same half hour:
  // ordinary click jitter must not move the booking anywhere.
  first.col.dispatch('pointerdown', { target: pressBody, button: 0, clientY: 330 });
  first.col.dispatch('pointermove', { clientY: 335 });
  first.col.dispatch('pointerup', {});
  await settle(15);
  assert.ok(
    !first.client.calls.some((call) => call.path === '/api/appointments/reschedule'),
    'jitter inside the same half hour sends no reschedule',
  );

  const second = await openPointerWeek();
  const body = eventButton(second.mount, 'a9');
  // A real displacement of one hour from a mid-event grab moves the block by
  // one hour, not by the pointer's absolute time.
  second.col.dispatch('pointerdown', { target: body, button: 0, clientY: 330 });
  second.col.dispatch('pointermove', { clientY: 390 });
  second.col.dispatch('pointerup', {});
  await settle(15);
  const reschedule = second.client.calls.find((call) => call.path === '/api/appointments/reschedule');
  assert.ok(reschedule, 'the move fires POST /api/appointments/reschedule');
  const payload = typeof reschedule.body === 'string' ? JSON.parse(reschedule.body) : reschedule.body;
  assert.equal(payload.startsAt, '2026-10-22T13:00:00.000Z', 'the block moves by the displacement (15:00 Rome)');
  assert.equal(payload.endsAt, '2026-10-22T14:00:00.000Z', 'the duration follows the block (16:00 Rome)');
});

test('3d0fbe7d: a route away during the request never repaints the next screen (review #757 P2)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = WEEK();
  let releaseReschedule;
  const pending = new Promise((resolve) => { releaseReschedule = resolve; });
  const base = stubClient({ week });
  const rescheduleBodies = [];
  const client = {
    ...base,
    async request(path, options = {}) {
      if (path === '/api/appointments/reschedule') {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        rescheduleBodies.push(body);
        return pending;
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'members').value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  await selectEvent(mount, 'a1');
  fillMove(moveForm(mount), { date: '2026-10-22', start: '18:30', end: '19:00' });
  submitMove(moveForm(mount));
  await settle(5);
  assert.equal(rescheduleBodies.length, 1, 'the move request leaves while mounted');
  const weekCallsBefore = base.calls.filter((call) => call.path.startsWith('/api/appointments/team-week')).length;
  view.invalidate();
  // The shell routes away: the shared mount now shows another screen.
  for (const child of [...mount.childNodes]) mount.removeChild(child);
  const other = doc.createElement('div');
  other.setAttribute('class', 'other-screen');
  other.textContent = 'Altra schermata';
  mount.appendChild(other);
  releaseReschedule({ appointment: { id: 'a1', startsAt: rescheduleBodies[0].startsAt, endsAt: rescheduleBodies[0].endsAt } });
  await settle(15);
  assert.equal(mount.querySelector('.cal-wrap'), null, 'the late answer never paints the calendar over the next screen');
  assert.equal(mount.querySelector('.other-screen')?.textContent, 'Altra schermata', 'the next screen stays');
  assert.equal(
    base.calls.filter((call) => call.path.startsWith('/api/appointments/team-week')).length,
    weekCallsBefore,
    'the late answer starts no week reload',
  );
  // The dropped completion still clears the busy state: back on the calendar,
  // another move leaves again. a1 is still the selection from before the
  // route away, and a click toggles — so one click deselects, then select.
  await view.render();
  await settle();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'members').value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  const reselect = eventButton(mount, 'a1');
  reselect.dispatch('click', { target: reselect });
  await settle();
  await selectEvent(mount, 'a1');
  fillMove(moveForm(mount), { date: '2026-10-22', start: '19:00', end: '19:30' });
  submitMove(moveForm(mount));
  await settle(15);
  assert.equal(rescheduleBodies.length, 2, 'the view takes another move after the dropped completion');
});

test('3d0fbe7d: a second move while a reschedule is in flight names the wait (review #757 P2)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = DRAG_WEEK();
  let releaseReschedule;
  const pending = new Promise((resolve) => { releaseReschedule = resolve; });
  const base = stubClient({ week });
  const rescheduleBodies = [];
  const client = {
    ...base,
    async request(path, options = {}) {
      if (path === '/api/appointments/reschedule') {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        rescheduleBodies.push(body);
        return pending;
      }
      return base.request(path, options);
    },
  };
  const toasts = [];
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, toast: (message, error) => toasts.push({ message, error: error === true }), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'members').value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  const popoverOpen = () => mount.findAll('div').some((node) => node.getAttribute('data-role') === 'event-detail');
  let button = eventButton(mount, 'a9');
  let col = button.parentNode;
  attachClosest(mount);
  col.getBoundingClientRect = () => ({ top: 0, height: 540 });
  // First move: press mid-event, drag one hour, release. The request stays
  // in flight, so the view is busy.
  col.dispatch('pointerdown', { target: button, button: 0, clientY: 330 });
  col.dispatch('pointermove', { clientY: 390 });
  col.dispatch('pointerup', {});
  await settle(10);
  assert.equal(rescheduleBodies.length, 1, 'the first move leaves while busy');
  // The optimistic repaint rebuilt the grid: re-query and re-attach.
  button = eventButton(mount, 'a9');
  col = button.parentNode;
  attachClosest(mount);
  col.getBoundingClientRect = () => ({ top: 0, height: 540 });
  // Second move while the first is in flight: never dropped silently, never
  // wedging the click guard — an Italian note names the wait.
  col.dispatch('pointerdown', { target: button, button: 0, clientY: 330 });
  col.dispatch('pointerup', {});
  await settle(5);
  assert.equal(rescheduleBodies.length, 1, 'no second request leaves while busy');
  // backlog:a332dcd070ca: a drag never opens the popover, so the wait reads
  // in a toast, in Italian.
  assert.equal(popoverOpen(), false, 'the drag opened no popover');
  assert.ok(toasts.some((toast) => toast.message.includes('già uno spostamento') && toast.error), JSON.stringify(toasts));
  // The first request lands: the grid confirms the new time, and the click
  // guard is eaten exactly once afterwards — never stuck.
  releaseReschedule({ appointment: { id: 'a9', startsAt: rescheduleBodies[0].startsAt, endsAt: rescheduleBodies[0].endsAt } });
  await settle(15);
  assert.equal(rescheduleBodies.length, 1, 'the landing sends nothing new');
  assert.ok(toasts.some((toast) => toast.message.startsWith('Spostato a') && !toast.error), 'the landing confirms the new time');
  assert.equal(popoverOpen(), false, 'the landing opens no popover either');
  const firstClick = eventButton(mount, 'a9');
  firstClick.dispatch('click', { target: firstClick });
  await settle(5);
  assert.equal(popoverOpen(), false, 'the drag click is eaten once');
  const secondClick = eventButton(mount, 'a9');
  secondClick.dispatch('click', { target: secondClick });
  await settle(5);
  assert.equal(popoverOpen(), true, 'the next click opens the popover: the guard is not wedged');
});

test('3d0fbe7d: a resize dragged sideways stays on the origin day (review #757 P2)', async () => {
  const { mount, client, week, col } = await openPointerWeek();
  const { handle } = resizeHandleOf(mount);
  const before = { ...week.members[0].appointments[0] };
  const cols = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('cal-day'));
  const neighbor = cols.find((node) => node !== col);
  assert.ok(neighbor, 'another day column paints beside the origin one');
  neighbor.getBoundingClientRect = () => ({ top: 0, height: 540 });
  const ghostsIn = (node) => (node.childNodes ?? []).filter((child) => (child.getAttribute?.('class') ?? '').includes('cal-drag-ghost'));
  col.dispatch('pointerdown', { target: handle, button: 0, clientY: 330 });
  col.dispatch('pointermove', { clientY: 390 });
  assert.equal(ghostsIn(col).length, 1, 'the stretch ghost paints on the origin column');
  // Sideways into the next day column: ignored, so preview and commit agree.
  neighbor.dispatch('pointermove', { clientY: 390 });
  assert.equal(ghostsIn(neighbor).length, 0, 'sideways motion paints no ghost on the other day');
  assert.equal(ghostsIn(col).length, 1, 'the ghost stays on the origin column');
  neighbor.dispatch('pointerup', {});
  await settle(15);
  const reschedule = client.calls.find((call) => call.path === '/api/appointments/reschedule');
  assert.ok(reschedule, 'the stretch still commits on release');
  const body = typeof reschedule.body === 'string' ? JSON.parse(reschedule.body) : reschedule.body;
  assert.equal(Date.parse(body.startsAt), Date.parse(before.startsAt), 'the start stays where it was');
  assert.ok(Date.parse(body.endsAt) > Date.parse(before.endsAt), 'the end moves later');
  assert.equal(String(body.endsAt).slice(0, 10), String(before.startsAt).slice(0, 10), 'the commit writes the new end on the origin day');
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

// backlog:a332dcd070ca (pilota 11/11): a refused drag must not open the
// popover by itself; the refusal reads in a toast and the block goes back.
test('a332dcd0: a refused drag opens no popover, the block goes back, the refusal reads in a toast', async () => {
  const refusal = Object.assign(new Error('overlap'), { code: 'APPOINTMENTS_OVERLAP', status: 409 });
  const { mount, client, week, col, toasts } = await openPointerWeek({ failRescheduleWith: refusal });
  const before = { ...week.members[0].appointments[0] };
  col.dispatch('pointerdown', { target: eventButton(mount, 'a9'), button: 0, clientY: 330 });
  col.dispatch('pointermove', { clientY: 390 });
  col.dispatch('pointerup', {});
  await settle(15);
  assert.ok(client.calls.some((call) => call.path === '/api/appointments/reschedule'), 'the move was asked');
  assert.equal(
    mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'event-detail').length,
    0,
    'the refused drag opens no popover',
  );
  assert.equal(eventButton(mount, 'a9').getAttribute('aria-pressed'), 'false', 'nothing selected');
  assert.equal(week.members[0].appointments[0].startsAt, before.startsAt, 'the block is back where it was');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].error, true);
  assert.match(toasts[0].message, /occupata/, 'the Italian refusal reads in the toast');
  // The click after the drop is eaten once, then a click opens the popover.
  eventButton(mount, 'a9').dispatch('click', { target: eventButton(mount, 'a9') });
  eventButton(mount, 'a9').dispatch('click', { target: eventButton(mount, 'a9') });
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'event-detail').length, 1);
});

test('a332dcd0: a successful drag opens no popover either and confirms in a toast', async () => {
  const { mount, col, toasts } = await openPointerWeek();
  col.dispatch('pointerdown', { target: eventButton(mount, 'a9'), button: 0, clientY: 330 });
  col.dispatch('pointermove', { clientY: 390 });
  col.dispatch('pointerup', {});
  await settle(15);
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'event-detail').length, 0);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].error, false);
  assert.match(toasts[0].message, /^Spostato a Giovedì 15:00–16:00\.$/);
});

test('a332dcd0: a move still queued on the shared /bo stays where it was dropped and the week is read again', async () => {
  const queued = Object.assign(new Error('pending'), { code: 'BO_CRM_PENDING', status: 504, requestId: 'req-1', claimId: 'c-1' });
  const waits = [];
  let release = () => {};
  const wait = (ms) => { waits.push(ms); return new Promise((resolve) => { release = resolve; }); };
  const { mount, client, week, col, toasts } = await openPointerWeek({ failRescheduleWith: queued, wait });
  col.dispatch('pointerdown', { target: eventButton(mount, 'a9'), button: 0, clientY: 330 });
  col.dispatch('pointermove', { clientY: 390 });
  col.dispatch('pointerup', {});
  await settle(15);
  assert.equal(week.members[0].appointments[0].startsAt, '2026-10-22T13:00:00.000Z', 'the drop stands, never reverted as refused');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].error, false);
  assert.match(toasts[0].message, /in coda/);
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'event-detail').length, 0);
  const reads = () => client.calls.filter((call) => call.path.startsWith('/api/appointments/team-week')).length;
  const before = reads();
  assert.deepEqual(waits, [4000], 'the week is read again after a short wait');
  release();
  await settle(10);
  assert.equal(reads(), before + 1, 'the week read shows where the worker put it');
});

test('a332dcd0: the Sposta form in the popover still answers inside the popover', async () => {
  const refusal = Object.assign(new Error('overlap'), { code: 'APPOINTMENTS_OVERLAP', status: 409 });
  const { mount, toasts } = await openPointerWeek({ failRescheduleWith: refusal });
  eventButton(mount, 'a9').dispatch('click', { target: eventButton(mount, 'a9') });
  const form = moveForm(mount);
  fillMove(form, { date: '2026-10-22', start: '16:00', end: '17:00' });
  submitMove(form);
  await settle(15);
  const note = mount.findAll('p').find((node) => node.getAttribute('data-role') === 'move-note');
  assert.match(note?.textContent ?? '', /occupata/, 'the refusal reads beside the form');
  assert.equal(toasts.length, 0, 'no toast while the popover shows it');
});

test('a332dcd0 (review #811): a queued reread waits for a move in flight, never clobbering it', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = DRAG_WEEK();
  const base = stubClient({ week });
  const bodies = [];
  let releaseSecond = () => {};
  const client = {
    ...base,
    async request(path, options = {}) {
      if (path === '/api/appointments/reschedule') {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        bodies.push(body);
        if (bodies.length === 1) {
          throw Object.assign(new Error('pending'), { code: 'BO_CRM_PENDING', status: 504, requestId: 'r1', claimId: 'c1' });
        }
        await new Promise((resolve) => { releaseSecond = resolve; });
        return { appointment: { id: 'a9', startsAt: body.startsAt, endsAt: body.endsAt } };
      }
      return base.request(path, options);
    },
  };
  let releaseWait = () => {};
  const toasts = [];
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z'),
    toast: (message, error) => toasts.push({ message, error: error === true }),
    wait: () => new Promise((resolve) => { releaseWait = resolve; }),
  });
  await view.render();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'members').value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  const drag = async (fromY, toY) => {
    const button = eventButton(mount, 'a9');
    const col = button.parentNode;
    attachClosest(mount);
    col.getBoundingClientRect = () => ({ top: 0, height: 540 });
    col.dispatch('pointerdown', { target: button, button: 0, clientY: fromY });
    col.dispatch('pointermove', { clientY: toY });
    col.dispatch('pointerup', {});
    await settle(10);
  };
  const weekReads = () => base.calls.filter((call) => call.path.startsWith('/api/appointments/team-week')).length;
  // Drag A: queued on the worker, its reread scheduled.
  await drag(330, 390);
  assert.equal(bodies.length, 1);
  assert.match(toasts.at(-1).message, /in coda/);
  // A click eats the drag guard, then drag B: it stays in flight.
  eventButton(mount, 'a9').dispatch('click', { target: eventButton(mount, 'a9') });
  await drag(390, 450);
  assert.equal(bodies.length, 2, 'the second move left');
  const readsBefore = weekReads();
  // The first move's reread time comes while B is in flight: it waits.
  releaseWait();
  await settle(10);
  assert.equal(weekReads(), readsBefore, 'no week read lands in the middle of the second move');
  // B lands: its own outcome speaks, then the week is read once.
  releaseSecond();
  await settle(15);
  assert.ok(toasts.some((toast) => toast.message.startsWith('Spostato a') && !toast.error), JSON.stringify(toasts));
  assert.equal(weekReads(), readsBefore + 1, 'one week read, after the second move');
});
