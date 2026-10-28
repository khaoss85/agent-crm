// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarioView,
  parseMemberFilter,
  romeWeekKeys,
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

function stubClient({ week = WEEK, slots = [], phrase = null, failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (failWith) throw failWith;
      if (path === '/api/appointments/propose' || path === '/api/appointments/confirm') {
        const body = payload({ body: options.body });
        if (path === '/api/appointments/propose') {
          return { decision: 'confirm-required', draft: body, spaceId: 'locale', permission: 'book-appointments' };
        }
        return { decision: 'booked', appointment: { ...body, id: 'b1', status: 'confirmed' }, replayed: false, spaceId: 'locale' };
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

test('week renders seven day columns with real Rome-time events', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  // No members named yet: the honest prompt, not a blank screen.
  assert.ok(texts(mount, 'p').some((text) => text.includes('Scegli le persone')));
  assert.equal(client.calls.length, 0);

  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const days = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'));
  assert.equal(days.length, 7);
  // Thursday 22 Oct 18:00 Rome (16:00Z in summer).
  assert.ok(texts(mount, 'span').some((text) => text === '18:00–18:30'));
  assert.ok(texts(mount, 'strong').includes('taglio'));
  // Cancelled rows stay listed with their status.
  assert.ok(texts(mount, 'span').includes('cancelled'));
  // Customer link points at the scheda, never at a raw id.
  const links = mount.findAll('a').map((node) => node.getAttribute('href'));
  assert.ok(links.includes('#/customer-card/contact/c1'));
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
  // honestly shows seven empty days — never the "name someone" prompt.
  const days = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'));
  assert.equal(days.length, 7);
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

test('phrase drafts into the manual form with the interpreted date and time', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const draft = {
    teamMemberId: 'marco',
    serviceKey: 'taglio',
    startsAt: '2026-10-22T16:00:00.000Z',
    endsAt: '2026-10-22T16:30:00.000Z',
    notes: 'taglio per Ada',
  };
  const client = stubClient({ phrase: draft });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const phraseInput = mount.findAll('input').find((node) => node.getAttribute('name') === 'phrase');
  phraseInput.value = 'giovedì alle 18 con marco per il taglio';
  clickButton(mount, 'Interpreta');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const propose = client.calls.find((call) => call.path === '/api/appointments/phrase');
  assert.equal(payload(propose).phrase, 'giovedì alle 18 con marco per il taglio');
  assert.ok(texts(mount, 'p').some((text) => text.includes('Bozza: marco')));
  // The draft prefills the manual form (Rome wall time back into the inputs).
  const byName = Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  assert.equal(byName.teamMemberId.value, 'marco');
  assert.equal(byName.serviceKey.value, 'taglio');
  assert.equal(byName.date.value, '2026-10-22');
  assert.equal(byName.start.value, '18:00');
  assert.equal(byName.end.value, '18:30');
});

test('slot search lists free slots and one click fills the form', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const slots = [{ startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T16:30:00.000Z' }];
  const client = stubClient({ slots });
  const view = createCalendarioView({ doc, mount, client, now: () => new Date('2026-10-25T10:00:00Z') });
  await view.render();
  const byName = () => Object.fromEntries(mount.findAll('input').map((node) => [node.getAttribute('name'), node]));
  byName().slotMember.value = 'marco';
  byName().slotDay.value = '2026-10-22';
  clickButton(mount, 'Trova slot');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const suggest = client.calls.find((call) => call.path.startsWith('/api/appointments/suggest-slots'));
  assert.ok(suggest.path.includes('teamMemberIds=marco'));
  const pick = mount.findAll('button').find((node) => node.textContent.includes('18:00'));
  assert.ok(pick, 'slot button shows the Rome time');
  pick.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const after = byName();
  assert.equal(after.teamMemberId.value, 'marco');
  assert.equal(after.date.value, '2026-10-22');
  assert.equal(after.start.value, '18:00');
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
  const order = ['‹', '19 ott – 25 ott 2026', '›', 'Oggi', 'Nuovo appuntamento'];
  let from = -1;
  for (const part of order) {
    const at = text.indexOf(part, from + 1);
    assert.ok(at > from, `C2: "${part}" comes after the previous control`);
    from = at;
  }
  // The interval is its own element with the spec pattern, not a button label.
  const interval = nav.querySelector('span[data-role="week-interval"]');
  assert.equal(interval?.textContent, '19 ott – 25 ott 2026', 'C2: interval pattern');
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
  const phrase = mount.querySelector('input[name="phrase"]');
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
