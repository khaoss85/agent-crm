// @ts-check

import test from 'node:test';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import {
  channelOf,
  createCalendarioView,
  calendarRefusalText,
  dayHead,
  displayKeys,
  draftDayKey,
  draftDayOnly,
  draftMinutes,
  draftWhen,
  dropHeldOverlaps,
  filterPhraseProposals,
  GRID_START_MINUTES,
  gridRowsFor,
  lanesFor,
  memberColorIndex,
  memberInitials,
  memberLabelFor,
  openingWeekKeys,
  parseMemberFilter,
  personRows,
  resolveDraftMemberIds,
  personFreeSlots,
  rankPhraseProposals,
  resolveMemberName,
  romeMinutes,
  romeWeekKeys,
  serviceKeyFor,
  serviceLabel,
  slotInGrid,
  statusWord,
  teamRows,
  weekCovers,
  weekLabel,
  weekWindow,
} from '../apps/admin/public/admin-calendario.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { hasUnsavedWork, resetVersionWatchState } from '../apps/admin/public/admin-version.js';
import { parseCustomerListQuery } from '../packages/customer-data/src/customers.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The team calendar (BO-F3 "07 Calendario") renders the week from the
 * appointments operations, drafts a phrase into the manual form, proposes
 * free slots and books only on explicit confirmation — all against a stub
 * client here. The full HTTP path is covered by tests/admin-calendario-routes.
 *
 * DOM tests pin `now` to Friday 2026-10-23 06:00Z: the painted week is the
 * Oct 19–25 fixture week, and 08:00 Rome stays outside the painted hours so
 * no now-line appears (backlog:df55cf25: Sunday no longer opens this week).
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

function stubClient({ week = WEEK, slots = [], phrase = null, profiles = null, customers = null, failWith = null, failConfirmWith = null, memberships = undefined, membershipsError = null, profile = undefined, suggestGroups = undefined, catalog = null, failPhraseWith = null } = {}) {
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
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (failWith) throw failWith;
      if (path.startsWith('/api/customer-data/profile/')) {
        if (profiles && Object.hasOwn(profiles, path)) return profiles[path];
        throw notFound();
      }
      if (path.startsWith('/api/catalog/products')) {
        if (catalog) return catalog;
        throw notFound();
      }
      if (path.startsWith('/api/customer-data/customers')) {
        if (customers) return customers(path);
        throw notFound();
      }
      if (path === '/api/appointments/confirm' && failConfirmWith) throw failConfirmWith;
      if (path === '/api/appointments/phrase' && failPhraseWith) throw failPhraseWith;
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
      if (path === '/api/profile') {
        // Unknown by default: the same silence a refused profile keeps, so
        // every older test reads the pre-connection behavior unchanged.
        if (profile !== undefined) return profile;
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) return week;
      if (path.startsWith('/api/appointments/suggest-slots')) {
        if (suggestGroups !== undefined) return { from: '', to: '', slotMinutes: 30, members: suggestGroups };
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

// The roster behind the manual customer search: name buttons only, the same
// read-only list the Clienti view pages.
function customersOf(items) {
  return (path) => {
    const query = new URL(path, 'http://stub.test').searchParams.get('q') ?? '';
    const needle = query.toLowerCase();
    return { items: items.filter((item) => String(item?.name ?? '').toLowerCase().includes(needle)) };
  };
}

// BO-F6-11 fetta 8 (owner 29/10): the manual customer rides a name search,
// never a typed id. Types the query, waits out the search, clicks the name.
async function pickCustomerByName(mount, name, rounds = 7) {
  const search = mount.querySelector('input[name="customerSearch"]');
  assert.ok(search, 'the manual form searches the customer by name');
  search.value = name;
  search.dispatch('input');
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const choice = mount.findAll('button').find((node) => node.textContent === name);
  assert.ok(choice, `the search lists ${name} by name`);
  choice.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
}

// BO-F6-11 fetta 9: the manual person is a choice among the known team while
// the filter names someone — a design-system select, never a typed id. With
// nobody known the plain text field stays.
function personField(mount) {
  return mount.querySelector('select[name="teamMemberId"]')
    ?? mount.findAll('input').find((node) => node.getAttribute('name') === 'teamMemberId')
    ?? null;
}

function choosePerson(mount, id) {
  const field = personField(mount);
  assert.ok(field, 'the manual form names its person');
  field.value = id;
  field.dispatch('change');
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

// backlog:df55cf25 — on Sunday 2026-11-01 the calendar opened the past
// work week (Oct 26–30). The opening week is the containing one on work
// days and the following one on Saturday/Sunday.
test('opening week is the next one on Saturday and Sunday', () => {
  // Sunday 2026-11-01 (Rome): the coming Mon..Sun opens, not Oct 26 – Nov 1.
  assert.deepEqual(openingWeekKeys(new Date('2026-11-01T10:00:00Z')), [
    '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
    '2026-11-06', '2026-11-07', '2026-11-08',
  ]);
  // The painted work days are the coming ones, never the past ones.
  assert.deepEqual(
    displayKeys(openingWeekKeys(new Date('2026-11-01T10:00:00Z'))),
    ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
  );
  // Saturday 2026-10-31 (Rome): same — the Oct 26–30 work days are over.
  assert.deepEqual(openingWeekKeys(new Date('2026-10-31T10:00:00Z'))[0], '2026-11-02');
});

test('opening week is the containing one on work days', () => {
  // Monday 2026-10-26 and Friday 2026-10-30 both open Oct 26 – Nov 1.
  for (const at of ['2026-10-26T10:00:00Z', '2026-10-30T10:00:00Z']) {
    assert.deepEqual(openingWeekKeys(new Date(at)), [
      '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
      '2026-10-30', '2026-10-31', '2026-11-01',
    ]);
  }
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
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
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
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)));
  // Cancelled rows stay listed with their status, in Italian (C14).
  assert.ok(texts(mount, 'span').includes('annullato'));
  assert.ok(!texts(mount, 'span').includes('cancelled'), 'C14: never the raw English status');
  // No customer control paints before a selection: the card owns it (fetta 5).
  assert.equal(mount.findAll('a').length, 0);
  // Selecting the block opens the card, and the card buttons at the scheda.
  const block = mount.findAll('button').find((node) => /taglio/i.test(node.textContent));
  assert.ok(block, 'the taglio block is a button');
  block.dispatch('click');
  const open = mount.findAll('button').find((node) => node.textContent === 'Apri scheda cliente');
  assert.ok(open, 'the card buttons at the scheda, never a raw id');
});

test('the week pager reloads the named members instead of blanking the week', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // The notes moved from the block title to the detail card (backlog:5fbebe8559e9).
  mount.findAll('button').find((node) => /barba/i.test(node.textContent)).dispatch('click');
  assert.ok(texts(mount, 'p').some((text) => text.includes('<img src=x')));
  assert.equal(mount.findAll('img').length, 0);
});

test('uncomposed package renders an honest placeholder, never a blank screen', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const failure = Object.assign(new Error('Not found'), { code: 'NOT_FOUND', status: 404 });
  const view = createCalendarioView({ doc, mount, client: stubClient({ failWith: failure }), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
    startsAt: '2026-10-22T14:00:00.000Z',
    endsAt: '2026-10-22T14:30:00.000Z',
    notes: 'taglio per Ada',
  };
  const slots = [{ startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' }];
  const client = stubClient({ phrase: draft, slots });
  // Pinned before the stub slots: proposals cut begun steps (backlog:d1e4d90e),
  // so the view clock must still see them as future — same Oct 19–25 week.
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
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
  // Production 07/11: the drafted day bounds the search (Rome Thu 22 Oct).
  assert.ok(suggest.path.includes('from=2026-10-21T22'), 'the search covers the drafted day');
  assert.ok(suggest.path.includes('to=2026-10-23T02'), 'and only that day');
  // C5: one row per slot, `<ddd> <n> · <hh:mm>–<hh:mm>` with Conferma.
  const list = mount.querySelector('.cal-slots');
  assert.ok(list, 'the proposal rows render');
  assert.ok(list.textContent.includes('22 ott · 16:00–16:30'), 'C5: the row names the Rome slot');
  const confirms = list.findAll('button').filter((node) => node.textContent === 'Conferma');
  assert.equal(confirms.length, 1, 'C5: one Conferma per row');
  // C5: one dashed ghost per slot on its Rome day, clickable to confirm.
  const grid = mount.querySelector('.cal-grid');
  assert.ok(grid && grid.textContent.includes('✦ Proposta 16:00'), 'C5: the ghost names the Rome time');
  const ghost = mount.findAll('button').find((node) => node.textContent === '✦ Proposta 16:00');
  assert.ok((ghost.getAttribute('class') ?? '').split(/\s+/).includes('bo-add-button'), 'the ghost reuses the shared dashed control');
  // The draft still prefills the manual form (Rome wall time back into the inputs).
  // The filter names marco, so the person is the team choice, not a typed id.
  const form = byName();
  const person = mount.querySelector('select[name="teamMemberId"]');
  assert.ok(person, 'the known person is a choice, never a typed id');
  assert.equal(person.value, 'marco', 'the draft person is the chosen one');
  assert.equal(form.serviceKey.value, 'taglio');
  assert.equal(form.date.value, '2026-10-22');
  assert.equal(form.start.value, '16:00');
  assert.equal(form.end.value, '16:30');
});

test('a proposal Conferma books through confirm with the manual claim', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T14:00:00.000Z',
    endsAt: '2026-10-22T14:30:00.000Z',
  };
  // A free step beside the held taglio (16:00Z): review #646 P2 reads the
  // searched person's week even before one is painted.
  const slots = [{ startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' }];
  const client = stubClient({
    phrase: draft,
    slots,
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  // Pinned before the stub slots: proposals cut begun steps (backlog:d1e4d90e).
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
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
  // The operator picks the customer by name; the slot brings person and time.
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
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
  assert.equal(body.startsAt, '2026-10-22T14:00:00.000Z');
  assert.equal(body.endsAt, '2026-10-22T14:30:00.000Z');
  assert.equal(body.priceCents, 4500);
  assert.deepEqual(body.subject, { resource: 'contact', id: 'c1', owner: 'host' });
  assert.equal(body.sourceKey, 'calendario:marco:2026-10-22T14:00:00.000Z:c1');
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
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(
    texts(mount, 'p').includes('Nessuno slot libero quel giorno, prova con un altro giorno.'),
    'the spec sentence for the drafted day, no code',
  );
  assert.equal(mount.querySelector('.cal-slots'), null, 'no proposal rows, only the manual Conferma');
});

test('a failed search says so in plain words, never a code', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient({ failWith: new Error('backend down') }), now: () => new Date('2026-10-23T06:00:00Z') });
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
    startsAt: '2026-10-22T14:00:00.000Z',
    endsAt: '2026-10-22T14:30:00.000Z',
  };
  // A free step beside the held taglio (16:00Z): review #646 P2 reads the
  // searched person's week even before one is painted.
  const slots = [{ startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' }];
  const client = stubClient({ phrase: draft, slots, failConfirmWith: new Error('serviceKey must be the listino product key') });
  // Pinned before the stub slots: proposals cut begun steps (backlog:d1e4d90e).
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
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
  const client = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]) });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
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
  assert.deepEqual(payload(proposes[0]).subject, { resource: 'contact', id: 'c1', owner: 'host' });
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
  const client = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]) });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
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
  const client = stubClient({
    customers: customersOf([
      { resource: 'contact', id: 'c1', name: 'Ada' },
      { resource: 'contact', id: 'c2', name: 'Bo' },
    ]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  byName().members.value = 'marco';
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
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
  // The operator changes their mind about the customer before reloading.
  clickButton(mount, 'Cambia cliente');
  await pickCustomerByName(mount, 'Bo');
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(texts(mount, 'p').some((text) => text === 'Cliente: Bo'), 'the pick survives the reload');
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/propose').length, 1);
});

test('conferma books directly: no propose call on the confirm path', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]) });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
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

// BO-F6-11 fetta 8 (owner 29/10: the grid covers the proposal hours or says
// so): a slot starting outside 09:00–18:00 never lands on another hour's row.
test('slotInGrid keeps the painted 09:00–18:00 hours, nothing else', () => {
  assert.equal(slotInGrid('2026-10-22T07:00:00.000Z', '2026-10-22T07:30:00.000Z'), true, '09:00 Rome starts inside');
  assert.equal(slotInGrid('2026-10-22T15:30:00.000Z', '2026-10-22T16:00:00.000Z'), true, '17:30 Rome is the last row');
  // backlog:5fbebe8559e9: 18:00 is the bottom edge, not a row — painting it
  // clamped the «✦ Proposta 18:00» ghost onto the 17:30 row.
  assert.equal(slotInGrid('2026-10-22T16:00:00.000Z', '2026-10-22T16:30:00.000Z'), false, '18:00 Rome is the bottom edge');
  assert.equal(slotInGrid('2026-10-22T17:00:00.000Z', '2026-10-22T17:30:00.000Z'), false, '19:00 Rome stays outside');
  assert.equal(slotInGrid('2026-10-22T06:59:00.000Z', '2026-10-22T07:30:00.000Z'), false, '08:59 Rome stays outside');
  assert.equal(slotInGrid('2026-10-22T16:00:00.000Z', '2026-10-22T16:00:00.000Z'), false, 'an empty slot never paints');
  assert.equal(slotInGrid(null, '2026-10-22T16:30:00.000Z'), false, 'an unreadable start never paints');
  assert.equal(slotInGrid('not-a-time', '2026-10-22T16:30:00.000Z'), false, 'a corrupt start fails closed');
});

test('a 19:00 proposal is named below the grid with its real time, never on the 17:00 row', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T17:00:00.000Z',
    endsAt: '2026-10-22T17:30:00.000Z',
    notes: 'taglio serale per Ada',
  };
  const slots = [{ startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z' }];
  const client = stubClient({ phrase: draft, slots });
  // Pinned before the stub slots: proposals cut begun steps (backlog:d1e4d90e);
  // the 19:00 Rome step stays future, so the honest out-of-hours line proves.
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
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
  field.value = 'trova un posto serale con marco';
  clickButton(mount, 'Trova slot liberi');
  await flush();
  const ghosts = mount.findAll('button').filter((node) => (node.textContent ?? '').startsWith('✦ Proposta'));
  assert.equal(ghosts.length, 0, 'no ghost lands on a grid row for the out-of-hours slot');
  assert.ok(
    texts(mount, 'p').some((text) => text.includes('✦ Proposta') && text.includes('19:00') && text.includes("fuori dall'orario mostrato")),
    'the honest line names the real 19:00 time and says the grid does not show it',
  );
});

// BO-F6-11 fetta 8 (owner 29/10: the manual customer rides a name search,
// never a typed id): the search paints name buttons only, a pick names the
// customer, and «Cambia cliente» searches again.
test('the manual customer search lists names, never ids or resources', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    customers: customersOf([
      { resource: 'contact', id: 'c1', name: 'Ada' },
      { resource: 'company', id: 'c2', name: 'Ada Ditta' },
    ]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const search = mount.querySelector('input[name="customerSearch"]');
  assert.ok(search, 'the manual form searches by name');
  assert.equal(search.getAttribute('placeholder'), 'Cerca il cliente per nome…');
  search.value = 'Ad';
  search.dispatch('input');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const names = mount.querySelector('[data-role="customer-results"]').findAll('button').map((node) => node.textContent);
  assert.deepEqual(names, ['Ada', 'Ada Ditta']);
  assert.ok(!mount.querySelector('[data-role="customer-results"]').textContent.includes('c1'), 'no id reaches the screen');
  const fieldNames = mount.findAll('input').map((node) => node.getAttribute('name'));
  assert.ok(!fieldNames.includes('customerResource') && !fieldNames.includes('customerId'), 'no technical customer field');
});

test('a short customer query searches nothing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]) });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const search = mount.querySelector('input[name="customerSearch"]');
  search.value = 'A';
  search.dispatch('input');
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(client.calls.filter((call) => call.path.startsWith('/api/customer-data/customers')).length, 0);
});

test('a customer search without a match says so in plain words', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]) });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const search = mount.querySelector('input[name="customerSearch"]');
  search.value = 'Zzz';
  search.dispatch('input');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(texts(mount, 'p').some((text) => text.includes('Nessun cliente corrisponde')), 'the empty match is honest');
});

test('a failed customer search says so in plain words, never a code', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    customers: () => {
      throw new Error('customer-data is not composed');
    },
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const search = mount.querySelector('input[name="customerSearch"]');
  search.value = 'Ada';
  search.dispatch('input');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(texts(mount, 'p').some((text) => text.includes('non si è potuto leggere')), 'the failure is honest');
});

// BO-F6-11 fetta 8 review (P1: pageSize=5 is refused by
// parseCustomerListQuery): the search asks for a supported server page and
// shows five rows at most.
test('the customer search asks for a supported page and shows five rows at most', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const rows = Array.from(
    { length: 8 },
    (_, index) => ({ resource: 'contact', id: `c${index}`, name: `Adalberto ${index}` }),
  );
  const client = stubClient({
    customers: (path) => {
      const params = new URL(path, 'http://stub.test').searchParams;
      // The real server parses every list query strictly: an unsupported
      // pageSize is a 400, never silent results.
      parseCustomerListQuery(Object.fromEntries(params));
      return customersOf(rows)(path);
    },
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const search = mount.querySelector('input[name="customerSearch"]');
  search.value = 'Adalberto';
  search.dispatch('input');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const asked = client.calls.find((call) => call.path.startsWith('/api/customer-data/customers'));
  assert.ok(asked, 'the search reads the customer list');
  const pageSize = new URL(asked.path, 'http://stub.test').searchParams.get('pageSize');
  assert.ok(['10', '25', '50'].includes(pageSize ?? ''), `pageSize ${pageSize} is a page the server accepts`);
  const names = mount.querySelector('[data-role="customer-results"]').findAll('button').map((node) => node.textContent);
  assert.equal(names.length, 5, 'the search shows five rows at most');
});

// BO-F6-11 fetta 8 review (P2 detached box): a search resolving after a
// re-render paints the live form, not the detached box it started from.
test('a customer search resolving after a re-render paints the live form', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve({ items: [{ resource: 'contact', id: 'c1', name: 'Ada' }] });
  });
  const client = stubClient({ customers: () => gate });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const search = mount.querySelector('input[name="customerSearch"]');
  search.value = 'Ad';
  search.dispatch('input');
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The week moves while the search is in flight: the captured results box
  // is detached by the re-render.
  await view.render();
  release();
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const live = mount.querySelector('[data-role="customer-results"]');
  assert.ok(live, 'the live form has a results box');
  assert.deepEqual(live.findAll('button').map((node) => node.textContent), ['Ada']);
});

test('picking a customer names them and «Cambia cliente» searches again', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    customers: customersOf([
      { resource: 'contact', id: 'c1', name: 'Ada' },
      { resource: 'contact', id: 'c2', name: 'Bo' },
    ]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await pickCustomerByName(mount, 'Ada');
  assert.ok(texts(mount, 'p').some((text) => text === 'Cliente: Ada'), 'the pick names the customer');
  assert.equal(mount.querySelector('input[name="customerSearch"]'), null, 'no search field over a pick');
  clickButton(mount, 'Cambia cliente');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(mount.querySelector('input[name="customerSearch"]'), 'the search returns after «Cambia cliente»');
  await pickCustomerByName(mount, 'Bo');
  assert.ok(texts(mount, 'p').some((text) => text === 'Cliente: Bo'), 'the second pick wins');
});

// BO-F6-11 fetta 2 (specs/calendario.md C1): fixed page chrome.
test('the header carries the prototype eyebrow and title', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const eyebrow = mount.findAll('p').find((node) => node.getAttribute('class') === 'eyebrow');
  assert.equal(eyebrow?.textContent, 'Calendario condiviso', 'C1: eyebrow');
  assert.equal(mount.findAll('h2')[0]?.textContent, 'Agenda del team', 'C1: title');
});

// BO-F6-11 fetta 2 (C2): ‹, interval, ›, Oggi, Nuovo appuntamento — in order.
test('the week bar shows pager, interval, today and booking menu in order', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const first = mount.querySelector('input[name="customerSearch"]');
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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
  const taglio = blocks.find((node) => /taglio/i.test(node.textContent));
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
  const findBlock = () => mount.findAll('button').find((node) => /taglio/i.test(node.textContent));
  const block = findBlock();
  assert.ok(block, 'the taglio block is a button');
  block.dispatch('click');
  // A click rebuilds the DOM: re-query the painted block, never the detached one.
  const selected = findBlock();
  const card = findCards()[0];
  assert.ok(card, 'C6: the click opens the detail card');
  assert.ok(/taglio/i.test(card.textContent), 'C6: the card carries the title');
  assert.ok(card.textContent.includes('Giovedì 22 ott · 18:00–18:30'), 'C6: the card carries the day · time row');
  assert.ok(card.textContent.includes('marco, Ada'), 'C6: the card names the participants');
  assert.ok(selected.getAttribute('class').includes('cal-selected'), 'C9: the selected block reads selected');
  assert.equal(selected.getAttribute('aria-pressed'), 'true');
  const close = card.findAll('button').find((node) => node.textContent === '×');
  assert.ok(close, 'C9: the card carries a close ×');
  close.dispatch('click');
  assert.equal(findCards().length, 0, 'C9: × hides the card');
  // A second click on the block toggles the selection off as well.
  const reopen = mount.findAll('button').find((node) => /taglio/i.test(node.textContent));
  reopen.dispatch('click');
  assert.equal(findCards().length, 1);
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
    client: {
      calls,
      async request(path, options = {}) {
        enforceAdminWriteGate(path, options);
        calls.push(path);
        if (path === '/api/spine/memberships' || path === '/api/profile') {
          // No roster on this double: the spine is uncomposed here, an
          // expected absence the view keeps silent; the profile is unread,
          // so no connect notice paints either.
          const missing = new Error('no spine here');
          missing.code = 'NOT_FOUND';
          missing.status = 404;
          throw missing;
        }
        return week;
      },
    },
    now: () => new Date('2026-10-23T06:00:00Z'),
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
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
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
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
  mount.findAll('button').find((node) => /barba/i.test(node.textContent)).dispatch('click');
  releaseProfiles();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // Back to the first event: its late answer cached under its own key.
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
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
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-data/profile/')) throw failure;
      if (path.startsWith('/api/catalog/products')) throw Object.assign(new Error('no catalog'), { code: 'NOT_FOUND', status: 404 });
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
    mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
    assert.ok(card.textContent.includes('Ada'), 'the row label still falls back');
    // backlog:5fbebe8559e9: the week reads each linked customer once for
    // the block titles (c1, c2) — one diagnostic per failed read.
    assert.equal(warnings.length, 2, 'one diagnostic per failed read: neither silence nor a screen');
    const flat = warnings.map((entry) => entry.map(String).join(' ')).join(' ');
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
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-data/profile/')) throw failure;
      if (path.startsWith('/api/catalog/products')) throw Object.assign(new Error('no catalog'), { code: 'NOT_FOUND', status: 404 });
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
    mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
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
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
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
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)));
  assert.ok(texts(mount, 'strong').some((text) => /^piega\b/i.test(text)));

  const callsBefore = client.calls.length;
  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.equal(client.calls.length, callsBefore, 'C11: filtering needs no reload');
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the active member stays');
  assert.ok(!texts(mount, 'strong').some((text) => /^piega\b/i.test(text)), 'C11: the deselected member disappears');
  assert.equal(teamToggles(mount).find((node) => node.textContent.includes('sara')).getAttribute('aria-pressed'), 'false');

  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.ok(texts(mount, 'strong').some((text) => /^piega\b/i.test(text)), 'C11: reselecting brings them back');
  assert.equal(teamToggles(mount).find((node) => node.textContent.includes('sara')).getAttribute('aria-pressed'), 'true');
});

// Hiding the selected block's member closes the detail card: its selection
// border is gone, so the card would point at nothing visible.
test('hiding the selected block member closes the detail card', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ week: WEEK_TWO });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco, sara';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  mount.findAll('button').find((node) => /piega/i.test(node.textContent)).dispatch('click');
  assert.ok(mount.findAll('button').some((node) => node.textContent === '×'), 'the detail card opens');
  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.ok(!mount.findAll('button').some((node) => node.textContent === '×'), 'hiding the member closes the card');
  assert.ok(!texts(mount, 'strong').some((text) => /^piega\b/i.test(text)));
});

// backlog:df55cf25 (E2E 01/11): one row per person with the real name, never
// a technical id, no role chip. Three subjects of the same human (OAuth,
// Google, mailbox) merge on the person key into a single Dan row.
test('personRows merges one human across subjects with the display name', () => {
  const members = [
    { subject: 'github|48571113', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
    { subject: 'google|1049abc', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
    { subject: 'dan@example.com', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
    { subject: 'sara', role: 'operator', displayName: 'Sara', email: 'sara@example.com' },
  ];
  const named = ['github|48571113', 'google|1049abc', 'dan@example.com'];
  const rows = personRows(named, [], members);
  assert.equal(rows.length, 2, 'three subjects of Dan are one row, plus Sara');
  assert.deepEqual(rows[0].ids, ['github|48571113', 'google|1049abc', 'dan@example.com']);
  assert.equal(rows[0].id, 'github|48571113', 'the named subject stays the booking identity');
  assert.equal(rows[0].name, 'Dan', 'the roster displayName wins over the mailbox');
  assert.equal(rows[0].label, 'Dan', 'the row paints the name, never a subject');
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].listed, true);
  assert.equal(rows[0].color, memberColorIndex('github|48571113'), 'tint stays on the stable subject');
  assert.equal(rows[0].initials, 'DA', 'initials follow the painted name');
  assert.ok(!('role' in rows[0]), 'no role chip on the row: the E2E takes Proprietario out of the card');
  assert.equal(rows[1].label, 'Sara');
});

// A bare roster row (no displayName, no email) names nobody: the operator's
// own typed words paint, unless they look like a technical subject — a pipe
// id never reaches the screen.
test('personRows never paints a technical subject id', () => {
  const rows = personRows(['github|48571113', 'marco'], [], [{ subject: 'github|48571113', role: 'owner' }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, 'Membro del team', 'an unnameable subject gets the generic label');
  assert.equal(rows[1].label, 'marco', 'the typed nickname paints back');
  assert.equal(resolveMemberName('github|48571113', ['github|48571113', 'marco'], [{ subject: 'github|48571113', role: 'owner' }]), null);
  assert.equal(resolveMemberName('marco', ['github|48571113', 'marco'], [{ subject: 'github|48571113', role: 'owner' }]), 'marco');
  assert.equal(memberLabelFor('github|48571113', ['github|48571113'], [{ subject: 'github|48571113', role: 'owner' }]), 'Membro del team');
  assert.equal(memberLabelFor(undefined, [], null), 'Membro del team');
});

// The mailbox alone still identifies the person when no displayName travels.
test('personRows falls back to the mailbox before typed words', () => {
  const rows = personRows([], [], [{ subject: 'x|1', role: 'member', email: 'Sara@Example.com' }]);
  assert.equal(rows.length, 1, 'roster-only subjects still list the person');
  assert.equal(rows[0].name, 'Sara@Example.com');
  assert.equal(rows[0].label, 'Sara@Example.com');
  assert.equal(rows[0].listed, false, 'never named: not listed, not active');
  assert.equal(rows[0].active, false);
  assert.equal(rows[0].initials, 'SA');
  assert.deepEqual(personRows(['marco'], [], null), [
    {
      ids: ['marco'], id: 'marco', name: null, label: 'marco',
      active: true, listed: true,
      color: memberColorIndex('marco'), initials: 'MA',
    },
  ], 'no member list: named rows keep the typed words, never invented');
  assert.deepEqual(personRows([], [], []), [], 'no names and no roster: no rows');
  assert.deepEqual(personRows(null, undefined, 'nope'), [], 'non-lists stay empty');
});

// backlog:df55cf25 (review P1 on #549, owner 04/11): a shared display name
// alone never merges — two email-less homonyms are two humans, two rows, two
// booking identities, with ordinal labels in member-creation order. Toggling
// one row must never hide the other's blocks, and a booking for the second
// human must never carry the first subject.
test('personRows keeps email-less homonyms as separate rows', () => {
  const members = [
    { subject: 'a1', role: 'member', displayName: 'Rossi' },
    { subject: 'a2', role: 'member', displayName: 'Rossi' },
  ];
  const rows = personRows(['a1', 'a2'], [], members);
  assert.equal(rows.length, 2, 'same name without a shared mailbox is two humans');
  assert.deepEqual(rows[0].ids, ['a1']);
  assert.deepEqual(rows[1].ids, ['a2']);
  assert.equal(rows[0].label, 'Rossi (1)');
  assert.equal(rows[1].label, 'Rossi (2)');
  assert.ok(rows[0].label !== rows[1].label, 'the two toggles read differently');
  assert.ok(rows[0].id !== rows[1].id, 'toggling and booking keep distinct identities');
});

// backlog:df55cf25 (owner 04/11, single source of truth): one grouping table
// holding every person-row case — the merged cures of #549 and this one. The
// ordinal follows member creation (member.createdAt when the roster carries
// it, else the roster's own order), never a technical id.
test('personRows grouping table: merge, homonyms, ordinals', () => {
  const cases = [
    {
      name: 'one human across subjects merges on the shared mailbox',
      named: ['github|1', 'google|2', 'dan@example.com'],
      members: [
        { subject: 'github|1', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
        { subject: 'google|2', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
        { subject: 'dan@example.com', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
      ],
      want: [{ ids: ['github|1', 'google|2', 'dan@example.com'], label: 'Dan' }],
    },
    {
      name: 'the mailbox merges case-insensitively',
      named: ['x|1', 'x|2'],
      members: [
        { subject: 'x|1', role: 'member', displayName: 'Dan', email: 'Dan@Example.com' },
        { subject: 'x|2', role: 'member', displayName: 'Dan', email: 'dan@example.com' },
      ],
      want: [{ ids: ['x|1', 'x|2'], label: 'Dan' }],
    },
    {
      name: 'different mailboxes are different humans',
      named: ['a1', 'a2'],
      members: [
        { subject: 'a1', role: 'member', displayName: 'Rossi', email: 'a@example.com' },
        { subject: 'a2', role: 'member', displayName: 'Rossi', email: 'b@example.com' },
      ],
      want: [{ ids: ['a1'], label: 'Rossi (1)' }, { ids: ['a2'], label: 'Rossi (2)' }],
    },
    {
      name: 'email-less homonyms stay separate with ordinals',
      named: ['a1', 'a2'],
      members: [
        { subject: 'a1', role: 'member', displayName: 'Rossi' },
        { subject: 'a2', role: 'member', displayName: 'Rossi' },
      ],
      want: [{ ids: ['a1'], label: 'Rossi (1)' }, { ids: ['a2'], label: 'Rossi (2)' }],
    },
    {
      name: 'three homonyms count up in roster order even when named reversed',
      named: ['a3', 'a1', 'a2'],
      members: [
        { subject: 'a1', role: 'member', displayName: 'Rossi' },
        { subject: 'a2', role: 'member', displayName: 'Rossi' },
        { subject: 'a3', role: 'member', displayName: 'Rossi' },
      ],
      want: [{ ids: ['a3'], label: 'Rossi (3)' }, { ids: ['a1'], label: 'Rossi (1)' }, { ids: ['a2'], label: 'Rossi (2)' }],
    },
    {
      name: 'the ordinal follows member.createdAt when the roster carries it',
      named: ['a1', 'a2'],
      members: [
        { subject: 'a1', role: 'member', displayName: 'Rossi', createdAt: '2026-10-20T10:00:00.000Z' },
        { subject: 'a2', role: 'member', displayName: 'Rossi', createdAt: '2026-10-18T10:00:00.000Z' },
      ],
      want: [{ ids: ['a1'], label: 'Rossi (2)' }, { ids: ['a2'], label: 'Rossi (1)' }],
    },
    {
      name: 'a unique name keeps no ordinal',
      named: ['github|1'],
      members: [
        { subject: 'github|1', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
        { subject: 'sara', role: 'operator', displayName: 'Sara', email: 'sara@example.com' },
      ],
      want: [{ ids: ['github|1'], label: 'Dan' }],
    },
  ];
  for (const { name, named, members, want } of cases) {
    const rows = personRows(named, [], members);
    assert.deepEqual(
      rows.filter((row) => row.listed).map((row) => ({ ids: row.ids, label: row.label })),
      want,
      name,
    );
  }
});

// backlog:df55cf25 (review P3 on #549): initials are unicode letters, so an
// accented Italian name keeps its initial instead of losing it.
test('memberInitials keeps accented initials', () => {
  assert.equal(memberInitials('Èlena'), 'ÈL');
  assert.equal(memberInitials('marco'), 'MA');
  assert.equal(memberInitials('github|48571113'), 'GI');
  assert.equal(memberInitials(''), '··');
});

// The Team card lists the roster with person names and loads the whole
// roster week on mount, without typing any name first
// (backlog:0533362e8efe). The toggles stay for filtering. No role chips:
// backlog:df55cf25 takes «Proprietario» out of the card.
test('the Team card shows the roster names and loads its week with no typing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    week: WEEK_TWO,
    memberships: [
      { subject: 'marco', role: 'operator', displayName: 'Marco' },
      { subject: 'sara', role: 'owner', displayName: 'Sara' },
    ],
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(texts(mount, 'h2').includes('Team'), 'the Team card paints');
  assert.equal(teamToggles(mount).length, 2, 'one toggle per roster member, no typing needed');
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('Marco')), 'the person name paints');
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('Sara')), 'the person name paints');
  assert.ok(!texts(mount, 'span').some((text) => text === 'Operatore' || text === 'Proprietario'), 'no role chip in the card');
  const teamWeek = client.calls.find((call) => String(call.path).startsWith('/api/appointments/team-week'));
  assert.ok(teamWeek, 'the roster week loads on mount');
  assert.ok(String(teamWeek.path).includes('marco') && String(teamWeek.path).includes('sara'), 'the whole roster is listed, never typed');
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the roster blocks paint');
  assert.equal(
    mount.findAll('input').filter((node) => node.getAttribute('name') === 'members').length,
    0,
    'no text field while the roster is known: the team comes from the space',
  );
});

// backlog:df55cf25 (E2E 01/11): the roster knows Dan under three subjects —
// one toggle called Dan, and the detail card names Dan, never the pipe ids.
test('the Team card merges one human across roster subjects', async () => {
  const week = {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-26T00:00:00.000Z',
    members: [
      {
        teamMemberId: 'github|48571113',
        appointments: [{
          id: 'd1', status: 'booked',
          startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z',
          serviceKey: 'taglio', teamMemberId: 'github|48571113',
          subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
        }],
      },
      {
        teamMemberId: 'google|1049abc',
        appointments: [{
          id: 'd2', status: 'booked',
          startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z',
          serviceKey: 'barba', teamMemberId: 'google|1049abc',
          subject: { resource: 'contact', id: 'c9', owner: 'host', ownerPackage: null, label: 'Bea' },
        }],
      },
    ],
  };
  const members = [
    { subject: 'github|48571113', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
    { subject: 'google|1049abc', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
    { subject: 'dan@example.com', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ week, memberships: members });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(teamToggles(mount).length, 1, 'three subjects of Dan are one toggle row');
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('Dan')), 'the toggle names the person');
  const painted = texts(mount, 'button').join('\n') + texts(mount, 'span').join('\n') + texts(mount, 'p').join('\n');
  assert.ok(!painted.includes('github|48571113'), 'no technical subject id on screen');
  assert.ok(!painted.includes('google|1049abc'), 'no technical subject id on screen');
  assert.ok(!painted.includes('dan@example.com'), 'the mailbox is one person, not a second row');
  mount.findAll('button').find((node) => /taglio/i.test(node.textContent)).dispatch('click');
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card, 'the detail card opens');
  assert.ok(card.textContent.includes('Dan, Ada'), 'the card names the person and the customer');
  assert.ok(!card.textContent.includes('|'), 'no pipe id in the card');
});

// Shared fixtures for the #549 review cures: Dan holds two opaque subjects
// under one mailbox, with one booking on each identity.
const DAN_MEMBERS = [
  { subject: 'github|1', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
  { subject: 'google|2', role: 'owner', displayName: 'Dan', email: 'dan@example.com' },
];

const DAN_WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [
    {
      teamMemberId: 'github|1',
      appointments: [{
        id: 'd1', status: 'booked',
        startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'github|1',
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
      }],
    },
    {
      teamMemberId: 'google|2',
      appointments: [{
        id: 'd2', status: 'booked',
        startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z',
        serviceKey: 'barba', teamMemberId: 'google|2',
        subject: { resource: 'contact', id: 'c9', owner: 'host', ownerPackage: null, label: 'Bea' },
      }],
    },
  ],
};

// backlog:df55cf25 (review P2 on #549): a listed person click hides (and
// shows) the whole person with no reload — even a partially-listed row,
// where the roster gained subjects after the filter was set.
test('a partially-listed person hides with no reload', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  // The roster resolves late: the operator types a subset first, then the
  // roster arrives naming a second subject of the same person.
  let releaseMembers = () => {};
  const membersGate = new Promise((resolve) => { releaseMembers = resolve; });
  const base = stubClient({ week: DAN_WEEK, memberships: DAN_MEMBERS });
  const client = {
    ...base,
    async request(path, options) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') {
        await membersGate;
        return { items: DAN_MEMBERS };
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  assert.ok(filter, 'the typed filter stays while the roster is unread');
  filter.value = 'github|1';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the named identity paints');
  releaseMembers();
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(teamToggles(mount).length, 1, 'Dan is one row');
  const weekCalls = () => client.calls.filter((call) => String(call.path).startsWith('/api/appointments/team-week')).length;
  const callsBefore = weekCalls();
  teamToggles(mount).find((node) => node.textContent.includes('Dan')).dispatch('click');
  assert.equal(weekCalls(), callsBefore, 'a listed person hides with no reload');
  assert.ok(!texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the person blocks disappear');
  assert.equal(teamToggles(mount).find((node) => node.textContent.includes('Dan')).getAttribute('aria-pressed'), 'false');
  teamToggles(mount).find((node) => node.textContent.includes('Dan')).dispatch('click');
  assert.equal(weekCalls(), callsBefore, 'showing again needs no reload either');
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the person blocks come back');
});

// backlog:df55cf25 (review P2 on #549): a block and its toggle always match
// — both tint from the person's stable primary subject, even when the
// booking sits on the person's second identity.
test('blocks and toggle share the tint on a two-subject person', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ week: DAN_WEEK, memberships: DAN_MEMBERS });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const toggle = teamToggles(mount).find((node) => node.textContent.includes('Dan'));
  assert.ok(toggle, 'the Dan toggle paints');
  const tints = toggle.findAll('span')
    .map((node) => String(node.getAttribute('class') ?? ''))
    .filter((name) => name.startsWith('cal-m'));
  assert.ok(tints.length > 0, 'the toggle carries a tint');
  const blocks = mount.findAll('button')
    .filter((node) => String(node.getAttribute('class') ?? '').includes('cal-event'));
  assert.equal(blocks.length, 2, 'both identities paint their blocks');
  for (const block of blocks) {
    assert.ok(tints.some((tint) => String(block.getAttribute('class')).includes(tint)),
      'every block matches the toggle tint');
  }
});

// backlog:df55cf25 (owner 04/11): two email-less homonyms paint two distinct
// toggles; hiding one hides only its blocks, and the manual choice offers
// two distinct labels booking the right human.
test('email-less homonyms toggle and book the right human', async () => {
  const week = {
    from: '2026-10-19T00:00:00.000Z',
    to: '2026-10-26T00:00:00.000Z',
    members: [
      {
        teamMemberId: 'a1',
        appointments: [{
          id: 'r1', status: 'booked',
          startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z',
          serviceKey: 'taglio', teamMemberId: 'a1',
          subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
        }],
      },
      {
        teamMemberId: 'a2',
        appointments: [{
          id: 'r2', status: 'booked',
          startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z',
          serviceKey: 'barba', teamMemberId: 'a2',
          subject: { resource: 'contact', id: 'c9', owner: 'host', ownerPackage: null, label: 'Bea' },
        }],
      },
    ],
  };
  const members = [
    { subject: 'a1', role: 'member', displayName: 'Rossi' },
    { subject: 'a2', role: 'member', displayName: 'Rossi' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    week,
    memberships: members,
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const toggles = teamToggles(mount);
  assert.equal(toggles.length, 2, 'two humans are two toggles');
  assert.ok(toggles.some((node) => node.textContent.includes('Rossi (1)')), 'the first human paints');
  assert.ok(toggles.some((node) => node.textContent.includes('Rossi (2)')), 'the second human paints');
  // One separator between the groups too: «+ Prenota» glued to the next
  // span would read «Prenota19» and fake an «a1».
  const painted = [...texts(mount, 'button'), ...texts(mount, 'span')].join('\n');
  assert.ok(!painted.includes('a1') && !painted.includes('a2'), 'no technical subject id on screen');
  toggles.find((node) => node.textContent.includes('Rossi (1)')).dispatch('click');
  assert.ok(!texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'hiding the first hides only its blocks');
  assert.ok(texts(mount, 'strong').some((text) => /^barba\b/i.test(text)), 'the second human stays');
  const options = mount.querySelector('select[name="teamMemberId"]').findAll('option')
    .map((node) => node.textContent);
  assert.ok(options.includes('Rossi (1)') && options.includes('Rossi (2)'), 'the choice names both humans distinctly');
  choosePerson(mount, 'a2');
  await pickCustomerByName(mount, 'Ada');
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
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
  assert.equal(payload(proposes[0]).teamMemberId, 'a2', 'the claim books the chosen human, not the first');
});

// backlog:df55cf25 (review P2 on #549): a partially-listed hide survives the
// next reload, and the week is requested for every subject of each listed
// person — never the filter subset only.
test('a hidden partially-listed person stays hidden after a reload', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let releaseMembers = () => {};
  const membersGate = new Promise((resolve) => { releaseMembers = resolve; });
  const base = stubClient({ week: DAN_WEEK, memberships: DAN_MEMBERS });
  const client = {
    ...base,
    async request(path, options) {
      if (path === '/api/spine/memberships') {
        await membersGate;
        return { items: DAN_MEMBERS };
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  assert.ok(filter, 'the typed filter stays while the roster is unread');
  filter.value = 'github|1';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  releaseMembers();
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(teamToggles(mount).length, 1, 'Dan is one row');
  teamToggles(mount).find((node) => node.textContent.includes('Dan')).dispatch('click');
  assert.ok(!texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the person blocks disappear');
  clickButton(mount, 'Oggi');
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const weekCalls = client.calls.filter((call) => String(call.path).startsWith('/api/appointments/team-week'));
  const last = decodeURIComponent(String(weekCalls[weekCalls.length - 1]?.path ?? ''));
  assert.ok(last.includes('github|1') && last.includes('google|2'), 'the reload asks for every subject of the listed person');
  assert.ok(!texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the named identity stays hidden');
  assert.ok(!texts(mount, 'strong').some((text) => /^barba\b/i.test(text)), 'the sibling identity stays hidden too');
  assert.equal(teamToggles(mount).find((node) => node.textContent.includes('Dan')).getAttribute('aria-pressed'), 'false');
});

// backlog:df55cf25 (review P2 on #549): an explicitly chosen non-primary
// subject is booked as exactly that subject — never silently remapped to
// the group primary.
test('a chosen non-primary subject books exactly that subject', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    week: DAN_WEEK,
    memberships: DAN_MEMBERS,
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const person = mount.querySelector('select[name="teamMemberId"]');
  assert.ok(person, 'the known team paints a choice');
  const values = person.findAll('option').map((node) => node.getAttribute('value'));
  assert.ok(values.includes('github|1') && values.includes('google|2'), 'both subjects stay exact options');
  choosePerson(mount, 'google|2');
  assert.equal(mount.querySelector('select[name="teamMemberId"]').value, 'google|2', 'the kept choice is not remapped');
  await pickCustomerByName(mount, 'Ada');
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
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
  assert.equal(payload(proposes[0]).teamMemberId, 'google|2', 'the claim books the chosen identity');
});

// backlog:df55cf25 (review P2 on #549): the manual fallback field never
// paints a raw pipe id — a draft outsider keeps the visible field empty
// while its identity rides in state for the claim only.
test('a pipe outsider draft keeps an empty visible field and books exact', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'github|48571113',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
  };
  const client = stubClient({
    phrase: draft,
    slots: [],
    memberships: [{ subject: 'sara', role: 'member' }],
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  mount.querySelector('textarea[name="phrase"]').value = 'fissa con github|48571113';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(mount.querySelector('select[name="teamMemberId"]'), null, 'an outsider is not forced into the choice');
  const field = mount.findAll('input').find((node) => node.getAttribute('name') === 'teamMemberId');
  assert.ok(field, 'the typed field keeps the drafted person');
  assert.equal(field.value, '', 'no technical subject id paints on screen');
  const painted = texts(mount, 'button').join('\n') + texts(mount, 'span').join('\n') + texts(mount, 'p').join('\n');
  assert.ok(!painted.includes('github|48571113'), 'no technical subject id on screen');
  await pickCustomerByName(mount, 'Ada');
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
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
  assert.equal(payload(proposes[0]).teamMemberId, 'github|48571113', 'the claim still books the exact drafted identity');
});

// A roster nobody has to type still filters: hiding a roster member hides
// their blocks with no reload, like the named path does.
test('the roster week filters on toggle with no reload', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    week: WEEK_TWO,
    memberships: [
      { subject: 'marco', role: 'operator' },
      { subject: 'sara', role: 'owner' },
    ],
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(texts(mount, 'strong').some((text) => /^piega\b/i.test(text)), 'both roster weeks paint');
  const callsBefore = client.calls.length;
  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.equal(client.calls.length, callsBefore, 'filtering needs no reload');
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the active member stays');
  assert.ok(!texts(mount, 'strong').some((text) => /^piega\b/i.test(text)), 'the deselected roster member disappears');
});

// Without a connected calendar the week panel says how to connect it, with
// a way into Profilo — never a silent empty week (backlog:0533362e8efe).
test('a disconnected calendar shows the Profilo way in the week panel', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const client = stubClient({
    week: WEEK_TWO,
    memberships: [{ subject: 'marco', role: 'operator' }],
    profile: {
      member: { name: 'Guido', email: 'guido', role: null },
      connections: {
        available: true,
        reason: null,
        items: [
          { connector: 'calendar', status: 'disconnected', account: null },
          { connector: 'gmail', status: 'disconnected', account: null },
        ],
      },
    },
  });
  const view = createCalendarioView({
    doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z'),
    navigate: (hash) => { seen.push(hash); },
  });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const body = texts(mount, 'p').join('\n');
  assert.ok(body.includes('non è collegato'), 'the panel names the missing connection');
  assert.ok(body.includes('Profilo'), 'the panel points at Profilo');
  const go = mount.findAll('button').find((node) => node.textContent.includes('Vai al Profilo'));
  assert.ok(go, 'a way into Profilo paints');
  go.dispatch('click');
  assert.deepEqual(seen, ['#/profilo'], 'the way lands on Profilo');
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the local week still paints under the notice');
});

// A connected calendar shows no connect notice: the week is the whole story.
test('a connected calendar shows no connect notice', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    week: WEEK_TWO,
    memberships: [{ subject: 'marco', role: 'operator' }],
    profile: {
      member: { name: 'Guido', email: 'guido', role: null },
      connections: {
        available: true,
        reason: null,
        items: [{ connector: 'calendar', status: 'connected', account: 'guido@palestra.example' }],
      },
    },
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const body = texts(mount, 'p').join('\n');
  assert.ok(!body.includes('non è collegato'), 'no connect notice when connected');
  assert.ok(!mount.findAll('button').some((node) => node.textContent.includes('Vai al Profilo')), 'no Profilo detour when connected');
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the week paints');
});

// An unreadable profile stays silent: unknown is not "not connected", so no
// notice cries wolf about a link the operator may already have.
test('an unreadable profile keeps the old week with no notice', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ week: WEEK_TWO });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const body = texts(mount, 'p').join('\n');
  assert.ok(!body.includes('non è collegato'), 'no notice on an unknown connection');
  assert.ok(texts(mount, 'strong').some((text) => /^taglio\b/i.test(text)), 'the typed week still paints');
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
    const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
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
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
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
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(teamToggles(mount).length, 2, 'two roster toggles while the list resolves');
  assert.ok(teamToggles(mount).some((node) => node.textContent.includes('marco')), 'the person paints while the list resolves');
  refused = true;
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(teamToggles(mount).length, 0, 'no toggles without names or a list');
  assert.ok(!teamToggles(mount).some((node) => node.textContent.includes('marco')), 'no stale person without a list');
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
    const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
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
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
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

// BO-F6-11 fetta 9 (backlog:5fbebe8559e9): the manual person is a choice
// among the known team while the filter names someone — a design-system
// select, never a typed opaque id.
test('the manual person is a choice from the known team', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    memberships: [
      { subject: 'marco', role: 'owner' },
      { subject: 'sara', role: 'member' },
    ],
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  // The roster auto-fills the week: marco and sara are the known team with
  // no typing (backlog:0533362e).
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const person = mount.querySelector('select[name="teamMemberId"]');
  assert.ok(person, 'the known team paints a choice, not a text field');
  assert.ok(!byName().teamMemberId, 'no opaque id to type while the team is known');
  const labels = person.findAll('option').map((node) => node.textContent);
  assert.ok(labels.some((label) => label.includes('marco')), 'marco is offered');
  assert.ok(labels.some((label) => label.includes('sara')), 'sara is offered');
  assert.equal(person.value, '', 'nobody is preselected: an empty choice books nothing');
  await pickCustomerByName(mount, 'Ada');
  choosePerson(mount, 'sara');
  const form = byName();
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
  assert.equal(payload(proposes[0]).teamMemberId, 'sara', 'the claim carries the chosen person');
});

// Fetta 9: with nobody known the plain person field stays, so the operator
// can still book while the roster is unread.
test('no known team keeps the plain person field', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]) });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mount.querySelector('select[name="teamMemberId"]'), null, 'no choice from nobody');
  const field = mount.findAll('input').find((node) => node.getAttribute('name') === 'teamMemberId');
  assert.ok(field, 'the plain field stays as the honest fallback');
  assert.equal(field.getAttribute('placeholder'), 'Persona del team');
  await pickCustomerByName(mount, 'Ada');
  choosePerson(mount, 'marco');
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
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
});

// Fetta 9: a phrase draft naming someone outside the known team keeps the
// typed field prefilled, so nothing the AI named is lost.
test('a draft outsider keeps the typed person field', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
  };
  const client = stubClient({ phrase: draft, slots: [], memberships: [{ subject: 'sara', role: 'member' }] });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The roster auto-fills the known team, so the person starts as a choice.
  assert.ok(mount.querySelector('select[name="teamMemberId"]'), 'the known team starts as a choice');
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(mount.querySelector('select[name="teamMemberId"]'), null, 'an outsider is not forced into the choice');
  const field = mount.findAll('input').find((node) => node.getAttribute('name') === 'teamMemberId');
  assert.ok(field, 'the typed field keeps the drafted person');
  assert.equal(field.value, 'marco');
});

// Fetta 10 (P2 di #481): a phrase draft naming an outsider wins over a
// previous known choice. Before the fix the kept choice ('sara') decided the
// control, the draft id ('marco') was assigned to a select with no matching
// option, the browser cleared it, and the snapshot saved an empty person.
test('a draft outsider wins over a previous known choice', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
  };
  const client = stubClient({
    phrase: draft,
    slots: [],
    memberships: [{ subject: 'sara', role: 'member' }],
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(mount.querySelector('select[name="teamMemberId"]'), 'the known team starts as a choice');
  choosePerson(mount, 'sara');
  await pickCustomerByName(mount, 'Ada');
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(mount.querySelector('select[name="teamMemberId"]'), null, 'the outsider draft leaves the choice');
  const field = mount.findAll('input').find((node) => node.getAttribute('name') === 'teamMemberId');
  assert.ok(field, 'the typed field keeps the drafted outsider');
  assert.equal(field.value, 'marco', 'the drafted identity is not lost');
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  const form = byName();
  form.serviceKey.value = 'taglio';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  clickButton(mount, 'Proponi');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const proposes = client.calls.filter((call) => call.path === '/api/appointments/propose');
  assert.equal(proposes.length, 1);
  assert.equal(payload(proposes[0]).teamMemberId, 'marco', 'the claim carries the drafted person');
});

// Fetta 9 (C22): the service label names no technical concept.
test('the service field carries no listino jargon', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const service = mount.findAll('input').find((node) => node.getAttribute('name') === 'serviceKey');
  assert.ok(service, 'the service field paints');
  assert.equal(service.getAttribute('placeholder'), 'Servizio');
  const screen = mount.textContent;
  assert.ok(!screen.includes('chiave listino'), 'no technical concept reaches the operator');
});

// Voce 714433c2: «Nuovo appuntamento» from the scheda cliente takes the
// one-time pick on render — the manual form opens with the customer chosen,
// and the pick is consumed so a later visit starts unpicked.
test('a stashed appointment pick opens the manual form with the customer', async () => {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
  storage.setItem('accordo.bo.customer-pick.appointment', JSON.stringify({
    resource: 'contact', id: 'c1', name: 'Guido Presti',
  }));
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), storage, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  assert.ok(mount.textContent.includes('Cliente: Guido Presti'),
    'the manual form starts with the picked customer named');
  assert.equal(storage.getItem('accordo.bo.customer-pick.appointment'), null,
    'the pick is read once, never kept');
  // Without a pick the form stays closed with the name search, never a ghost.
  const plain = createMount();
  const plainView = createCalendarioView({
    doc: createFakeDocument(), mount: plain, client: stubClient(), storage,
    now: () => new Date('2026-10-23T06:00:00Z'),
  });
  await plainView.render();
  assert.ok(!plain.textContent.includes('Cliente: Guido Presti'), 'no pick, no named customer');
});

// Supervisor design pass (Dan 03/11): press-and-drag on an empty part of a
// day chooses the slot in half hours and opens Nuovo appuntamento beside it,
// already filled with day, start and end; × closes it.
test('dragging on a day column chooses the slot and opens the filled form beside it', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
  const days = () => mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'));
  const col = days()[2];
  // 18 half-hour rows over 360 px: 20 px each, from 09:00.
  col.getBoundingClientRect = () => ({ top: 0, left: 0, right: 200, bottom: 360, height: 360, width: 200 });
  col.dispatch('pointerdown', { button: 0, clientY: 85, target: col, preventDefault() {} }); // 11:00
  col.dispatch('pointermove', { clientY: 125, target: col }); // 12:00 → 11:00–12:30
  col.dispatch('pointerup', { target: col });
  const pick = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'slot-pick');
  assert.ok(pick, 'the chosen slot stays painted on the grid');
  assert.equal(pick.textContent, '11:00–12:30');
  const pop = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-pop'));
  assert.ok(pop, 'the form opens beside the slot');
  const value = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name)?.value;
  assert.equal(value('date'), '2026-10-21');
  assert.equal(value('start'), '11:00');
  assert.equal(value('end'), '12:30');
  pop.findAll('button').find((node) => node.getAttribute('aria-label') === 'Chiudi').dispatch('click');
  assert.ok(!mount.findAll('div').some((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-pop')), '× closes the form');
});

test('a plain click on an empty slot is half an hour', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
  const col = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'))[0];
  col.getBoundingClientRect = () => ({ top: 0, left: 0, right: 200, bottom: 360, height: 360, width: 200 });
  col.dispatch('pointerdown', { button: 0, clientY: 305, target: col, preventDefault() {} }); // 16:30
  col.dispatch('pointerup', { target: col });
  const pick = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'slot-pick');
  assert.equal(pick?.textContent, '16:30–17:00');
});

// backlog:d7c78e9cdf53 (B5, real phone): on the stacked phone week the
// grid lets the browser pan (styles.css lifts touch-action there), so a
// finger has two outcomes. A tap — touch pointerdown then pointerup on an
// empty slot, no move — opens the filled 30-minute form; a swipe makes the
// browser take the gesture (pointercancel) and nothing opens.
async function phoneWeek() {
  const mount = createMount();
  const view = createCalendarioView({ doc: createFakeDocument(), mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'members').value = 'marco';
  clickButton(mount, 'Mostra settimana');
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
  const col = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'))[1];
  col.getBoundingClientRect = () => ({ top: 0, left: 0, right: 366, bottom: 360, height: 360, width: 366 });
  const hasPop = () => mount.findAll('div').some((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-pop'));
  const pick = () => mount.findAll('div').find((node) => node.getAttribute('data-role') === 'slot-pick');
  return { mount, col, hasPop, pick };
}

test('phone: a tap on an empty slot opens the 30-minute form, no drag needed', async () => {
  const { mount, col, hasPop, pick } = await phoneWeek();
  col.dispatch('pointerdown', { button: 0, pointerType: 'touch', pointerId: 7, clientY: 45, target: col, preventDefault() {} }); // 10:00
  col.dispatch('pointerup', { pointerType: 'touch', pointerId: 7, target: col });
  assert.equal(pick()?.textContent, '10:00–10:30', 'the tapped half hour is chosen');
  assert.ok(hasPop(), 'the Nuovo appuntamento form opens');
  const value = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name)?.value;
  assert.equal(value('date'), '2026-10-20');
  assert.equal(value('start'), '10:00');
  assert.equal(value('end'), '10:30');
});

test('phone: a swipe over the grid (pointercancel) opens nothing and leaves no pick', async () => {
  const { col, hasPop, pick } = await phoneWeek();
  col.dispatch('pointerdown', { button: 0, pointerType: 'touch', pointerId: 8, clientY: 45, target: col, preventDefault() {} });
  col.dispatch('pointercancel', { pointerType: 'touch', pointerId: 8, target: col });
  col.dispatch('pointerup', { pointerType: 'touch', pointerId: 8, target: col });
  assert.equal(pick(), undefined, 'no slot stays chosen');
  assert.ok(!hasPop(), 'no form opens');
  // (The live drag block leaves via Element.remove(), which the fake DOM
  // lacks; the cancel itself is what this test pins: no pick, no form.)
});

// backlog:49bd3657b0f8: the view keeps the typed phrase in module state
// across re-renders, so after the shell routes away the DOM check would
// read a clean page while the draft survives. Leaving mirrors it into the
// bundle watch: the reload waits behind the notice instead of losing it.
test('leaving Calendario with a typed phrase keeps a draft mark, so the bundle watch waits', async () => {
  resetVersionWatchState();
  try {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
    await view.render();
    const field = mount.querySelector('textarea[name="phrase"]');
    assert.ok(field, 'the phrase field renders');
    field.value = 'trova 45 minuti con marco';
    field.dispatch('input');
    view.invalidate();
    assert.equal(hasUnsavedWork(createFakeDocument()), true, 'the retained phrase defers the reload on a clean screen');
  } finally {
    resetVersionWatchState();
  }
});

test('clearing the phrase clears the draft mark, so the bundle reloads', async () => {
  resetVersionWatchState();
  try {
    const doc = createFakeDocument();
    const mount = createMount();
    const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
    await view.render();
    const field = mount.querySelector('textarea[name="phrase"]');
    assert.ok(field, 'the phrase field renders');
    field.value = 'trova 45 minuti con marco';
    field.dispatch('input');
    field.value = '';
    field.dispatch('input');
    view.invalidate();
    assert.equal(hasUnsavedWork(createFakeDocument()), false, 'no draft, no wait');
  } finally {
    resetVersionWatchState();
  }
});

test('the auto-filled roster is not operator text: leaving with it alone sets no mark', async () => {
  resetVersionWatchState();
  try {
    const doc = createFakeDocument();
    const mount = createMount();
    const client = stubClient({ memberships: [{ subject: 'marco' }] });
    const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
    await view.render();
    for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setImmediate(resolve));
    view.invalidate();
    assert.equal(hasUnsavedWork(createFakeDocument()), false, 'an auto-filled roster never pins the notice');
  } finally {
    resetVersionWatchState();
  }
});

test('draftMinutes prefers the pair, then the stated duration, then 30 (backlog:d1e4d90e)', () => {
  assert.equal(
    draftMinutes({ startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:45:00.000Z' }),
    45,
  );
  assert.equal(draftMinutes({ durationMinutes: 45 }), 45, 'a 45 minuti sentence without a time searches 45');
  assert.equal(draftMinutes({ durationMinutes: 7 }), 30, 'an unacceptable duration falls back');
  assert.equal(draftMinutes({}), 30);
  assert.equal(draftMinutes(null), 30);
});

test('resolveDraftMemberIds maps a drafted name to booking identities (backlog:d1e4d90e)', () => {
  const members = [
    { subject: 'coach-guido', displayName: 'Marco', email: 'guido@example.com' },
    { subject: 'google|g1', displayName: 'Marco', email: 'guido@example.com' },
    { subject: 'coach-sara', displayName: 'Sara', email: 'sara@example.com' },
  ];
  assert.deepEqual(resolveDraftMemberIds('coach-sara', [], members), ['coach-sara'], 'exact identity wins');
  assert.deepEqual(
    resolveDraftMemberIds('marco', [], members),
    ['coach-guido', 'google|g1'],
    'one human across subjects resolves to every identity',
  );
  assert.deepEqual(resolveDraftMemberIds('MARCO ', [], members), ['coach-guido', 'google|g1'], 'case and spaces ignored');
  const homonyms = [
    { subject: 'a1', displayName: 'Marco' },
    { subject: 'a2', displayName: 'Marco' },
  ];
  assert.deepEqual(resolveDraftMemberIds('Marco', [], homonyms), [], 'homonyms never pick a human');
  assert.deepEqual(resolveDraftMemberIds('sconosciuto', [], members), [], 'strangers keep the outsider path');
  assert.deepEqual(resolveDraftMemberIds('', [], members), [], 'empty drafts nothing');
});

// backlog:d1e4d90e — the server answers per booking identity, so one human
// with two identities needs the intersection: a step held under coach-guido
// must not be offered as free under google|g1.
test('personFreeSlots offers a step only when every identity reports it free', () => {
  const step = { startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' };
  const other = { startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T17:30:00.000Z' };
  const held = [
    { teamMemberId: 'coach-guido', slots: [other] },
    { teamMemberId: 'google|g1', slots: [step, other] },
  ];
  assert.deepEqual(
    personFreeSlots(held, ['coach-guido', 'google|g1'], 'coach-guido'),
    [{ ...other, teamMemberId: 'coach-guido' }],
    'the step held under one identity is not offered under the other',
  );
  const free = [
    { teamMemberId: 'coach-guido', slots: [step, other] },
    { teamMemberId: 'google|g1', slots: [step, other] },
  ];
  assert.deepEqual(
    personFreeSlots(free, ['coach-guido', 'google|g1'], 'coach-guido'),
    [
      { ...step, teamMemberId: 'coach-guido' },
      { ...other, teamMemberId: 'coach-guido' },
    ],
    'free under both means offered once, booked on the drafted identity',
  );
  assert.deepEqual(
    personFreeSlots(free, ['coach-guido', 'google|g1'], 'Marco'),
    [
      { ...step, teamMemberId: 'coach-guido' },
      { ...other, teamMemberId: 'coach-guido' },
    ],
    'a name match books the first searched identity, deterministically',
  );
  assert.deepEqual(
    personFreeSlots([{ teamMemberId: 'coach-guido', slots: [step] }], ['coach-guido', 'google|g1'], 'coach-guido'),
    [],
    'a searched identity with no answer group proves nothing: fail closed',
  );
  assert.deepEqual(
    personFreeSlots([{ teamMemberId: 'marco', slots: [step, { startsAt: '', endsAt: '' }] }], ['marco'], 'marco'),
    [{ ...step, teamMemberId: 'marco' }],
    'a single identity keeps the plain union, corrupt rows dropped',
  );
  assert.deepEqual(personFreeSlots('nope', ['marco'], 'marco'), [], 'non-lists stay empty');
});

test('a phrase step held under one identity is never proposed under the other', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const step = { startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' };
  const client = stubClient({
    phrase: {
      teamMemberId: 'coach-guido',
      serviceKey: 'taglio',
      startsAt: step.startsAt,
      endsAt: step.endsAt,
    },
    memberships: [
      { subject: 'coach-guido', displayName: 'Marco', email: 'guido@example.com' },
      { subject: 'google|g1', displayName: 'Marco', email: 'guido@example.com' },
    ],
    suggestGroups: [
      { teamMemberId: 'coach-guido', slots: [] },
      { teamMemberId: 'google|g1', slots: [step] },
    ],
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con coach-guido';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const suggest = client.calls.find((call) => call.path.startsWith('/api/appointments/suggest-slots'));
  assert.ok(suggest, 'the phrase feeds a slot search');
  assert.ok(suggest.path.includes('google%7Cg1'), 'every identity the human holds is searched');
  assert.ok(
    texts(mount, 'p').includes('Nessuno slot libero quel giorno, prova con un altro giorno.'),
    'the step held under coach-guido is not offered as free under google|g1',
  );
  assert.equal(mount.querySelector('.cal-slots'), null, 'no proposal rows, only the manual Conferma');
});

test('a phrase step free under every identity is proposed once on the drafted one', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const step = { startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' };
  const client = stubClient({
    phrase: {
      teamMemberId: 'coach-guido',
      serviceKey: 'taglio',
      startsAt: step.startsAt,
      endsAt: step.endsAt,
    },
    memberships: [
      { subject: 'coach-guido', displayName: 'Marco', email: 'guido@example.com' },
      { subject: 'google|g1', displayName: 'Marco', email: 'guido@example.com' },
    ],
    suggestGroups: [
      { teamMemberId: 'coach-guido', slots: [step] },
      { teamMemberId: 'google|g1', slots: [step] },
    ],
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con coach-guido';
  clickButton(mount, 'Trova slot liberi');
  for (let round = 0; round < 7; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const confirms = mount.querySelector('.cal-slots').findAll('button')
    .filter((node) => node.textContent === 'Conferma');
  assert.equal(confirms.length, 1, 'one row for the step free under both identities, never two');
  await pickCustomerByName(mount, 'Ada');
  confirms[0].dispatch('click');
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const booked = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(booked.length, 1, 'Conferma calls confirmBooking');
  assert.equal(payload(booked[0]).teamMemberId, 'coach-guido', 'the booking stays on the drafted identity');
});

test('filterPhraseProposals cuts begun steps, keeps named out-of-hours (backlog:d1e4d90e)', () => {
  const nowMs = Date.parse('2026-11-04T08:00:00.000Z');
  const slots = [
    { startsAt: '2026-11-02T08:00:00.000Z', endsAt: '2026-11-02T08:30:00.000Z' },
    { startsAt: '2026-11-04T05:00:00.000Z', endsAt: '2026-11-04T05:30:00.000Z' },
    { startsAt: '2026-11-04T22:00:00.000Z', endsAt: '2026-11-04T22:30:00.000Z' },
    { startsAt: '2026-11-04T08:00:00.000Z', endsAt: '2026-11-04T08:30:00.000Z' },
    { startsAt: '2026-11-04T09:00:00.000Z', endsAt: '2026-11-04T09:30:00.000Z' },
    { startsAt: 'not-a-time', endsAt: '2026-11-04T09:30:00.000Z' },
  ];
  assert.deepEqual(
    filterPhraseProposals(slots, nowMs).map((slot) => slot.startsAt),
    ['2026-11-04T22:00:00.000Z', '2026-11-04T08:00:00.000Z', '2026-11-04T09:00:00.000Z'],
    'past Monday and corrupt rows go, future night steps stay for the honest lines',
  );
  assert.deepEqual(filterPhraseProposals('nope', nowMs), [], 'non-lists stay empty');
});

test('rankPhraseProposals puts the painted hours first, night stays behind (backlog:d1e4d90e)', () => {
  // 2026-11-04: Rome is UTC+1, so 02:00Z is night and 08:00Z is 09:00 in Rome.
  const night = { startsAt: '2026-11-04T02:00:00.000Z', endsAt: '2026-11-04T02:30:00.000Z' };
  const morning = { startsAt: '2026-11-04T08:00:00.000Z', endsAt: '2026-11-04T08:30:00.000Z' };
  const evening = { startsAt: '2026-11-04T17:30:00.000Z', endsAt: '2026-11-04T18:00:00.000Z' };
  assert.deepEqual(
    rankPhraseProposals([night, evening, morning]).map((slot) => slot.startsAt),
    [morning.startsAt, night.startsAt, evening.startsAt],
    'day steps first in time order, out-of-hours behind for the honest lines, never dropped',
  );
  assert.deepEqual(rankPhraseProposals([night]), [night], 'a night-only week still proposes honestly');
  assert.deepEqual(rankPhraseProposals('nope'), [], 'non-lists stay empty');
});

// backlog:5fbebe8559e9 — completion like the prototype, plus the production
// defects the Mac session saw on 07/11.

const flushAll = async (n = 8) => {
  for (let round = 0; round < n; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

async function showWeek(mount, members = 'marco') {
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = members;
  clickButton(mount, 'Mostra settimana');
  await flushAll();
}

function eventBlocks(mount) {
  return mount.findAll('button').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('cal-event'));
}

test('serviceLabel names the catalog product, else the readable key, never the raw slug', () => {
  const names = new Map([['lezione-prova', 'Lezione di prova']]);
  assert.equal(serviceLabel('lezione-prova', names), 'Lezione di prova');
  assert.equal(serviceLabel('LEZIONE-PROVA', names), 'Lezione di prova', 'the listino key compares case-blind');
  assert.equal(serviceLabel('lezione-prova', null), 'Lezione prova', 'no catalog: the key made readable');
  assert.equal(serviceLabel('taglio_donna', new Map()), 'Taglio donna');
  assert.equal(serviceLabel('', names), 'Appuntamento');
  assert.equal(serviceLabel(undefined, names), 'Appuntamento');
});

test('statusWord says a dead booking in Italian, never the raw English status (C14)', () => {
  assert.equal(statusWord('cancelled'), 'annullato');
  assert.equal(statusWord('done'), 'svolto');
  assert.equal(statusWord('no-show'), 'non presentato');
  assert.equal(statusWord('weird'), 'non attivo');
  assert.equal(statusWord('toString'), 'non attivo');
});

test('a block names service and customer like the prototype, never the raw key (defect 07/11)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = {
    ...WEEK,
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        ...WEEK.members[0].appointments[0],
        serviceKey: 'lezione-prova',
        subject: { resource: 'contact', id: 'c7', owner: 'host', ownerPackage: null },
      }],
    }],
  };
  const client = stubClient({
    week,
    catalog: { products: [{ sku: 'lezione-prova', name: 'Lezione di prova' }] },
    profiles: { '/api/customer-data/profile/contact/c7': { identity: { contact: { firstName: 'Mario', lastName: 'Rossi' } } } },
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  const titles = texts(mount, 'strong');
  assert.ok(titles.includes('Lezione di prova · Mario Rossi'), `the block reads service · customer: ${JSON.stringify(titles)}`);
  assert.ok(!mount.textContent.includes('lezione-prova'), 'the raw listino key never paints');
  // One catalog read and one profile read per customer serve every repaint.
  const reads = (prefix) => client.calls.filter((call) => call.path.startsWith(prefix)).length;
  assert.equal(reads('/api/catalog/products'), 1);
  assert.equal(reads('/api/customer-data/profile/contact/c7'), 1);
  eventBlocks(mount)[0].dispatch('click');
  await flushAll();
  assert.equal(reads('/api/customer-data/profile/contact/c7'), 1, 'the detail card reuses the cached name');
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card.textContent.includes('Lezione di prova · Mario Rossi'), 'C6: the card title matches the block');
});

test('without a catalog or a name the block keeps the readable service alone', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const week = {
    ...WEEK,
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        ...WEEK.members[0].appointments[0],
        serviceKey: 'lezione-prova',
        subject: { resource: 'contact', id: 'c8', owner: 'host', ownerPackage: null },
      }],
    }],
  };
  const view = createCalendarioView({ doc, mount, client: stubClient({ week }), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  assert.ok(texts(mount, 'strong').includes('Lezione prova'), JSON.stringify(texts(mount, 'strong')));
  assert.ok(!texts(mount, 'strong').some((text) => text.includes('c8')), 'a customer id is never a name');
});

test('a draft without a time names the duration, never «? –» (defect 07/11)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = { teamMemberId: 'Daniele', durationMinutes: 45 };
  const client = stubClient({ phrase: draft, slots: [], suggestGroups: [{ teamMemberId: 'Daniele', slots: [] }] });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con Daniele';
  clickButton(mount, 'Trova slot liberi');
  await flushAll();
  const lines = texts(mount, 'p');
  assert.ok(lines.includes('Bozza: Daniele · 45 minuti'), JSON.stringify(lines));
  assert.ok(!lines.some((text) => text.startsWith('Bozza') && text.includes('?')), 'no question mark stands in for a time');
});

test('dropHeldOverlaps keeps only slots clear of the person own held bookings', () => {
  const week = {
    members: [
      { teamMemberId: 'marco', appointments: [
        { status: 'booked', startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T09:00:00.000Z' },
        { status: 'cancelled', startsAt: '2026-10-22T10:00:00.000Z', endsAt: '2026-10-22T11:00:00.000Z' },
      ] },
      { teamMemberId: 'sara', appointments: [
        { status: 'confirmed', startsAt: '2026-10-22T12:00:00.000Z', endsAt: '2026-10-22T13:00:00.000Z' },
      ] },
    ],
  };
  const slots = [
    { startsAt: '2026-10-22T08:30:00.000Z', endsAt: '2026-10-22T09:15:00.000Z' },
    { startsAt: '2026-10-22T09:00:00.000Z', endsAt: '2026-10-22T09:45:00.000Z' },
    { startsAt: '2026-10-22T10:00:00.000Z', endsAt: '2026-10-22T10:45:00.000Z' },
    { startsAt: '2026-10-22T12:00:00.000Z', endsAt: '2026-10-22T12:45:00.000Z' },
    { startsAt: 'nope', endsAt: '2026-10-22T12:45:00.000Z' },
  ];
  assert.deepEqual(dropHeldOverlaps(slots, week, ['marco']).map((slot) => slot.startsAt), [
    '2026-10-22T09:00:00.000Z', '2026-10-22T10:00:00.000Z', '2026-10-22T12:00:00.000Z',
  ], 'touching is free, a cancelled row frees its time, another person never blocks');
  assert.deepEqual(dropHeldOverlaps(null, week, ['marco']), []);
});

test('a proposal on top of a held booking is never offered (defect 07/11)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = { teamMemberId: 'marco', durationMinutes: 30 };
  // 16:00Z is the held taglio (18:00 Rome); 14:00Z is free.
  const slots = [
    { startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' },
    { startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' },
  ];
  const view = createCalendarioView({ doc, mount, client: stubClient({ phrase: draft, slots }), now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flushAll();
  const list = mount.querySelector('.cal-slots');
  assert.ok(list.textContent.includes('22 ott · 16:00–16:30'));
  assert.ok(!list.textContent.includes('18:00'), 'the held 18:00 step is not proposed');
  assert.equal(list.findAll('button').length, 1);
});

test('lanes follow the painted rows: touching blocks that share a row sit side by side', () => {
  // 10:00–10:45 and 10:45–11:30 Rome both cover the 10:30 row.
  const held = { startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:45:00.000Z' };
  const ghost = { startsAt: '2026-10-22T08:45:00.000Z', endsAt: '2026-10-22T09:30:00.000Z' };
  const later = { startsAt: '2026-10-22T10:00:00.000Z', endsAt: '2026-10-22T10:30:00.000Z' };
  const lanes = lanesFor([held, ghost, later]);
  assert.notEqual(lanes.get(held).lane, lanes.get(ghost).lane);
  assert.equal(lanes.get(later).lane, 0, 'a block on free rows takes the first lane');
});

test('ghosts never paint over a booking or over each other (defect 07/11)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = { teamMemberId: 'marco', durationMinutes: 45 };
  // Thursday 22 Oct, Rome = UTC+2: two contiguous 45-minute steps whose
  // painted rows overlap (16:00–16:45 and 16:45–17:30), beside sara's piega
  // at 16:00–16:30 on the same day.
  const slots = [
    { startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:45:00.000Z' },
    { startsAt: '2026-10-22T14:45:00.000Z', endsAt: '2026-10-22T15:30:00.000Z' },
  ];
  const view = createCalendarioView({ doc, mount, client: stubClient({ week: WEEK_TWO, phrase: draft, slots }), now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await showWeek(mount, 'marco, sara');
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flushAll();
  const ghosts = mount.findAll('button').filter((node) => (node.textContent ?? '').startsWith('✦ Proposta'));
  assert.equal(ghosts.length, 2);
  const piega = eventBlocks(mount).find((node) => /piega/i.test(node.textContent));
  const column = (node) => /grid-column: (\d+)/.exec(node.getAttribute('style') ?? '')?.[1];
  const first = ghosts.find((node) => node.textContent === '✦ Proposta 16:00');
  const second = ghosts.find((node) => node.textContent === '✦ Proposta 16:45');
  // The 16:00 ghost shares the 16:00 row with piega; the two ghosts share
  // the 16:30 row: each pair sits in different lanes.
  assert.notEqual(column(first), column(piega), 'the ghost sits beside the booking');
  assert.notEqual(column(first), column(second), 'the ghosts sit beside each other');
  assert.ok(ghosts.every((node) => !(node.getAttribute('style') ?? '').includes('1 / -1')), 'no ghost spans the whole day');
});

test('C16: a week with zero events keeps days and hours, no technical message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const empty = { ...WEEK, members: [{ teamMemberId: 'marco', appointments: [] }] };
  const view = createCalendarioView({ doc, mount, client: stubClient({ week: empty }), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  const byClass = (name) => mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes(name));
  assert.equal(byClass('cal-day').length, 5);
  assert.equal(byClass('cal-hour').length, 10);
  assert.equal(eventBlocks(mount).length, 0);
  const grid = mount.querySelector('.cal-week');
  assert.doesNotMatch(grid.textContent, /NOT_FOUND|non composto|error|undefined|null/i);
});

test('an empty day carries a compact row with «+ Prenota» for the phone stack', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  const classesOf = (node) => (node.getAttribute('class') ?? '').split(/\s+/);
  const byClass = (name) => mount.findAll('div').filter((node) => classesOf(node).includes(name));
  // WEEK holds Thu (taglio) and Fri (barba): Mon–Wed are empty.
  const compact = byClass('cal-day-compact');
  assert.deepEqual(compact.map((node) => node.getAttribute('data-day')), ['2026-10-19', '2026-10-20', '2026-10-21']);
  assert.ok(compact[0].textContent.includes('lun 19'));
  assert.ok(compact[0].textContent.includes('Nessun appuntamento'));
  // Desktop still paints five timelines; the empty ones carry the marker the
  // phone CSS collapses, the days with blocks never do.
  const days = byClass('cal-day');
  assert.equal(days.length, 5);
  assert.deepEqual(days.map((node) => classesOf(node).includes('is-empty')), [true, true, true, false, false]);
  const book = compact[1].findAll('button').find((node) => node.textContent === '+ Prenota');
  assert.ok(book, 'the compact row books that day');
  book.dispatch('click');
  await flushAll();
  const field = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  assert.equal(field('date').value, '2026-10-20', '«+ Prenota» opens the form on that day');
  assert.equal(field('start').value, '', 'no hour is invented');
});

// Review #646 (Muse, head 60594fa5).

test('review #646 P2: GRID_START_MINUTES stays exported beside the grid geometry', () => {
  assert.equal(GRID_START_MINUTES, 9 * 60);
});

test('review #646 P1: «+ Prenota» drops the times of an earlier slot', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ doc, mount, client: stubClient(), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  // An earlier pick set Thursday 16:00–16:30 in the form.
  const field = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  field('date').value = '2026-10-22';
  field('date').dispatch('input');
  field('start').value = '16:00';
  field('start').dispatch('input');
  field('end').value = '16:30';
  field('end').dispatch('input');
  const compact = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('cal-day-compact'));
  compact[1].findAll('button').find((node) => node.textContent === '+ Prenota').dispatch('click');
  await flushAll();
  assert.equal(field('date').value, '2026-10-20', 'the tapped day');
  assert.equal(field('start').value, '', 'never the earlier start');
  assert.equal(field('end').value, '', 'never the earlier end');
});

test('review #646 P1: after a phrase draft filled the form, «+ Prenota» keeps person and service, never its day and hour', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = { teamMemberId: 'marco', serviceKey: 'taglio', startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' };
  const view = createCalendarioView({
    doc, mount, client: stubClient({ phrase: draft, slots: [] }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await showWeek(mount);
  mount.querySelector('textarea[name="phrase"]').value = 'taglio con marco giovedì alle 16';
  clickButton(mount, 'Trova slot liberi');
  await flushAll();
  const field = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  assert.equal(field('start').value, '16:00', 'the draft filled the form');
  const compact = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('cal-day-compact'));
  compact[0].findAll('button').find((node) => node.textContent === '+ Prenota').dispatch('click');
  await flushAll();
  assert.equal(field('date').value, '2026-10-19', 'the tapped day wins over the draft day');
  assert.equal(field('start').value, '', 'the draft hour is not carried to another day');
  assert.equal(field('end').value, '');
  assert.equal(field('serviceKey').value, 'taglio', 'the draft service is kept');
});

test('review #646 P2: the held guard reads the searched person, not only the painted week', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const sara = {
    ...WEEK,
    members: [{
      teamMemberId: 'sara',
      appointments: [{ ...WEEK_TWO.members[1].appointments[0] }],
    }],
  };
  const base = stubClient({
    phrase: { teamMemberId: 'sara', durationMinutes: 30 },
    suggestGroups: [{ teamMemberId: 'sara', slots: [
      // 14:00Z is sara's held piega; 13:00Z is free.
      { startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' },
      { startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T13:30:00.000Z' },
    ] }],
  });
  const weeks = [];
  const client = {
    ...base,
    calls: base.calls,
    async request(path, options = {}) {
      if (path.startsWith('/api/appointments/team-week')) {
        weeks.push(path);
        if (path.includes('teamMemberIds=sara')) return sara;
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await showWeek(mount, 'marco');
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con sara';
  clickButton(mount, 'Trova slot liberi');
  await flushAll();
  assert.ok(weeks.some((path) => path.includes('teamMemberIds=sara')), 'the searched person week is read');
  const list = mount.querySelector('.cal-slots');
  assert.ok(list.textContent.includes('22 ott · 15:00–15:30'), list.textContent);
  assert.ok(!list.textContent.includes('16:00–16:30'), 'the step on sara\'s held piega is never offered');
});

// Review #646 round 3 (Muse, head f20a1081).

test('review #646 r3: a day whose only bookings are hidden never reads «Nessun appuntamento»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  // marco holds Thursday, sara only Wednesday 21 Oct (16:00 Rome).
  const week = {
    ...WEEK_TWO,
    members: [
      WEEK_TWO.members[0],
      { teamMemberId: 'sara', appointments: [{ ...WEEK_TWO.members[1].appointments[0], startsAt: '2026-10-21T14:00:00.000Z', endsAt: '2026-10-21T14:30:00.000Z' }] },
    ],
  };
  const view = createCalendarioView({ doc, mount, client: stubClient({ week }), now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  await showWeek(mount, 'marco, sara');
  const compactDays = () => mount.findAll('div')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('cal-day-compact'))
    .map((node) => node.getAttribute('data-day'));
  assert.ok(!compactDays().includes('2026-10-21'), 'Wednesday holds sara');
  teamToggles(mount).find((node) => node.textContent.includes('sara')).dispatch('click');
  assert.ok(!texts(mount, 'strong').some((text) => /^piega\b/i.test(text)), 'sara is hidden');
  assert.ok(!compactDays().includes('2026-10-21'), 'a hidden booking still holds its day: no compact «Nessun appuntamento»');
  assert.deepEqual(compactDays(), ['2026-10-19', '2026-10-20', '2026-10-23'], 'truly empty days stay compact');
});

test('review #646 r3: a pager move during the search leaves its answer unpublished', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const base = stubClient({
    phrase: { teamMemberId: 'marco', durationMinutes: 30 },
    slots: [{ startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T13:30:00.000Z' }],
  });
  const client = {
    ...base,
    calls: base.calls,
    async request(path, options = {}) {
      if (path.startsWith('/api/appointments/suggest-slots')) await gate;
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await showWeek(mount);
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flushAll();
  mount.findAll('button').find((node) => node.textContent === '›').dispatch('click');
  await flushAll();
  release();
  await flushAll();
  assert.equal(mount.querySelector('.cal-slots'), null, 'no proposal of the old week lands on the new one');
  assert.ok(!mount.findAll('button').some((node) => (node.textContent ?? '').startsWith('✦ Proposta')), 'no ghost either');
});

// ---- Production verification 07/11 (supervisor/difetti-agenda) ----

const flushMany = async (n = 9) => {
  for (let round = 0; round < n; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const manualButton = (mount, label) => mount.querySelector('.cal-manual').findAll('button')
  .find((node) => node.textContent === label);

// e) After «booked» the form read «Bozza pronta: premi Conferma…» and the
// phrase card kept its draft: a booking is a done state.
test('a booked Conferma clears every draft and shows «Prenotato» with the week reloaded', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    phrase: { teamMemberId: 'marco', serviceKey: 'taglio', startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' },
    slots: [{ startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' }],
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  byName().members.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await flushMany();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco giovedì alle 18';
  clickButton(mount, 'Trova slot liberi');
  await flushMany();
  await pickCustomerByName(mount, 'Ada');
  byName().price.value = '45.00';
  manualButton(mount, 'Proponi').dispatch('click');
  await flushMany();
  assert.ok(mount.textContent.includes('Bozza pronta: premi «Conferma»'), 'propose answers a draft first');
  const weekReads = client.calls.filter((call) => call.path.startsWith('/api/appointments/team-week')).length;
  manualButton(mount, 'Conferma').dispatch('click');
  await flushMany();
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 1);
  assert.ok(!mount.textContent.includes('Bozza'), 'no draft line survives the booking');
  const booked = mount.findAll('p').find((node) => node.getAttribute('data-role') === 'booked');
  assert.ok(booked, 'the done state paints');
  assert.equal(booked.textContent, 'Prenotato: marco · 22 ott 18:00.');
  assert.equal(mount.querySelector('.cal-slots'), null, 'the proposals are gone');
  assert.equal(byName().serviceKey.value, '', 'the form is cleared for the next booking');
  assert.ok(
    client.calls.filter((call) => call.path.startsWith('/api/appointments/team-week')).length > weekReads,
    'the week reloads so the new event paints',
  );
});

// f) A typed service the listino does not know: the pilot answers 400
// BO_APPOINTMENT_SERVICE_REFUSED; the operator read «Riprova più tardi».
test('a service outside the listino is named under the field, never «Riprova più tardi»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const refused = Object.assign(new Error('Calendar change refused'), { status: 400, code: 'BO_APPOINTMENT_SERVICE_REFUSED' });
  const client = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]), failConfirmWith: refused });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
  form.teamMemberId.value = 'marco';
  form.serviceKey.value = 'massaggio speciale';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  manualButton(mount, 'Conferma').dispatch('click');
  await flushMany();
  const hint = mount.findAll('small').find((node) => node.getAttribute('data-role') === 'service-error');
  assert.ok(hint, 'the refusal sits under the service field');
  assert.ok(hint.textContent.startsWith('Scegli un servizio dal listino'), hint.textContent);
  assert.equal(byName().serviceKey.getAttribute('aria-invalid'), 'true');
  assert.ok(!mount.textContent.includes('Riprova più tardi'), 'no generic retry for a refusal with a cause');
  assert.ok(!mount.textContent.includes('Calendar change refused'), 'no English server message');
  assert.equal(byName().serviceKey.value, 'massaggio speciale', 'the typed value stays to correct');
});

test('serviceKeyFor sends the listino key for a typed catalog name, the text otherwise', () => {
  const names = new Map([['lezione-prova', 'Lezione prova'], ['taglio', 'Taglio']]);
  assert.equal(serviceKeyFor('Lezione prova', names), 'lezione-prova');
  assert.equal(serviceKeyFor('  taglio ', names), 'taglio');
  assert.equal(serviceKeyFor('Massaggio', names), 'Massaggio', 'an unknown name goes as typed, the server refuses it');
  assert.equal(serviceKeyFor('Taglio', null), 'Taglio', 'no catalog read: unchanged');
  assert.ok(calendarRefusalText({ code: 'VALIDATION_ERROR', details: { field: 'serviceKey' } }).startsWith('Scegli un servizio dal listino'),
    'the framework validation on the field reads the same');
  assert.equal(calendarRefusalText({ code: 'BO_APPOINTMENT_CONFIRM_REFUSED' }), null, 'other refusals keep their generic sentence');
});

// i) «Fissa con una frase» with the AI off read «Ricerca non riuscita».
for (const code of ['LLM_SPACE_DISABLED', 'LLM_SECRET_UNAVAILABLE']) {
  test(`AI off (${code}) points at the manual form and disables the phrase box`, async () => {
    const doc = createFakeDocument();
    const mount = createMount();
    const client = stubClient({ failPhraseWith: Object.assign(new Error('Calendar phrase refused'), { status: 502, code }) });
    const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
    await view.render();
    mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco';
    clickButton(mount, 'Trova slot liberi');
    await flushMany();
    assert.ok(texts(mount, 'p').includes('L’AI è spenta in questo spazio: usa il modulo qui sotto.'));
    assert.ok(!mount.textContent.includes('Ricerca non riuscita'));
    assert.equal(mount.querySelector('textarea[name="phrase"]').getAttribute('disabled'), 'true', 'the phrase box is off');
    const find = mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi');
    assert.equal(find.getAttribute('disabled'), 'true', 'the search button is off');
  });
}

// j) «trova 45 minuti con Daniele giovedì» drafted «12 nov 00:00–00:30»
// and the slots started on Monday.
test('a day-only phrase searches that day for the stated minutes and never paints 00:00', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    // Rome midnight of Thursday 22 Oct (CEST): the model's answer for «giovedì».
    phrase: { teamMemberId: 'marco', startsAt: '2026-10-21T22:00:00.000Z', endsAt: '2026-10-21T22:30:00.000Z', durationMinutes: 45 },
    slots: [
      { startsAt: '2026-10-21T07:00:00.000Z', endsAt: '2026-10-21T07:45:00.000Z' },
      { startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:45:00.000Z' },
    ],
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-20T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco giovedì';
  clickButton(mount, 'Trova slot liberi');
  await flushMany();
  const suggest = client.calls.find((call) => call.path.startsWith('/api/appointments/suggest-slots'));
  assert.ok(suggest.path.includes('slotMinutes=45'), 'the stated minutes, not the padded 30');
  assert.ok(suggest.path.includes('from=2026-10-21T22'), 'the search starts on the named day');
  assert.ok(suggest.path.includes('to=2026-10-23T02'), 'and ends with it');
  const draftLine = mount.querySelector('.cal-draft').textContent;
  assert.ok(draftLine.includes('gio 22 ott · orario da scegliere · 45 minuti'), draftLine);
  assert.ok(!mount.querySelector('.cal-rail').textContent.includes('00:00'), 'no midnight hour anywhere in the rail');
  const rows = mount.querySelector('.cal-slots').findAll('span').map((node) => node.textContent);
  assert.deepEqual(rows, ['22 ott · 10:00–10:45'], 'only the named day is proposed');
  const field = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  assert.equal(field('date').value, '2026-10-22', 'the day prefills');
  assert.equal(field('start').value, '', 'the hour stays to choose');
  assert.equal(field('end').value, '', 'the end stays to choose');
});

test('draft helpers: a midnight start is a day, not a time', () => {
  const dayOnly = { startsAt: '2026-11-11T23:00:00.000Z', endsAt: '2026-11-11T23:30:00.000Z', durationMinutes: 45 };
  assert.equal(draftDayOnly(dayOnly), true);
  assert.equal(draftDayKey(dayOnly), '2026-11-12');
  assert.equal(draftMinutes(dayOnly), 45, 'the stated minutes win over the padded end');
  assert.equal(draftWhen(dayOnly), 'gio 12 nov · orario da scegliere · 45 minuti');
  const timed = { startsAt: '2026-11-12T09:00:00.000Z', endsAt: '2026-11-12T09:45:00.000Z' };
  assert.equal(draftDayOnly(timed), false);
  assert.equal(draftWhen(timed), '12 nov 10:00–10:45');
  assert.equal(draftWhen({ durationMinutes: 45 }), '45 minuti', 'no day: the minutes only');
  assert.equal(draftDayKey({ durationMinutes: 45 }), null);
});

// e) The pilot confirm can poll for ~50 s: the form never keeps «Bozza
// pronta: premi «Conferma»» on screen while Conferma is in flight.
test('Conferma in flight replaces the draft note with «Prenotazione in corso…»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const base = stubClient({ customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]) });
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (path === '/api/appointments/confirm') {
        base.calls.push({ path, method: options.method ?? 'GET', body: options.body });
        return new Promise(() => {}); // the queue never answers
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
  form.teamMemberId.value = 'marco';
  form.serviceKey.value = 'taglio';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  manualButton(mount, 'Proponi').dispatch('click');
  await flushMany();
  assert.ok(mount.querySelector('.cal-manual').textContent.includes('Bozza pronta'), 'propose answers a draft first');
  manualButton(mount, 'Conferma').dispatch('click');
  await flushMany();
  const panel = mount.querySelector('.cal-manual').textContent;
  assert.ok(panel.includes('Prenotazione in corso…'), panel);
  assert.ok(!panel.includes('Bozza'), 'the stale draft note is gone while Conferma runs');
});

test('AI off is remembered for its own space only', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let space = 'space-a';
  const kept = new Map();
  const storage = {
    getItem: (key) => (key === 'accordo.activeSpace' ? space : kept.get(key) ?? null),
    setItem: (key, value) => { kept.set(key, String(value)); },
    removeItem: (key) => { kept.delete(key); },
  };
  const client = stubClient({ failPhraseWith: Object.assign(new Error('Calendar phrase refused'), { status: 502, code: 'LLM_SPACE_DISABLED' }) });
  const view = createCalendarioView({ doc, mount, client, storage, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flushMany();
  assert.equal(mount.querySelector('textarea[name="phrase"]').getAttribute('disabled'), 'true', 'off in space A');
  space = 'space-b';
  await view.render();
  assert.equal(mount.querySelector('textarea[name="phrase"]').getAttribute('disabled'), null, 'space B keeps its phrase box');
});

// Review #657 P1: a phrase naming a day outside the shown week moved the
// grid and nulled the week before the held-overlap guard ran, so a booked
// step in that week was proposed on top of its booking.
test('a cross-week phrase never proposes a step held in the named week', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const nextWeek = {
    from: '2026-10-26T00:00:00.000Z',
    to: '2026-11-02T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'n1', status: 'booked', teamMemberId: 'marco', serviceKey: 'taglio',
        startsAt: '2026-10-29T09:00:00.000Z', endsAt: '2026-10-29T09:45:00.000Z',
        subject: { resource: 'contact', id: 'c1', owner: 'host', label: 'Ada' },
      }],
    }],
  };
  const base = stubClient({
    phrase: { teamMemberId: 'marco', startsAt: '2026-10-29T10:00:00.000Z', endsAt: '2026-10-29T10:45:00.000Z' },
    slots: [
      { startsAt: '2026-10-29T09:00:00.000Z', endsAt: '2026-10-29T09:45:00.000Z' },
      { startsAt: '2026-10-29T13:00:00.000Z', endsAt: '2026-10-29T13:45:00.000Z' },
    ],
  });
  const client = {
    calls: base.calls,
    async request(path, options = {}) {
      if (path.startsWith('/api/appointments/team-week') && path.includes('from=2026-10-2') && !path.includes('from=2026-10-18')) {
        base.calls.push({ path, method: 'GET' });
        await new Promise((resolve) => setImmediate(resolve)); // the week answers after a beat
        return nextWeek;
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  byName().members.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await flushMany();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco giovedì prossimo';
  clickButton(mount, 'Trova slot liberi');
  await flushMany(14);
  const rows = mount.querySelector('.cal-slots').findAll('span').map((node) => node.textContent);
  assert.deepEqual(rows, ['29 ott · 14:00–14:45'], 'the step booked at 10:00 Rome is not proposed');
});

// Review #657 P2: the slot/ghost Conferma kept «Bozza pronta» on screen
// while the pilot queue held the write.
test('a proposal Conferma in flight says «Prenotazione in corso…», never the stale draft note', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const base = stubClient({
    phrase: { teamMemberId: 'marco', serviceKey: 'taglio', startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' },
    slots: [{ startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' }],
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
  });
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (path === '/api/appointments/confirm') return new Promise(() => {}); // the queue never answers
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flushMany();
  await pickCustomerByName(mount, 'Ada');
  assert.ok(mount.querySelector('.cal-ai').textContent.includes('Bozza pronta'), 'the draft note shows first');
  mount.querySelector('.cal-slots').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await flushMany();
  const card = mount.querySelector('.cal-ai').textContent;
  assert.ok(card.includes('Prenotazione in corso…'), card);
  assert.ok(!card.includes('Bozza pronta'), 'the stale draft note is gone while Conferma runs');
});

// Review #657 (second round) P1: with nobody named the moved week was never
// loaded and the held-overlap guard ran against nothing.
const NEXT_WEEK_HELD = {
  from: '2026-10-26T00:00:00.000Z',
  to: '2026-11-02T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [{
      id: 'n1', status: 'booked', teamMemberId: 'marco', serviceKey: 'taglio',
      startsAt: '2026-10-29T09:00:00.000Z', endsAt: '2026-10-29T09:45:00.000Z',
      subject: { resource: 'contact', id: 'c1', owner: 'host', label: 'Ada' },
    }],
  }],
};
const crossWeekClient = (weekAnswer) => {
  const base = stubClient({
    phrase: { teamMemberId: 'marco', startsAt: '2026-10-29T10:00:00.000Z', endsAt: '2026-10-29T10:45:00.000Z' },
    slots: [
      { startsAt: '2026-10-29T09:00:00.000Z', endsAt: '2026-10-29T09:45:00.000Z' },
      { startsAt: '2026-10-29T13:00:00.000Z', endsAt: '2026-10-29T13:45:00.000Z' },
    ],
  });
  return {
    calls: base.calls,
    async request(path, options = {}) {
      if (path.startsWith('/api/appointments/team-week')) {
        base.calls.push({ path, method: 'GET' });
        return weekAnswer();
      }
      return base.request(path, options);
    },
  };
};

test('a cross-week phrase with nobody named still guards the held bookings', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = crossWeekClient(() => NEXT_WEEK_HELD);
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco giovedì prossimo';
  clickButton(mount, 'Trova slot liberi');
  await flushMany(14);
  const read = client.calls.find((call) => call.path.startsWith('/api/appointments/team-week'));
  assert.ok(read && read.path.includes('teamMemberIds=marco'), 'the searched person week is read for the guard');
  const rows = mount.querySelector('.cal-slots').findAll('span').map((node) => node.textContent);
  assert.deepEqual(rows, ['29 ott · 14:00–14:45'], 'the step booked at 10:00 Rome is not proposed');
});

test('a cross-week phrase whose week cannot be read proposes nothing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = crossWeekClient(() => { throw Object.assign(new Error('down'), { status: 502, code: 'UNKNOWN' }); });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco giovedì prossimo';
  clickButton(mount, 'Trova slot liberi');
  await flushMany(14);
  assert.equal(mount.querySelector('.cal-slots'), null, 'fail closed: no proposal against unknown bookings');
  assert.ok(texts(mount, 'p').includes('Non riesco a leggere gli appuntamenti di quella settimana: riprova tra poco.'));
});

// Review #657 (second round) P2: an unavailable AI backend is not «AI off in
// this space» — the phrase box stays usable for a retry.
test('APPOINTMENTS_AI_UNAVAILABLE keeps the phrase box and never says the AI is off', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ failPhraseWith: Object.assign(new Error('unavailable'), { status: 503, code: 'APPOINTMENTS_AI_UNAVAILABLE' }) });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flushMany();
  assert.ok(!mount.textContent.includes('L’AI è spenta'), 'a transient outage is not a space switch');
  assert.equal(mount.querySelector('textarea[name="phrase"]').getAttribute('disabled'), null, 'the phrase box stays usable');
  assert.equal(calendarRefusalText({ code: 'APPOINTMENTS_AI_UNAVAILABLE' }), null);
});

// Review #657 gap: with nobody named, a phrase day inside the shown week
// had no loaded week either, and the guard ran against nothing.
test('a same-week phrase with nobody named still guards the held bookings', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    phrase: { teamMemberId: 'marco', startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' },
    // WEEK holds marco 16:00–16:30Z on 22 Oct: that step is never proposed.
    slots: [
      { startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' },
      { startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T13:30:00.000Z' },
    ],
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco giovedì';
  clickButton(mount, 'Trova slot liberi');
  await flushMany(14);
  const read = client.calls.find((call) => call.path.startsWith('/api/appointments/team-week'));
  assert.ok(read && read.path.includes('teamMemberIds=marco'), 'the searched person week is read for the guard');
  const rows = mount.querySelector('.cal-slots').findAll('span').map((node) => node.textContent);
  assert.deepEqual(rows, ['22 ott · 15:00–15:30'], 'the held 18:00 Rome step is not proposed');
});

test('a same-week phrase whose week cannot be read proposes nothing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const base = stubClient({
    phrase: { teamMemberId: 'marco', startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' },
    slots: [{ startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T13:30:00.000Z' }],
  });
  const client = {
    calls: base.calls,
    async request(path, options = {}) {
      if (path.startsWith('/api/appointments/team-week')) throw Object.assign(new Error('down'), { status: 502, code: 'UNKNOWN' });
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco giovedì';
  clickButton(mount, 'Trova slot liberi');
  await flushMany(14);
  assert.equal(mount.querySelector('.cal-slots'), null, 'fail closed: no proposal against unknown bookings');
  assert.ok(texts(mount, 'p').includes('Non riesco a leggere gli appuntamenti di quella settimana: riprova tra poco.'));
});

test('weekCovers trusts a loaded week only when it lists every searched identity', () => {
  const week = { members: [{ teamMemberId: 'marco', appointments: [] }] };
  assert.equal(weekCovers(week, ['marco']), true);
  assert.equal(weekCovers(week, ['marco', 'google|g1']), false, 'a missing sibling identity is not covered');
  assert.equal(weekCovers(null, ['marco']), false);
  assert.equal(weekCovers(week, []), false);
});

// Review #657 round 4 P2: a Conferma racing the first catalog read sent the
// raw product name and was refused.
test('a typed catalog name books its listino key even before the catalog was read', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    customers: customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }]),
    catalog: { products: [{ sku: 'lezione-prova', name: 'Lezione prova' }] },
  });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-23T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  await pickCustomerByName(mount, 'Ada');
  const form = byName();
  form.teamMemberId.value = 'marco';
  form.serviceKey.value = 'Lezione prova';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  manualButton(mount, 'Conferma').dispatch('click');
  await flushMany();
  const confirm = client.calls.find((call) => call.path === '/api/appointments/confirm');
  assert.ok(confirm, 'the booking is sent');
  assert.equal(payload(confirm).serviceKey, 'lezione-prova', 'the catalog name resolves to its key');
});

// Review #657 round 4 P2: AI off is remembered for every space that said so.
test('AI off stays remembered for each space, not only the last one', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let space = 'space-a';
  const kept = new Map();
  const storage = {
    getItem: (key) => (key === 'accordo.activeSpace' ? space : kept.get(key) ?? null),
    setItem: (key, value) => { kept.set(key, String(value)); },
    removeItem: (key) => { kept.delete(key); },
  };
  const client = stubClient({ failPhraseWith: Object.assign(new Error('Calendar phrase refused'), { status: 502, code: 'LLM_SPACE_DISABLED' }) });
  const view = createCalendarioView({ doc, mount, client, storage, now: () => new Date('2026-10-23T06:00:00Z') });
  const refuse = async () => {
    mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco';
    clickButton(mount, 'Trova slot liberi');
    await flushMany();
  };
  await view.render();
  await refuse();
  space = 'space-b';
  await view.render();
  await refuse();
  space = 'space-a';
  await view.render();
  assert.equal(mount.querySelector('textarea[name="phrase"]').getAttribute('disabled'), 'true', 'space A is still off');
});

// Review #657 round 5 P1: a pager move while the named week preloads made
// the held guard read the paged week and propose a held step.
test('a pager move during the cross-week preload never proposes against the wrong week', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const namedWeek = {
    from: '2026-10-26T00:00:00.000Z',
    to: '2026-11-02T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'n1', status: 'booked', teamMemberId: 'marco', serviceKey: 'taglio',
        startsAt: '2026-10-29T09:00:00.000Z', endsAt: '2026-10-29T09:45:00.000Z',
        subject: { resource: 'contact', id: 'c1', owner: 'host', label: 'Ada' },
      }],
    }],
  };
  const pagedWeek = { from: '2026-11-02T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z', members: [{ teamMemberId: 'marco', appointments: [] }] };
  const base = stubClient({
    phrase: { teamMemberId: 'marco', startsAt: '2026-10-29T10:00:00.000Z', endsAt: '2026-10-29T10:45:00.000Z' },
    slots: [
      { startsAt: '2026-10-29T09:00:00.000Z', endsAt: '2026-10-29T09:45:00.000Z' },
      { startsAt: '2026-10-29T13:00:00.000Z', endsAt: '2026-10-29T13:45:00.000Z' },
    ],
  });
  let holdNamed = false;
  let releaseNamed = () => {};
  const client = {
    calls: base.calls,
    async request(path, options = {}) {
      if (path.startsWith('/api/appointments/team-week') && holdNamed) {
        holdNamed = false;
        base.calls.push({ path, method: 'GET' });
        await new Promise((resolve) => { releaseNamed = resolve; });
        return namedWeek;
      }
      if (path.startsWith('/api/appointments/team-week') && path.includes('2026-11-0')) {
        base.calls.push({ path, method: 'GET' });
        return pagedWeek;
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  byName().members.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await flushMany();
  holdNamed = true;
  mount.querySelector('textarea[name="phrase"]').value = 'trova 45 minuti con marco giovedì prossimo';
  clickButton(mount, 'Trova slot liberi');
  await flushMany();
  // The operator pages forward while the named week is still loading.
  mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Settimana dopo').dispatch('click');
  await flushMany();
  releaseNamed();
  await flushMany(14);
  const rows = (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);
  assert.ok(!rows.includes('29 ott · 10:00–10:45'), `the held 10:00 Rome step is never proposed (${rows.join(' | ')})`);
});
