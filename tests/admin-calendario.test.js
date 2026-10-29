// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelOf,
  createCalendarioView,
  dayHead,
  displayKeys,
  gridRowsFor,
  lanesFor,
  memberColorIndex,
  memberInitials,
  parseMemberFilter,
  romeMinutes,
  romeWeekKeys,
  teamRows,
  teamRowsWithRoles,
  weekLabel,
  weekWindow,
} from '../apps/admin/public/admin-calendario.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The team calendar (BO-F3 "07 Calendario") renders the week from the
 * appointments operations, drafts a phrase into the manual form, proposes
 * free slots and books only on explicit confirmation — all against a stub
 * client here. The full HTTP path is covered by tests/admin-calendario-routes.
 */

const WEEK = {
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
          notes: '<img src=x onerror=alert(1)>',
          sourceKey: 'calendario:marco:2:c2',
          subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null, label: null },
        },
      ],
    },
  ],
};

/** Bodies travel through the submissions wrapper as JSON text: parse back. */
function payload(call) {
  if (typeof call.body === 'string') {
    try { return JSON.parse(call.body); } catch { return call.body; }
  }
  return call.body;
}

function stubClient({ week = WEEK, slots = [], phrase = null, profiles = null, failWith = null, failConfirmWith = null, memberships = undefined, membershipsError = null } = {}) {
  const calls = [];
  const notFound = () => {
    const error = new Error('not composed');
    error.code = 'NOT_FOUND';
    error.status = 404;
    return error;
  };
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (failWith) throw failWith;
      if (path.startsWith('/api/customer-data/profile/')) {
        if (profiles && Object.hasOwn(profiles, path)) return profiles[path];
        throw notFound();
      }
      if (path === '/api/appointments/confirm' && failConfirmWith) throw failConfirmWith;
      if (path === '/api/appointments/propose' || path === '/api/appointments/confirm') {
        const body = payload({ body: options.body });
        if (path === '/api/appointments/propose') {
          return { decision: 'confirm-required', draft: body, spaceId: 'locale', permission: 'book-appointments' };
        }
        return { decision: 'booked', appointment: { ...body, id: 'b1', status: 'confirmed' }, replayed: false, spaceId: 'locale' };
      }
      if (path === '/api/spine/memberships') {
        if (membershipsError) throw membershipsError;
        if (memberships !== undefined) return { items: memberships };
      }
      if (path.startsWith('/api/appointments/team-week')) return week;
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots }] };
      }
      if (path === '/api/appointments/phrase') return { draft: phrase, dryRun: false, spaceId: 'locale' };
      if (path === '/api/appointments/propose') {
        return { decision: 'confirm-required', draft: options.body, spaceId: 'locale', permission: 'book-appointments' };
      }
      if (path === '/api/appointments/confirm') {
        return { decision: 'booked', appointment: { ...options.body, id: 'b1', status: 'confirmed' }, replayed: false, spaceId: 'locale' };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

function texts(mount, tag) {
  return mount.findAll(tag).map((node) => node.textContent);
}

function clickButton(mount, label) {
  const button = mount.findAll('button').find((node) => node.textContent.includes(label));
  assert.ok(button, `button "${label}" exists`);
  button.dispatch('click');
  return button;
}

test('week keys are Monday..Sunday in Rome and the window covers the week', () => {
  // Sunday 2026-10-25 belongs to the Oct 19–25 week.
  const keys = romeWeekKeys(new Date('2026-10-25T10:00:00Z'));
  assert.deepEqual(keys, [
    '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22',
    '2026-10-23', '2026-10-24', '2026-10-25',
  ]);
  const window = weekWindow(keys);
  assert.ok(Date.parse(window.from) < Date.parse('2026-10-19T00:00:00+02:00'));
  assert.ok(Date.parse(window.to) > Date.parse('2026-10-25T23:59:00+01:00'));
  assert.match(weekLabel(keys) ?? '', /ott/);
});

test('member filter splits, trims and dedups — never a whole-team read', () => {
  assert.deepEqual(parseMemberFilter('marco, sara ,marco,'), ['marco', 'sara']);
  assert.deepEqual(parseMemberFilter(''), []);
  assert.deepEqual(parseMemberFilter(null), []);
});

test('week label names both years when the Rome week spans New Year', () => {
  // Thursday 2026-01-01 belongs to the Dec 29 – Jan 4 week: the trailing
  // year alone would pin the wrong year on the January days.
  const keys = romeWeekKeys(new Date('2026-01-01T10:00:00Z'));
  assert.deepEqual(keys[0], '2025-12-29');
  assert.deepEqual(keys[6], '2026-01-04');
  assert.equal(weekLabel(keys), '29 dic 2025 – 4 gen 2026');
});

test('week label keeps a single year inside one year', () => {
  assert.equal(
    weekLabel(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']),
    '19 ott – 25 ott 2026',
  );
});

test('calendario route resolves, deeper paths stay invalid', () => {
  assert.deepEqual(parseModuleRoute('#/calendario'), { view: 'calendario' });
  assert.deepEqual(parseModuleRoute('#/calendario/marco'), { view: 'invalid' });
});

// BO-F6-11 fetta 4 (specs/calendario.md C13): the work week is five columns.
test('week renders five day columns with real Rome-time events', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  // No members named yet: the honest prompt, not a blank screen.
  assert.ok(texts(mount, 'p').some((text) => text.includes('Scegli le persone')));
  // No appointment read without named members (fetta 7 refines this pin:
  // the Team roster read is not a week read and may go out on its own).
  assert.ok(client.calls.every((call) => !String(call.path).startsWith('/api/appointments/')));

  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const days = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'));
  assert.equal(days.length, 5);
  const heads = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day-head'));
  assert.equal(heads.length, 5);
  assert.ok(heads[0].textContent.includes('lun 19'), 'C13: the first head reads <ddd> <n>');
  assert.ok(heads[4].textContent.includes('ven 23'), 'C13: five work days, Mon..Fri');
  // Thursday 22 Oct 18:00 Rome (16:00Z in summer).
  assert.ok(texts(mount, 'span').some((text) => text === '18:00–18:30'));
  assert.ok(texts(mount, 'strong').includes('taglio'));
  // Cancelled rows stay listed with their status.
  assert.ok(texts(mount, 'span').includes('cancelled'));
  // No customer control paints before a selection: the card owns it (fetta 5).
  assert.equal(mount.findAll('a').length, 0);
  // Selecting the block opens the card, and the card buttons at the scheda.
  const block = mount.findAll('button').find((node) => node.textContent.includes('taglio'));
  assert.ok(block, 'the taglio block is a button');
  block.dispatch('click');
  const open = mount.findAll('button').find((node) => node.textContent === 'Apri scheda cliente');
  assert.ok(open, 'the card buttons at the scheda, never a raw id');
});

test('the week pager reloads the named members instead of blanking the week', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  await flush();
  const weeks = () => client.calls.filter((call) => call.path.startsWith('/api/appointments/team-week'));
  assert.equal(weeks().length, 1);
  mount.findAll('button').find((node) => node.textContent === '›').dispatch('click');
  await flush();
  // The pager moves the window AND reloads it for the still-named members:
  // the operator never falls back to the "name someone" prompt mid-browse.
  assert.equal(weeks().length, 2);
  assert.ok(weeks()[1].path.includes('teamMemberIds=marco'));
  assert.ok(weeks()[1].path.includes('from=2026-10-25T00'), `second window starts after the first week: ${weeks()[1].path}`);
  // The stub week holds no events in the new window, so the reloaded panel
  // honestly shows five empty work days — never the "name someone" prompt.
  const days = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'));
  assert.equal(days.length, 5);
  assert.ok(texts(mount, 'p').some((text) => text.includes('26 ott')), 'the nav labels the moved week');
  assert.ok(!texts(mount, 'p').some((text) => text.includes('Scegli le persone')));
});

test('hostile notes and subjects are inert text, never markup', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const strongs = mount.findAll('strong').map((node) => node.textContent);
  assert.ok(strongs.some((text) => text.includes('<img src=x')));
  assert.equal(mount.findAll('img').length, 0);
});

test('uncomposed package renders an honest placeholder, never a blank screen', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const failure = Object.assign(new Error('Not found'), { code: 'NOT_FOUND', status: 404 });
  const view = createCalendarioView({ doc, mount, client: stubClient({ failWith: failure }), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(texts(mount, 'p').some((text) => text.includes('non è composto')));
});

// BO-F6-11 fetta 3 (specs/calendario.md C4): the AI card carries a
// textarea and «Trova slot liberi».
test('the AI card shows a textarea and Trova slot liberi', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const field = mount.querySelector('textarea[name="phrase"]');
  assert.ok(field, 'C4: the phrase is a textarea');
  assert.equal(field.getAttribute('rows'), '3', 'C4: three rows');
  const find = mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi');
  assert.ok(find, 'C4: the search button');
});

test('Trova slot liberi interprets the phrase, then lists proposals with Conferma and ghosts', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
    notes: 'taglio per Ada',
  };
  const slots = [{ startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' }];
  const client = stubClient({ phrase: draft, slots });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  // The ghosts need the loaded week: name the member first.
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  byName().members.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  const flush = async (n = 7) => {
    for (let round = 0; round < n; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await flush();
  const field = mount.querySelector('textarea[name="phrase"]');
  field.value = 'trova 45 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flush();
  const interpreted = client.calls.find((call) => call.path === '/api/appointments/phrase');
  assert.equal(payload(interpreted).phrase, 'trova 45 minuti con marco');
  const suggest = client.calls.find((call) => call.path.startsWith('/api/appointments/suggest-slots'));
  assert.ok(suggest, 'the phrase feeds a slot search');
  assert.ok(suggest.path.includes('teamMemberIds=marco'), 'the drafted person is searched');
  assert.ok(suggest.path.includes('slotMinutes=30'), 'the drafted duration is searched');
  assert.ok(suggest.path.includes('from=2026-10-18T22'), 'the search covers the shown week');
  // C5: one row per slot, `<ddd> <n> · <hh:mm>–<hh:mm>` with Conferma.
  const list = mount.querySelector('.cal-slots');
  assert.ok(list, 'the proposal rows render');
  assert.ok(list.textContent.includes('22 ott · 18:00–18:30'), 'C5: the row names the Rome slot');
  const confirms = list.findAll('button').filter((node) => node.textContent === 'Conferma');
  assert.equal(confirms.length, 1, 'C5: one Conferma per row');
  // C5: one dashed ghost per slot on its Rome day, clickable to confirm.
  const grid = mount.querySelector('.cal-grid');
  assert.ok(grid && grid.textContent.includes('✦ Proposta 18:00'), 'C5: the ghost names the Rome time');
  const ghost = mount.findAll('button').find((node) => node.textContent === '✦ Proposta 18:00');
  assert.ok((ghost.getAttribute('class') ?? '').split(/\s+/).includes('bo-add-button'), 'the ghost reuses the shared dashed control');
  // The draft still prefills the manual form (Rome wall time back into the inputs).
  const form = byName();
  assert.equal(form.teamMemberId.value, 'marco');
  assert.equal(form.serviceKey.value, 'taglio');
  assert.equal(form.date.value, '2026-10-22');
  assert.equal(form.start.value, '18:00');
  assert.equal(form.end.value, '18:30');
});

test('a proposal Conferma books through confirm with the manual claim', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
  };
  const slots = [{ startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' }];
  const client = stubClient({ phrase: draft, slots });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  const flush = async (n = 7) => {
    for (let round = 0; round < n; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await flush();
  // The operator names the customer once; the slot brings person and time.
  const form = byName();
  form.customerId.value = 'c1';
  form.serviceKey.value = 'taglio';
  form.price.value = '45.00';
  const confirm = mount.querySelector('.cal-slots').findAll('button')
    .find((node) => node.textContent === 'Conferma');
  confirm.dispatch('click');
  await flush();
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1, 'Conferma calls confirmBooking');
  const body = payload(confirms[0]);
  assert.equal(body.confirmed, true);
  assert.equal(body.teamMemberId, 'marco');
  assert.equal(body.startsAt, '2026-10-22T16:00:00.000Z');
  assert.equal(body.endsAt, '2026-10-22T16:30:00.000Z');
  assert.equal(body.priceCents, 4500);
  assert.equal(body.sourceKey, 'calendario:marco:2026-10-22T16:00:00.000Z:c1');
  assert.ok(texts(mount, 'p').some((text) => text.includes('Prenotato: marco')));
  assert.ok(!texts(mount, 'button').some((text) => text.includes('✦ Proposta')), 'booking clears the proposals');
});

test('zero slots say so in plain words', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
  };
  const client = stubClient({ phrase: draft, slots: [] });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(
    texts(mount, 'p').includes('Nessuno slot libero questa settimana, prova con altri giorni.'),
    'the spec sentence, no code',
  );
  assert.equal(mount.querySelector('.cal-slots'), null, 'no proposal rows, only the manual Conferma');
});

test('a failed search says so in plain words, never a code', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient({ failWith: new Error('backend down') }), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const notes = texts(mount, 'p');
  assert.ok(notes.includes('Ricerca non riuscita. Riprova più tardi.'));
  assert.ok(!notes.some((text) => text.includes('backend down')), 'no raw error leaks to the operator');
});

test('a failed Conferma names the manual form, never a code', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
  };
  const slots = [{ startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' }];
  const client = stubClient({ phrase: draft, slots, failConfirmWith: new Error('serviceKey must be the listino product key') });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // No customer, service or price: the confirm fails closed on the server.
  const confirm = mount.querySelector('.cal-slots').findAll('button')
    .find((node) => node.textContent === 'Conferma');
  confirm.dispatch('click');
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const notes = texts(mount, 'p');
  assert.ok(notes.includes('Conferma non riuscita: controlla cliente, servizio e prezzo nel modulo qui sotto.'));
  assert.ok(!notes.some((text) => text.includes('serviceKey')), 'no validation jargon leaks to the operator');
});

test('the search button stays disabled while searching', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
  };
  const client = stubClient({ phrase: draft, slots: [] });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  const searching = mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi');
  assert.equal(searching.getAttribute('disabled'), 'true', 'the button is disabled in flight');
  assert.ok(texts(mount, 'p').some((text) => text.includes('Cerco gli slot liberi')), 'a short wait, no jargon');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const done = mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi');
  assert.notEqual(done.getAttribute('disabled'), 'true', 'the button is usable again');
});

test('a phrase without a person says who is missing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ phrase: { serviceKey: 'taglio' } });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(client.calls.every((call) => !call.path.startsWith('/api/appointments/suggest-slots')), 'no search for nobody');
  assert.ok(texts(mount, 'p').some((text) => text.includes('Dalla frase non capisco la persona')));
});

test('propose plans, confirm books: nothing is written before Conferma', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
  form.customerId.value = 'c1';
  form.teamMemberId.value = 'marco';
  form.serviceKey.value = 'taglio';
  form.price.value = '45.00';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  clickButton(mount, 'Proponi');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const proposes = client.calls.filter((call) => call.path === '/api/appointments/propose');
  assert.equal(proposes.length, 1);
  assert.equal(payload(proposes[0]).teamMemberId, 'marco');
  assert.equal(payload(proposes[0]).priceCents, 4500);
  assert.equal(payload(proposes[0]).startsAt, '2026-10-22T16:00:00.000Z');
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 0);
  assert.ok(texts(mount, 'p').some((text) => text.includes('Conferma')));
  clickButton(mount, 'Conferma');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1);
  assert.equal(payload(confirms[0]).confirmed, true);
  assert.ok(texts(mount, 'p').some((text) => text.includes('Prenotato: marco')));
});

test('late-evening wall times book the same Rome day, never tomorrow', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
  form.customerId.value = 'c1';
  form.teamMemberId.value = 'marco';
  form.serviceKey.value = 'taglio';
  form.date.value = '2026-10-22';
  form.start.value = '23:00';
  form.end.value = '23:30';
  clickButton(mount, 'Proponi');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const proposes = client.calls.filter((call) => call.path === '/api/appointments/propose');
  assert.equal(proposes.length, 1);
  // 23:00 Rome on Oct 22 (summer, +2) is 21:00Z the same day — not Oct 23.
  assert.equal(payload(proposes[0]).startsAt, '2026-10-22T21:00:00.000Z');
  assert.equal(payload(proposes[0]).endsAt, '2026-10-22T21:30:00.000Z');
});

test('unsubmitted manual edits survive a week reload', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  byName().members.value = 'marco';
  const form = byName();
  form.customerId.value = 'c1';
  form.teamMemberId.value = 'marco';
  form.serviceKey.value = 'taglio';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  clickButton(mount, 'Proponi');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const proposes = client.calls.filter((call) => call.path === '/api/appointments/propose');
  assert.equal(proposes.length, 1);
  assert.equal(payload(proposes[0]).subject.id, 'c1');
  // The operator retypes the customer before reloading the week.
  const edited = byName();
  edited.customerId.value = 'c2';
  edited.customerId.dispatch('input');
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(byName().customerId.value, 'c2');
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/propose').length, 1);
});

test('conferma books directly: no propose call on the confirm path', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
  form.customerId.value = 'c1';
  form.teamMemberId.value = 'marco';
  form.serviceKey.value = 'taglio';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  clickButton(mount, 'Conferma');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // An explicit confirmation reaches the idempotent confirm operation
  // directly, so a retry after a committed-but-lost confirm replays instead
  // of dying on propose against the confirmed row.
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/propose').length, 0);
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1);
  assert.equal(payload(confirms[0]).startsAt, '2026-10-22T16:00:00.000Z');
  assert.ok(texts(mount, 'p').some((text) => text.includes('Prenotato: marco')));
});

// BO-F6-11 fetta 2 (specs/calendario.md C1): fixed page chrome.
test('the header carries the prototype eyebrow and title', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const eyebrow = mount.findAll('p').find((node) => node.getAttribute('class') === 'eyebrow');
  assert.equal(eyebrow?.textContent, 'Calendario condiviso', 'C1: eyebrow');
  assert.equal(mount.findAll('h2')[0]?.textContent, 'Agenda del team', 'C1: title');
});

// BO-F6-11 fetta 2 (C2): ‹, interval, ›, Oggi, Nuovo appuntamento — in order.
test('the week bar shows pager, interval, today and booking menu in order', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const nav = mount.querySelector('.actions');
  assert.ok(nav, 'the header has an actions bar');
  const text = nav.textContent;
  const order = ['‹', '19 ott – 23 ott 2026', '›', 'Oggi', 'Nuovo appuntamento'];
  let from = -1;
  for (const part of order) {
    const at = text.indexOf(part, from + 1);
    assert.ok(at > from, `C2: "${part}" comes after the previous control`);
    from = at;
  }
  // The interval is its own element with the spec pattern, not a button label.
  const interval = nav.querySelector('span[data-role="week-interval"]');
  assert.equal(interval?.textContent, '19 ott – 23 ott 2026', 'C2: interval pattern');
});

// BO-F6-11 fetta 2 (C3): the booking menu opens with both voices.
test('Nuovo appuntamento opens the two voices with their subtitles', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const toggle = mount.findAll('button').find((node) => node.textContent.includes('Nuovo appuntamento'));
  assert.ok(toggle, 'the booking menu toggle exists');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the menu starts closed');
  toggle.dispatch('click');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the toggle opens the menu');
  const menu = mount.querySelector('.bo-clienti-menu');
  assert.ok(menu && !menu.classList.contains('hidden'), 'the menu is visible');
  assert.ok(menu.textContent.includes("Crea con l'AI"), 'voice 1 title');
  assert.ok(menu.textContent.includes("Trovo gli slot liberi e invio l'invito"), 'voice 1 subtitle');
  assert.ok(menu.textContent.includes('Compila manualmente'), 'voice 2 title');
  assert.ok(menu.textContent.includes('Giorno, ora, cliente e partecipanti'), 'voice 2 subtitle');
  toggle.dispatch('click');
  assert.ok(menu.classList.contains('hidden'), 'the toggle closes the menu');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

// BO-F6-11 fetta 2 (C3): Escape closes the menu and returns focus.
test('Escape closes the booking menu and returns focus to the toggle', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const toggle = mount.findAll('button').find((node) => node.textContent.includes('Nuovo appuntamento'));
  toggle.dispatch('click');
  const wrap = mount.querySelector('.bo-clienti-menuwrap');
  const menu = mount.querySelector('.bo-clienti-menu');
  assert.ok(!menu.classList.contains('hidden'), 'the menu is open');
  let focused = null;
  toggle.focus = () => { focused = 'toggle'; };
  wrap.dispatch('keydown', { key: 'Escape' });
  assert.ok(menu.classList.contains('hidden'), 'Escape closes the menu');
  assert.equal(focused, 'toggle', 'focus returns to the toggle');
});

// BO-F6-11 fetta 2 (C3): each voice closes the menu and focuses its target.
test('the voices focus the phrase field and the manual form', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const toggle = mount.findAll('button').find((node) => node.textContent.includes('Nuovo appuntamento'));
  toggle.dispatch('click');
  const menu = mount.querySelector('.bo-clienti-menu');
  const items = menu.findAll('button');
  const ai = items.find((node) => node.textContent.includes("Crea con l'AI"));
  const phrase = mount.querySelector('textarea[name="phrase"]');
  let focused = null;
  phrase.focus = () => { focused = 'phrase'; };
  ai.dispatch('click');
  assert.equal(focused, 'phrase', 'the AI voice focuses the phrase field');
  assert.ok(menu.classList.contains('hidden'), 'the menu closes after the choice');
  toggle.dispatch('click');
  const manual = menu.findAll('button').find((node) => node.textContent.includes('Compila manualmente'));
  const first = mount.querySelector('input[name="customerResource"]');
  first.focus = () => { focused = 'manual'; };
  manual.dispatch('click');
  assert.equal(focused, 'manual', 'the manual voice focuses the booking form');
  assert.ok(menu.classList.contains('hidden'), 'the menu closes after the choice');
});

// BO-F6-11 fetta 2 (C3): a click outside the open menu closes it.
test('a click outside the booking menu closes it', async () => {
  const base = createFakeDocument();
  const handlers = Object.create(null);
  const doc = {
    createElement: (...args) => base.createElement(...args),
    createElementNS: (...args) => base.createElementNS(...args),
    addEventListener: (type, handler) => { (handlers[type] ??= []).push(handler); },
    fire: (type, event) => { for (const handler of handlers[type] ?? []) handler(event); },
  };
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const toggle = mount.findAll('button').find((node) => node.textContent.includes('Nuovo appuntamento'));
  const wrap = mount.querySelector('.bo-clienti-menuwrap');
  const menu = mount.querySelector('.bo-clienti-menu');
  toggle.dispatch('click');
  assert.ok(!menu.classList.contains('hidden'), 'the menu is open');
  doc.fire('click', { target: toggle });
  assert.ok(!menu.classList.contains('hidden'), 'a click inside the menu keeps it open');
  doc.fire('click', { target: mount });
  assert.ok(menu.classList.contains('hidden'), 'a click outside closes the menu');
  assert.ok(wrap, 'the wrap is the outside-click boundary');
});

test('the calendario view renders no raw control', async () => {
  // BO-F6-11 acceptance: nessun button/select/input senza le classi del
  // sistema visivo nella schermata. Every control reaches the DOM through
  // the shared `el` library (or the uiButton builder), which normalizes
  // legacy classes onto `ui-*`.
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  // Blocks paint too, so the week loads before the walk.
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const raw = [];
  const walk = (node) => {
    const tag = String(node.tagName ?? '').toLowerCase();
    if (['button', 'select', 'input', 'textarea'].includes(tag)) {
      const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) {
        raw.push(`${tag}[${classes.join('.')}]`);
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(mount);
  assert.deepEqual(raw, [], 'every calendario control carries a ui-* system class');
});

// BO-F6-11 fetta 4 (specs/calendario.md C13): the painted columns are the
// Mon..Fri work week against an 09:00–18:00 hour axis.
test('the time grid shows five work days against the 09:00–18:00 axis', async () => {
  assert.deepEqual(
    displayKeys(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']),
    ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'],
  );
  assert.equal(dayHead('2026-10-19'), 'lun 19');
  assert.equal(dayHead('2026-10-23'), 'ven 23');
  assert.equal(dayHead('nope'), null);

  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const hours = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-hour'));
  assert.equal(hours.length, 10, 'C13: ten hour labels');
  assert.equal(hours[0].textContent, '09:00');
  assert.equal(hours[9].textContent, '18:00');
  // Blocks sit on their Rome half-hour rows: taglio Thu 18:00–18:30 Rome
  // clamps to the last row; barba Fri 11:00–11:30 Rome sits on row 5.
  const blocks = mount.findAll('button').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('cal-event'));
  assert.equal(blocks.length, 2, 'two held events paint two blocks');
  const taglio = blocks.find((node) => node.textContent.includes('taglio'));
  assert.ok(taglio.getAttribute('style').includes('grid-row: 18 / span 1'), `taglio clamps to the last row: ${taglio.getAttribute('style')}`);
  // The barba row carries hostile notes, which become its title (inert text):
  // find it by its Rome time, Fri 11:00–11:30.
  const barba = blocks.find((node) => node.textContent.includes('11:00–11:30'));
  assert.ok(barba, 'the barba block paints with its Rome time');
  assert.ok(barba.getAttribute('style').includes('grid-row: 5 / span 1'), `barba sits on its row: ${barba.getAttribute('style')}`);
  // Colour and initials come from the opaque member id, never a name.
  assert.match(taglio.getAttribute('class'), /cal-m[0-4]/, 'the block carries its member tint');
  assert.ok(taglio.textContent.includes('MA'), 'the block carries member initials');
  assert.ok(!taglio.textContent.includes('marco'), 'the member id is not printed in full');
});

// Grid placement clamps out-of-hours bookings at the painted edge.
test('gridRowsFor clamps outside hours and never drops a booking', () => {
  assert.deepEqual(gridRowsFor('2026-10-22T16:00:00.000Z', '2026-10-22T16:30:00.000Z'), { row: 18, span: 1 });
  assert.deepEqual(gridRowsFor('2026-10-23T07:00:00.000Z', '2026-10-23T07:30:00.000Z'), { row: 1, span: 1 });
  // 08:00Z–09:00Z is 10:00–11:00 Rome in October: a two-row span mid-grid.
  assert.deepEqual(gridRowsFor('2026-10-23T08:00:00.000Z', '2026-10-23T09:00:00.000Z'), { row: 3, span: 2 });
  // 06:00Z–07:00Z is 08:00–09:00 Rome: clamps to the first row, never dropped.
  assert.deepEqual(gridRowsFor('2026-10-23T06:00:00.000Z', '2026-10-23T07:00:00.000Z'), { row: 1, span: 1 });
  assert.deepEqual(gridRowsFor('2026-10-23T06:00:00.000Z', '2026-10-23T06:30:00.000Z'), { row: 1, span: 1 });
  assert.deepEqual(gridRowsFor('nope', 'nope'), { row: 1, span: 1 });
  assert.equal(romeMinutes('2026-10-22T16:00:00.000Z'), 18 * 60);
  assert.equal(romeMinutes('nope'), null);
});

// Overlaps split the day width instead of painting over each other.
test('lanesFor splits overlapping events into side-by-side lanes', () => {
  const a = { id: 'a', startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T15:00:00.000Z' };
  const b = { id: 'b', startsAt: '2026-10-22T14:30:00.000Z', endsAt: '2026-10-22T15:30:00.000Z' };
  const c = { id: 'c', startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' };
  const lanes = lanesFor([a, b, c]);
  assert.equal(lanes.get(a).lane, 0);
  assert.equal(lanes.get(b).lane, 1);
  assert.equal(lanes.get(c).lane, 0, 'a later event reuses the freed lane');
  assert.equal(lanes.get(a).lanes, 2);
});

// BO-F6-11 fetta 4 (C6, C9): a block click opens the detail card; × closes it.
test('selecting a block opens the detail card and × deselects it', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  // Wednesday 21 Oct 2026 08:40Z is 10:40 in Rome: the now-line paints.
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-21T08:40:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const findCards = () => mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'event-detail');
  assert.equal(findCards().length, 0, 'no card before a selection');
  const findBlock = () => mount.findAll('button').find((node) => node.textContent.includes('taglio'));
  const block = findBlock();
  assert.ok(block, 'the taglio block is a button');
  block.dispatch('click');
  // A click rebuilds the DOM: re-query the painted block, never the detached one.
  const selected = findBlock();
  const card = findCards()[0];
  assert.ok(card, 'C6: the click opens the detail card');
  assert.ok(card.textContent.includes('taglio'), 'C6: the card carries the title');
  assert.ok(card.textContent.includes('Giovedì 22 ott · 18:00–18:30'), 'C6: the card carries the day · time row');
  assert.ok(card.textContent.includes('marco, Ada'), 'C6: the card names the participants');
  assert.ok(selected.getAttribute('class').includes('cal-selected'), 'C9: the selected block reads selected');
  assert.equal(selected.getAttribute('aria-pressed'), 'true');
  const close = card.findAll('button').find((node) => node.textContent === '×');
  assert.ok(close, 'C9: the card carries a close ×');
  close.dispatch('click');
  assert.equal(findCards().length, 0, 'C9: × hides the card');
  // A second click on the block toggles the selection off as well.
  const reopen = mount.findAll('button').find((node) => node.textContent.includes('taglio'));
  reopen.dispatch('click');
  assert.equal(findCards().length, 1);
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  assert.equal(findCards().length, 0, 'clicking the selected block deselects it');
});

// BO-F6-11 fetta 4 (C15): the red now-line crosses the current day only.
test('the now-line paints on the current day inside painted hours', async () => {
  const load = async (now) => {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCalendarioView({ doc, mount, client: stubClient(), now });
    await view.render();
    const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
    filter.value = 'marco';
    clickButton(mount, 'Mostra settimana');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return mount;
  };
  // Wednesday 21 Oct 08:40Z is 10:40 Rome: (100/540) = 18.52% down the day.
  const midweek = await load(() => new Date('2026-10-21T08:40:00Z'));
  const lines = midweek.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-now'));
  assert.equal(lines.length, 1, 'C15: one now-line on the current day');
  assert.ok(lines[0].getAttribute('style').includes('top: 18.52%'), `the line sits at the Rome time: ${lines[0].getAttribute('style')}`);
  const sunday = await load(() => new Date('2026-10-25T10:00:00Z'));
  assert.equal(
    sunday.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-now')).length,
    0,
    'no now-line when today is outside the work week',
  );
  const night = await load(() => new Date('2026-10-21T03:00:00Z'));
  assert.equal(
    night.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-now')).length,
    0,
    'no now-line outside the painted hours',
  );
});

// BO-F6-11 fetta 4 (C14): the WA badge paints only from an explicit channel
// marker — live team-week rows carry none, so they never guess.
test('the WA badge is fail-closed on the row channel marker', async () => {
  assert.equal(channelOf({ channel: 'whatsapp' }), 'whatsapp');
  assert.equal(channelOf({}), null, 'no marker, no badge');
  assert.equal(channelOf({ channel: '<img src=x>' }), null, 'a hostile channel value never paints');
  assert.equal(channelOf(null), null);

  const week = {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-26T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'w1',
        status: 'booked',
        startsAt: '2026-10-22T16:00:00.000Z',
        endsAt: '2026-10-22T16:30:00.000Z',
        serviceKey: 'taglio',
        teamMemberId: 'marco',
        channel: 'whatsapp',
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
      }],
    }],
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const calls = [];
  const view = createCalendarioView({
    doc,
    mount,
    client: { calls, async request(path) { calls.push(path); return week; } },
    now: () => new Date('2026-10-25T10:00:00Z'),
  });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const marked = mount.findAll('span').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-wa'));
  assert.equal(marked.length, 1, 'C14: the marked block carries the WA badge');
  assert.equal(marked[0].textContent, 'WA');
});

// Member tint and initials are deterministic per identity.
test('memberColorIndex and memberInitials never print a name', () => {
  assert.ok(memberColorIndex('marco') >= 0 && memberColorIndex('marco') < 5);
  assert.equal(memberColorIndex('marco'), memberColorIndex('marco'), 'stable per identity');
  assert.equal(memberInitials('marco'), 'MA');
  assert.equal(memberInitials('sara'), 'SA');
  assert.equal(memberInitials(null), '··');
});

// BO-F6-11 fetta 5 (specs/calendario.md C7): the detail card carries a dark
// primary "Apri scheda cliente" button for linked events, riding the shared
// customer-card route; unlinked events carry no button.
test('the detail card opens the customer card for linked events only', async () => {
  const profilePath = '/api/customer-data/profile/contact/c1';
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const view = createCalendarioView({
    doc,
    mount,
    client: stubClient({
      profiles: {
        [profilePath]: { identity: { contact: { id: 'c1', firstName: 'Ada', lastName: 'Rossi' }, company: null } },
      },
    }),
    navigate: (hash) => { seen.push(hash); },
    now: () => new Date('2026-10-21T08:40:00Z'),
  });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // The profile read fires once, read-only, on selection.
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card, 'C7: the card opens');
  assert.ok(card.textContent.includes('marco, Ada Rossi'), 'C7: the participants name the resolved customer');
  const open = card.findAll('button').find((node) => node.textContent === 'Apri scheda cliente');
  assert.ok(open, 'C7: the linked card carries Apri scheda cliente');
  assert.match(open.getAttribute('class') ?? '', /ui-btn-primary/, 'the button is the dark primary action');
  open.dispatch('click');
  assert.deepEqual(seen, ['#/customer-card/contact/c1'], 'C7: the button opens the customer scheda route');
});

// A half envelope never builds a scheda route: no button without both parts.
test('the detail card hides the customer button without a linked customer', async () => {
  const week = {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-26T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'solo',
        status: 'booked',
        startsAt: '2026-10-22T16:00:00.000Z',
        endsAt: '2026-10-22T16:30:00.000Z',
        serviceKey: 'taglio',
        teamMemberId: 'marco',
        sourceKey: 'calendario:marco:solo:senza-cliente',
        subject: null,
      }],
    }],
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    doc, mount, client: stubClient({ week }), navigate: () => { throw new Error('must not navigate'); },
    now: () => new Date('2026-10-21T08:40:00Z'),
  });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card, 'the card opens for the team-only event');
  assert.equal(
    card.findAll('button').filter((node) => node.textContent === 'Apri scheda cliente').length,
    0,
    'C7: no customer button without a linked customer',
  );
  assert.ok(!card.textContent.includes('Google Calendar'), 'no sync claim without sync state');
});

// BO-F6-11 fetta 5 (specs/calendario.md C8): the WA pill names the resolved
// customer with the shared channel chip; a non-WA event carries no pill and
// no sync row, because rows record no origin and no sync state.
test('the channel pill is fail-closed with the resolved customer name', async () => {
  const week = {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-26T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'w1',
        status: 'booked',
        startsAt: '2026-10-22T16:00:00.000Z',
        endsAt: '2026-10-22T16:30:00.000Z',
        serviceKey: 'taglio',
        teamMemberId: 'marco',
        channel: 'whatsapp',
        sourceKey: 'calendario:marco:w1:c1',
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null },
      }],
    }],
  };
  const profilePath = '/api/customer-data/profile/contact/c1';
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    doc,
    mount,
    client: stubClient({
      week,
      profiles: {
        [profilePath]: { identity: { contact: { id: 'c1', firstName: 'Ada', lastName: 'Rossi' }, company: null } },
      },
    }),
    now: () => new Date('2026-10-21T08:40:00Z'),
  });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card.textContent.includes('Prenotato da Ada Rossi su WhatsApp'), 'C8: the pill names the customer');
  const chips = card.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('ui-chip-wa'));
  assert.equal(chips.length, 1, 'C8: the pill reuses the shared WA channel chip');
});

// A late profile answer stays valid data for its own key: selecting a
// second event while the first profile is in flight drops neither name.
test('overlapping profile reads cache under their own keys', async () => {
  const week = {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-26T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [
        {
          id: 'w1', status: 'booked', startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z',
          serviceKey: 'taglio', teamMemberId: 'marco', sourceKey: 'k1',
          subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null },
        },
        {
          id: 'w2', status: 'booked', startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z',
          serviceKey: 'barba', teamMemberId: 'marco', sourceKey: 'k2',
          subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null },
        },
      ],
    }],
  };
  let releaseProfiles = () => {};
  const gate = new Promise((resolve) => { releaseProfiles = resolve; });
  const calls = [];
  const client = {
    calls,
    async request(path) {
      calls.push(path);
      if (path.startsWith('/api/customer-data/profile/')) {
        await gate;
        const id = path.split('/').pop();
        return { identity: { contact: { id, firstName: `Nome-${id}`, lastName: '' }, company: null } };
      }
      if (path.startsWith('/api/appointments/team-week')) return week;
      if (path === '/api/spine/memberships') {
        // No roster on this double: the spine is uncomposed here, an
        // expected absence the view keeps silent (fetta 7).
        const missing = new Error('no spine here');
        missing.code = 'NOT_FOUND';
        missing.status = 404;
        throw missing;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T08:40:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  mount.findAll('button').find((node) => node.textContent.includes('barba')).dispatch('click');
  releaseProfiles();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // Back to the first event: its late answer cached under its own key.
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card.textContent.includes('marco, Nome-c1'), 'the first name survives the second selection');
  assert.equal(
    calls.filter((path) => path.startsWith('/api/customer-data/profile/')).length,
    2,
    'one profile read per customer, never a refetch',
  );
});

// An unavailable profile never breaks the card: label, then id, never an
// error line — and a hostile profile name stays inert text.
test('the detail card falls back honestly when the profile is unavailable', async () => {
  const week = {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-26T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'w1',
        status: 'booked',
        startsAt: '2026-10-22T16:00:00.000Z',
        endsAt: '2026-10-22T16:30:00.000Z',
        serviceKey: 'taglio',
        teamMemberId: 'marco',
        channel: 'whatsapp',
        sourceKey: 'calendario:marco:w1:c9',
        subject: { resource: 'contact', id: 'c9<script>', owner: 'host', ownerPackage: null },
      }],
    }],
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const view = createCalendarioView({
    doc,
    mount,
    client: stubClient({ week }),
    navigate: (hash) => { seen.push(hash); },
    now: () => new Date('2026-10-21T08:40:00Z'),
  });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card, 'the card opens without a profile');
  assert.ok(card.textContent.includes('c9<script>'), 'the id falls back as inert text');
  assert.ok(card.textContent.includes('Prenotato su WhatsApp'), 'the WA pill degrades without inventing a name');
  assert.ok(!card.textContent.includes('NOT_FOUND') && !card.textContent.includes('404'), 'C22: no technical text');
  card.findAll('button').find((node) => node.textContent === 'Apri scheda cliente').dispatch('click');
  assert.deepEqual(seen, ['#/customer-card/contact/c9%3Cscript%3E'], 'the hostile id travels encoded');
});

// A profile answer that lands after the operator left for the customer card
// must not repaint: the card owns the shared mount by then, and a calendar
// repaint would wipe it while the URL still names the card.
test('a late profile answer never repaints over the customer card', async () => {
  let releaseProfile = () => {};
  const gate = new Promise((resolve) => { releaseProfile = resolve; });
  const client = {
    async request(path) {
      if (path.startsWith('/api/customer-data/profile/')) {
        await gate;
        return { identity: { contact: { id: 'c1', firstName: 'Ada', lastName: 'Rossi' }, company: null } };
      }
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
      if (path === '/api/spine/memberships') {
        // No roster on this double: the spine is uncomposed here, an
        // expected absence the view keeps silent (fetta 7).
        const missing = new Error('no spine here');
        missing.code = 'NOT_FOUND';
        missing.status = 404;
        throw missing;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T08:40:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
  // The customer card takes the shared mount, like renderCard does: it
  // clears the calendar wrap and paints its own node.
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const card = doc.createElement('div');
  card.setAttribute('data-role', 'customer-card');
  mount.appendChild(card);
  releaseProfile();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mount.querySelector('.cal-wrap'), null, 'no calendar repaint over the card');
  assert.equal(
    mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'event-detail').length,
    0,
    'no detail card painted over the customer card',
  );
  assert.equal(mount.firstChild, card, 'the customer card stays mounted');
  // Back on the calendar the late answer is still valid data for its key.
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const reopened = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(reopened.textContent.includes('Ada Rossi'), 'the late name paints on return');
});

// An unexpected profile failure (HTTP 5xx, network fault) keeps the soft
// fallback but is logged with a sanitized cause and the active space —
// never the message, which may carry provider text or personal data.
test('an unexpected profile failure is logged with the space, never the message', async () => {
  const failure = { status: 500, code: 'UPSTREAM_BOOM', message: 'provider outage REF-123 involving Ada Rossi' };
  const client = {
    async request(path) {
      if (path.startsWith('/api/customer-data/profile/')) throw failure;
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
      if (path === '/api/spine/memberships') {
        // No roster on this double: the spine is uncomposed here, an
        // expected absence the view keeps silent (fetta 7).
        const missing = new Error('no spine here');
        missing.code = 'NOT_FOUND';
        missing.status = 404;
        throw missing;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCalendarioView({
      doc,
      mount,
      client,
      storage: { getItem: () => 'space-9' },
      now: () => new Date('2026-10-21T08:40:00Z'),
    });
    await view.render();
    const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
    filter.value = 'marco';
    clickButton(mount, 'Mostra settimana');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
    assert.ok(card.textContent.includes('Ada'), 'the row label still falls back');
    assert.equal(warnings.length, 1, 'one diagnostic: neither silence nor a screen');
    const flat = warnings[0].map(String).join(' ');
    assert.ok(flat.includes('bo-calendario'), 'the log is scoped to the calendar');
    assert.ok(flat.includes('UPSTREAM_BOOM'), 'the sanitized code travels');
    assert.ok(flat.includes('space-9'), 'the active space travels');
    assert.ok(!flat.includes('REF-123') && !flat.includes('Ada Rossi'), 'no message, no personal data');
  } finally {
    console.warn = originalWarn;
  }
});

// An unknown customer stays silent: no log, label fallback, never a screen.
test('a missing profile stays silent while the card falls back', async () => {
  const failure = { status: 404, code: 'NOT_FOUND', message: 'no such customer' };
  const client = {
    async request(path) {
      if (path.startsWith('/api/customer-data/profile/')) throw failure;
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
      if (path === '/api/spine/memberships') {
        // No roster on this double: the spine is uncomposed here, an
        // expected absence the view keeps silent (fetta 7).
        const missing = new Error('no spine here');
        missing.code = 'NOT_FOUND';
        missing.status = 404;
        throw missing;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T08:40:00Z') });
    await view.render();
    const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
    filter.value = 'marco';
    clickButton(mount, 'Mostra settimana');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    mount.findAll('button').find((node) => node.textContent.includes('taglio')).dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
    assert.ok(card.textContent.includes('Ada'), 'the row label still falls back');
    assert.equal(warnings.length, 0, 'an expected miss logs nothing');
  } finally {
    console.warn = originalWarn;
  }
});

// BO-F6-11 fetta 6 (specs/calendario.md C10): one toggle row per named
// member — opaque identities, never invented people, no role line.
test('teamRows names one toggle row per named member, never invented people', () => {
  const rows = teamRows(['marco', 'sara', 'marco'], ['sara']);
  assert.equal(rows.length, 2, 'named members dedup, no invented rows');
  assert.deepEqual(rows[0], {
    id: 'marco', active: true, color: memberColorIndex('marco'), initials: 'MA',
  });
  assert.deepEqual(rows[1], {
    id: 'sara', active: false, color: memberColorIndex('sara'), initials: 'SA',
  });
  assert.deepEqual(teamRows([], []), [], 'no names, no rows');
  assert.deepEqual(teamRows(null, undefined), [], 'non-lists stay empty');
  assert.deepEqual(teamRows(['marco', 42, ''], []), [
    { id: 'marco', active: true, color: memberColorIndex('marco'), initials: 'MA' },
  ], 'non-identities never become rows');
});

const WEEK_TWO = {
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
      ],
    },
    {
      teamMemberId: 'sara',
      appointments: [
        {
          id: 's1',
          status: 'booked',
          startsAt: '2026-10-22T14:00:00.000Z',
          endsAt: '2026-10-22T14:30:00.000Z',
          serviceKey: 'piega',
          teamMemberId: 'sara',
          priceCents: 3000,
          currency: 'EUR',
          notes: null,
          sourceKey: 'calendario:sara:1:c9',
          subject: { resource: 'contact', id: 'c9', owner: 'host', ownerPackage: null, label: 'Bea' },
        },
      ],
    },
  ],
};

// Team toggles carry a title naming the week filter; grid blocks do not,
// so the title scopes the helper to the card (both use aria-pressed).
const teamToggles = (mount) => mount.findAll('button')
  .filter((node) => String(node.getAttribute('title') ?? '').includes('settimana'));

// BO-F6-11 fetta 6 (specs/calendario.md C10, C11): the Team card lists one
// toggle per named member; a click hides that member's blocks with no
// reload, and reselecting brings them back.
test('the Team card toggles one row per named member and filters the grid', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ week: WEEK_TWO });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  assert.ok(texts(mount, 'h2').includes('Team'), 'C10: the Team card paints');
  assert.ok(texts(mount, 'p').some((text) => text.includes('Nomina le persone')), 'no names, honest prompt');
  assert.equal(teamToggles(mount).length, 0, 'no names, no toggles');

  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco, sara';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(teamToggles(mount).length, 2, 'C10: one toggle row per named member');
  assert.ok(teamToggles(mount).every((node) => node.getAttribute('aria-pressed') === 'true'));
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('MA') && node.textContent.includes('marco')));
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('SA') && node.textContent.includes('sara')));
  assert.ok(texts(mount, 'strong').includes('taglio'));
  assert.ok(texts(mount, 'strong').includes('piega'));

  const callsBefore = client.calls.length;
  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.equal(client.calls.length, callsBefore, 'C11: filtering needs no reload');
  assert.ok(texts(mount, 'strong').includes('taglio'), 'the active member stays');
  assert.ok(!texts(mount, 'strong').includes('piega'), 'C11: the deselected member disappears');
  assert.equal(teamToggles(mount).find((node) => node.textContent.includes('sara')).getAttribute('aria-pressed'), 'false');

  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.ok(texts(mount, 'strong').includes('piega'), 'C11: reselecting brings them back');
  assert.equal(teamToggles(mount).find((node) => node.textContent.includes('sara')).getAttribute('aria-pressed'), 'true');
});

// Hiding the selected block's member closes the detail card: its selection
// border is gone, so the card would point at nothing visible.
test('hiding the selected block member closes the detail card', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ week: WEEK_TWO });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco, sara';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mount.findAll('button').find((node) => node.textContent.includes('piega')).dispatch('click');
  assert.ok(mount.findAll('button').some((node) => node.textContent === '×'), 'the detail card opens');
  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.ok(!mount.findAll('button').some((node) => node.textContent === '×'), 'hiding the member closes the card');
  assert.ok(!texts(mount, 'strong').includes('piega'));
});

// BO-F6-11 fetta 7 (specs/calendario.md C10): the roster rows carry the
// names and Italian roles the member list names — only when one exists.
test('teamRowsWithRoles unions the named filter and the roster with Italian roles', () => {
  const members = [
    { subject: 'marco', role: 'operator' },
    { subject: 'sara', role: 'owner' },
    { subject: 'elena', role: 'observer' },
  ];
  const rows = teamRowsWithRoles(['marco'], ['sara'], members);
  assert.equal(rows.length, 3, 'named plus roster-only, deduped');
  assert.deepEqual(rows[0], {
    id: 'marco', active: true, listed: true,
    color: memberColorIndex('marco'), initials: 'MA', role: 'Operatore',
  });
  assert.deepEqual(rows[1], {
    id: 'sara', active: false, listed: false,
    color: memberColorIndex('sara'), initials: 'SA', role: 'Proprietario',
  });
  assert.deepEqual(rows[2], {
    id: 'elena', active: false, listed: false,
    color: memberColorIndex('elena'), initials: 'EL', role: 'Osservatore',
  });
  assert.deepEqual(teamRowsWithRoles(['marco'], [], null), [
    {
      id: 'marco', active: true, listed: true,
      color: memberColorIndex('marco'), initials: 'MA', role: null,
    },
  ], 'no member list: named rows with no role line, never invented');
  assert.deepEqual(teamRowsWithRoles([], [], []), [], 'no names and no roster: no rows');
  assert.deepEqual(teamRowsWithRoles(null, undefined, 'nope'), [], 'non-lists stay empty');
});

// The Team card lists the roster with Italian roles and loads a roster
// member's week on click, without typing their name first.
test('the Team card shows the roster roles and loads a picked member', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    week: WEEK_TWO,
    memberships: [
      { subject: 'marco', role: 'operator' },
      { subject: 'sara', role: 'owner' },
    ],
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(texts(mount, 'h2').includes('Team'), 'the Team card paints');
  assert.equal(teamToggles(mount).length, 2, 'one toggle per roster member, no typing needed');
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('Operatore')), 'the operator role paints in Italian');
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('Proprietario')), 'the owner role paints in Italian');
  assert.ok(!texts(mount, 'strong').includes('taglio'), 'no week yet: nothing listed without asking');

  teamToggles(mount).find((node) => node.textContent.includes('marco')).dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const teamWeek = client.calls.find((call) => String(call.path).startsWith('/api/appointments/team-week'));
  assert.ok(teamWeek && String(teamWeek.path).includes('marco'), 'picking a roster member loads their week');
  assert.ok(texts(mount, 'strong').includes('taglio'), 'the picked member blocks paint');
});

// A refused member list keeps the opaque named toggles: no error where the
// week should be, no invented roster, no technical codes.
test('a refused member list keeps the opaque toggles with no error', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const refused = new Error('forbidden');
  refused.code = 'SPINE_MEMBERSHIP_FORBIDDEN';
  refused.status = 403;
  const client = stubClient({ week: WEEK_TWO, membershipsError: refused });
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try {
    const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
    await view.render();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned.length, 0, 'an expected refusal stays silent');
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco, sara';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(teamToggles(mount).length, 2, 'opaque toggles stay');
  assert.ok(!teamToggles(mount).some((node) => node.textContent.includes('Operatore')), 'no role without a list');
  const body = texts(mount, 'p').join('\n') + texts(mount, 'strong').join('\n');
  for (const banned of ['NOT_FOUND', 'non composto', 'SPINE_', '403', 'undefined']) {
    assert.ok(!body.includes(banned), `no technical residue in the Team card: ${banned}`);
  }
});

// A member list that resolves and then fails must not leave a stale
// roster on screen. With nobody named no week reload repaints, so a
// refused second read would keep showing the previous rows and their
// Italian roles unless the failure path repaints the fallback itself.
test('a failed member-list reload repaints the fallback, never a stale roster', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let refused = false;
  const client = {
    async request(path) {
      if (path === '/api/spine/memberships') {
        if (refused) {
          const forbidden = new Error('forbidden');
          forbidden.code = 'SPINE_MEMBERSHIP_FORBIDDEN';
          forbidden.status = 403;
          throw forbidden;
        }
        return { items: [{ subject: 'marco', role: 'operator' }, { subject: 'sara', role: 'owner' }] };
      }
      if (path.startsWith('/api/appointments/team-week')) return WEEK_TWO;
      throw new Error(`unexpected path ${path}`);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(teamToggles(mount).length, 2, 'two roster toggles while the list resolves');
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('Operatore')), 'the roster role paints while the list resolves');
  refused = true;
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(teamToggles(mount).length, 0, 'no toggles without names or a list');
  assert.ok(!teamToggles(mount).some((node) => node.textContent.includes('Operatore')), 'no stale role without a list');
  assert.ok(!teamToggles(mount).some((node) => node.textContent.includes('Proprietario')), 'no stale role without a list');
  assert.ok(
    texts(mount, 'p').some((text) => text.includes('Nomina le persone')),
    'the honest prompt is back instead of the stale roster',
  );
  const body = texts(mount, 'p').join('\n') + texts(mount, 'strong').join('\n');
  for (const banned of ['NOT_FOUND', 'non composto', 'SPINE_', '403', 'undefined']) {
    assert.ok(!body.includes(banned), `no technical residue in the Team card: ${banned}`);
  }
});

// An unexpected member-list failure is logged with the space, never the
// message or personal data — the same rule as the profile read.
test('an unexpected member-list failure is logged with the space, never the message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const fault = new Error('boom token=secret-payload');
  fault.status = 500;
  const client = stubClient({ week: WEEK_TWO, membershipsError: fault });
  const warned = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try {
    const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
    await view.render();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned.length, 1, 'one diagnostic line for the unexpected fault');
  assert.ok(warned[0].startsWith('bo-calendario members unreadable:'), 'sanitized cause, not the message');
  assert.ok(!warned[0].includes('secret-payload'), 'no personal data in the log');
  assert.ok(warned[0].includes('spaceId='), 'the space rides along for diagnosis');
  assert.equal(teamToggles(mount).length, 0, 'the card still falls back to the honest prompt');
});

// BO-F6-11 fetta 7 (specs/calendario.md C12): the «Prenotazione online»
// card carries the prototype title and fixed line. No link source exists in
// the package or the server (bookFromLink books from a token but nothing
// issues or publishes accordo.dev/p/<slug> to /bo, and the space id is
// opaque), so no URL is guessed and no Copia paints with nothing to copy.
test('the booking card paints the prototype texts with no invented link', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(texts(mount, 'h2').includes('Prenotazione online'), 'C12: the booking card paints');
  const paragraphs = texts(mount, 'p').join('\n');
  assert.ok(
    paragraphs.includes('I clienti vedono solo gli slot liberi del team. Ogni prenotazione finisce nella loro scheda.'),
    'C12: the fixed line is the prototype sentence',
  );
  assert.ok(paragraphs.includes('Il link pubblico non è configurato per questo spazio.'), 'honest empty state, no codes');
  assert.ok(!mount.findAll('button').some((node) => node.textContent === 'Copia'), 'no Copia with nothing to copy');
  assert.ok(!paragraphs.includes('accordo.dev'), 'no invented booking URL');
  for (const banned of ['NOT_FOUND', 'non composto', '404', 'undefined']) {
    assert.ok(!paragraphs.includes(banned), `no technical residue in the booking card: ${banned}`);
  }
});
