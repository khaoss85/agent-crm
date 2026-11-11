// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelReasonFrom, cancelRefusalText, createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:5346ab531538 — «Annulla appuntamento» nel popover dell'evento.
 * La domanda «Annullare l'appuntamento?» compare dentro il popover (mai il
 * confirm() del browser), «No» prende il focus, «Sì, annulla» scrive con
 * POST /api/appointments/cancel e attende con il pulsante disattivato.
 * Riuscito: l'appuntamento sparisce dalla griglia, il popover si chiude, un
 * toast lo dice. Rifiutato: il motivo in italiano resta nel popover e
 * l'appuntamento resta dov'era. Un evento arrivato da Google Calendar dice
 * chiaramente il limite. Le righe già annullate non compaiono nella griglia.
 */

const WEEK = () => ({
  from: '2026-11-09T00:00:00.000Z',
  to: '2026-11-16T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [
      {
        id: 'p1',
        status: 'booked',
        startsAt: '2026-11-10T09:00:00.000Z',
        endsAt: '2026-11-10T09:45:00.000Z',
        serviceKey: 'lezione-prova',
        teamMemberId: 'marco',
        sourceKey: 'calendario:marco:p1:c1',
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada Rossi' },
      },
      {
        id: 'g1',
        status: 'booked',
        startsAt: '2026-11-11T09:00:00.000Z',
        endsAt: '2026-11-11T09:30:00.000Z',
        serviceKey: 'lezione-prova',
        teamMemberId: 'marco',
        sourceKey: 'gcal:primary:evt-1',
        subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null, label: 'Bea Neri' },
      },
      {
        id: 'x1',
        status: 'cancelled',
        startsAt: '2026-11-12T09:00:00.000Z',
        endsAt: '2026-11-12T09:30:00.000Z',
        serviceKey: 'lezione-prova',
        teamMemberId: 'marco',
        sourceKey: 'calendario:marco:x1:c3',
        subject: { resource: 'contact', id: 'c3', owner: 'host', ownerPackage: null, label: 'Cleo Verdi' },
      },
      {
        id: 'd1',
        status: 'done',
        startsAt: '2026-11-09T09:00:00.000Z',
        endsAt: '2026-11-09T09:30:00.000Z',
        serviceKey: 'lezione-prova',
        teamMemberId: 'marco',
        sourceKey: 'calendario:marco:d1:c4',
        subject: { resource: 'contact', id: 'c4', owner: 'host', ownerPackage: null, label: 'Dino Blu' },
      },
    ],
  }],
});

function notFound() {
  const error = new Error('not composed');
  /** @type {any} */ (error).code = 'NOT_FOUND';
  /** @type {any} */ (error).status = 404;
  return error;
}

function stubClient({ cancel = null } = {}) {
  const calls = [];
  let week = WEEK();
  /** @type {Array<() => void>} */
  const held = [];
  return {
    calls,
    held,
    get week() { return week; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method: options.method ?? 'GET', body });
      if (path === '/api/spine/memberships') throw notFound();
      if (path === '/api/profile') return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      if (path.startsWith('/api/customer-data/')) throw notFound();
      if (path.startsWith('/api/appointments/team-week')) return JSON.parse(JSON.stringify(week));
      if (path === '/api/appointments/cancel') {
        if (cancel === 'hold') await new Promise((resolve) => held.push(() => resolve(undefined)));
        if (cancel instanceof Error) throw cancel;
        week = JSON.parse(JSON.stringify(week));
        const row = week.members[0].appointments.find((entry) => entry.id === body.id);
        row.status = 'cancelled';
        return { appointment: { ...row, cancelReason: body.reason }, cancelled: true, push: null, pushError: null };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function focusingDocument() {
  const base = createFakeDocument();
  const doc = {
    ...base,
    activeElement: null,
    createElement(tag) {
      const node = base.createElement(tag);
      const focus = node.focus.bind(node);
      node.focus = () => {
        focus();
        doc.activeElement = node;
      };
      return node;
    },
  };
  return doc;
}

async function openWeek(options = {}) {
  const doc = focusingDocument();
  const mount = createMount();
  const client = stubClient(options);
  const toasts = [];
  const view = createCalendarioView({
    searchDelayMs: 0,
    doc,
    mount,
    client,
    toast: (message, error) => toasts.push({ message, error: error === true }),
    now: () => new Date('2026-11-09T07:00:00Z'),
  });
  await view.render();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'members').value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  return { doc, mount, client, toasts, view };
}

const eventButton = (mount, id) => mount.findAll('button').find((node) => node.getAttribute('data-event-id') === id) ?? null;
const popover = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail') ?? null;
const action = (root, name) => root.findAll('button').find((node) => node.getAttribute('data-action') === name) ?? null;
const confirmBox = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-role') === 'cancel-confirm') ?? null;

async function askCancel(mount, id) {
  eventButton(mount, id).dispatch('click');
  const ask = action(popover(mount), 'event-cancel');
  assert.ok(ask, 'the popover offers «Annulla appuntamento»');
  ask.dispatch('click');
  return confirmBox(mount);
}

test('annulla: a cancelled booking never paints on the grid, a done one does', async () => {
  const { mount } = await openWeek();
  assert.equal(eventButton(mount, 'x1'), null, 'the cancelled booking left the grid');
  assert.ok(eventButton(mount, 'd1'), 'a done booking still paints');
  assert.ok(eventButton(mount, 'p1'));
});

test('annulla: the question asks inside the popover, «No» takes the focus and folds it away', async () => {
  const { doc, mount, client } = await openWeek();
  const originalConfirm = globalThis.confirm;
  let browserConfirm = 0;
  globalThis.confirm = () => { browserConfirm += 1; return true; };
  try {
    const box = await askCancel(mount, 'p1');
    assert.ok(box, 'the question paints');
    assert.ok(popover(mount).contains(box), 'inside the popover');
    assert.equal(box.findAll('p')[0].textContent, 'Annullare l’appuntamento?');
    const no = action(box, 'cancel-no');
    const yes = action(box, 'cancel-yes');
    assert.equal(yes.textContent, 'Sì, annulla');
    assert.equal(no.textContent, 'No');
    assert.equal(doc.activeElement, no, '«No» takes the focus: Enter never cancels by accident');
    assert.equal(action(popover(mount), 'event-cancel').getAttribute('aria-expanded'), 'true');
    no.dispatch('click');
    assert.equal(confirmBox(mount), null, '«No» folds the question away');
    assert.ok(popover(mount), 'the popover stays open');
    assert.equal(doc.activeElement, action(popover(mount), 'event-cancel'), 'focus goes back to the cancel icon');
    assert.equal(client.calls.filter((call) => call.path === '/api/appointments/cancel').length, 0, 'nothing written');
    assert.equal(browserConfirm, 0, 'never the browser confirm()');
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test('annulla: «Sì, annulla» writes once, waits, then the booking leaves the grid and the popover closes', async () => {
  const { mount, client, toasts } = await openWeek({ cancel: 'hold' });
  const box = await askCancel(mount, 'p1');
  const reason = box.querySelector('input[name="cancel-reason"]');
  reason.value = '  Il cliente\nha disdetto  ';
  reason.dispatch('input');
  action(box, 'cancel-yes').dispatch('click');
  await settle(2);
  // While the write runs the buttons wait.
  const waiting = confirmBox(mount);
  const yes = action(waiting, 'cancel-yes');
  assert.equal(yes.textContent, 'Annullamento in corso…');
  assert.equal(yes.getAttribute('disabled'), 'true');
  assert.equal(yes.getAttribute('aria-busy'), 'true');
  assert.equal(action(waiting, 'cancel-no').getAttribute('disabled'), 'true');
  yes.dispatch('click');
  const writes = client.calls.filter((call) => call.path === '/api/appointments/cancel');
  assert.equal(writes.length, 1, 'one write, never a second while waiting');
  assert.deepEqual(writes[0].body, { id: 'p1', reason: 'Il cliente ha disdetto' }, 'the reason travels on one line');
  client.held.forEach((release) => release());
  await settle();
  assert.equal(popover(mount), null, 'the popover closes');
  assert.equal(eventButton(mount, 'p1'), null, 'the cancelled booking leaves the grid');
  assert.deepEqual(toasts, [{ message: 'Appuntamento annullato.', error: false }]);
  assert.ok(client.calls.filter((call) => call.path.startsWith('/api/appointments/team-week')).length >= 2, 'the week reloads');
});

test('annulla: without a typed reason the plain origin travels', async () => {
  const { mount, client } = await openWeek();
  const box = await askCancel(mount, 'p1');
  action(box, 'cancel-yes').dispatch('click');
  await settle();
  const write = client.calls.find((call) => call.path === '/api/appointments/cancel');
  assert.equal(write.body.reason, 'Annullato dal calendario');
});

test('annulla: a refusal stays in the popover in Italian and the booking stays', async () => {
  const refused = Object.assign(new Error('An appointment in state "done" cannot advance'), { code: 'APPOINTMENTS_INVALID_STATE', status: 409 });
  const { doc, mount, toasts } = await openWeek({ cancel: refused });
  const box = await askCancel(mount, 'p1');
  action(box, 'cancel-yes').dispatch('click');
  await settle();
  const after = confirmBox(mount);
  assert.ok(after, 'the question stays');
  const note = after.findAll('p').find((node) => node.getAttribute('data-role') === 'cancel-note');
  assert.equal(note?.textContent, 'Questo appuntamento è già chiuso (svolto o cliente non presentato): non si può più annullare.');
  assert.ok(!popover(mount).textContent.includes('cannot advance'), 'never the server text');
  assert.ok(eventButton(mount, 'p1'), 'the booking stays on the grid');
  assert.equal(doc.activeElement, action(after, 'cancel-yes'), 'focus on the retry');
  assert.deepEqual(toasts, []);
});

test('annulla: a network failure names the retry, never a stack', async () => {
  const failure = Object.assign(new TypeError('Failed to fetch'), {});
  const { mount } = await openWeek({ cancel: failure });
  const box = await askCancel(mount, 'p1');
  action(box, 'cancel-yes').dispatch('click');
  await settle();
  const note = confirmBox(mount).findAll('p').find((node) => node.getAttribute('data-role') === 'cancel-note');
  assert.ok(note && note.textContent.length > 0, 'a sentence names the failure');
  assert.ok(!/TypeError|fetch/i.test(note.textContent), note.textContent);
  assert.ok(eventButton(mount, 'p1'));
});

test('annulla: an event from Google Calendar names the limit before the cancel', async () => {
  const { mount } = await openWeek();
  const box = await askCancel(mount, 'g1');
  const hint = box.findAll('p').find((node) => node.getAttribute('data-role') === 'cancel-google');
  assert.ok(hint, 'the Google limit is stated');
  assert.match(hint.textContent, /Google Calendar/);
  const local = await askCancel(mount, 'p1');
  assert.ok(!local.findAll('p').some((node) => node.getAttribute('data-role') === 'cancel-google'), 'a booking made here carries no Google line');
});

test('annulla: a closed booking offers no cancel; Esc closes the question with the popover', async () => {
  const { mount } = await openWeek();
  eventButton(mount, 'd1').dispatch('click');
  assert.equal(action(popover(mount), 'event-cancel'), null, 'a done booking cannot be cancelled');
  const box = await askCancel(mount, 'p1');
  assert.ok(box);
  popover(mount).dispatch('keydown', { key: 'Escape' });
  assert.equal(popover(mount), null);
  eventButton(mount, 'p1').dispatch('click');
  assert.equal(confirmBox(mount), null, 'reopening starts without the question');
});

test('annulla: the move form and the question never show together', async () => {
  const { mount } = await openWeek();
  await askCancel(mount, 'p1');
  action(popover(mount), 'event-edit').dispatch('click');
  assert.equal(confirmBox(mount), null, 'the edit folds the question');
  assert.ok(mount.querySelector('div[data-role="move-form"]'));
  action(popover(mount), 'event-cancel').dispatch('click');
  assert.equal(mount.querySelector('div[data-role="move-form"]'), null, 'the question folds the move form');
  assert.ok(confirmBox(mount));
});

test('annulla: the pure helpers', () => {
  assert.equal(cancelReasonFrom(''), 'Annullato dal calendario');
  assert.equal(cancelReasonFrom('   '), 'Annullato dal calendario');
  assert.equal(cancelReasonFrom('a b\tc'), 'a b c');
  assert.equal(cancelReasonFrom('x'.repeat(400)).length, 300);
  assert.match(cancelRefusalText({ code: 'APPOINTMENTS_INVALID_STATE' }) ?? '', /già chiuso/);
  assert.equal(cancelRefusalText({ code: 'SOMETHING_ELSE', status: 500 }), null);
});
