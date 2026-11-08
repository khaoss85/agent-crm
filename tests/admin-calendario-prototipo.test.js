// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCalendarioView, originOf, slotLabel } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:29bb3f2c0d64 — the Calendar against the «Accordo Backoffice»
 * prototype («07 Calendario»), four points: (a) the channel pill on the
 * blocks and the «↔ Google Calendar» line in the detail card, (b) the
 * title at the prototype size like the other /bo screens, (c) proposed
 * slots name the weekday, (d) a space with no people still shows the grid.
 */

const NOW = new Date('2026-10-21T08:40:00Z');

function row(id, sourceKey, startsAt, endsAt, extra = {}) {
  return {
    id, status: 'booked', startsAt, endsAt, serviceKey: 'taglio', teamMemberId: 'marco',
    priceCents: 3000, currency: 'EUR', notes: null, sourceKey,
    subject: { resource: 'contact', id: `c-${id}`, owner: 'host', ownerPackage: null },
    ...extra,
  };
}

const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [
      row('g1', 'gcal:team@example.test:evt1', '2026-10-22T08:00:00.000Z', '2026-10-22T08:30:00.000Z'),
      row('l1', 'booking-link:tok:2026-10-22T10:00:00.000Z', '2026-10-22T10:00:00.000Z', '2026-10-22T10:30:00.000Z'),
      row('h1', 'calendario:marco:2026-10-22T12:00:00.000Z:c-h1', '2026-10-22T12:00:00.000Z', '2026-10-22T12:30:00.000Z'),
    ],
  }],
};

function client({ roster = [{ subject: 'marco', displayName: 'Marco Ferri' }], week = WEEK, calendar = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path === '/api/spine/memberships') return { items: roster };
      if (path === '/api/profile') {
        if (calendar === null) return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
        return { member: null, connections: { available: true, items: [{ connector: 'calendar', status: calendar }] } };
      }
      if (path.startsWith('/api/appointments/team-week')) return week;
      if (path.startsWith('/api/catalog/products')) return { products: [{ sku: 'taglio', name: 'Taglio' }] };
      if (path.startsWith('/api/customer-data/profile/')) {
        const error = new Error('no profile');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function open(options) {
  const doc = createFakeDocument();
  const mount = createMount();
  const api = client(options);
  const view = createCalendarioView({ doc, mount, client: api, now: () => NOW });
  await view.render();
  await settle();
  return { mount, api };
}

function blockOf(mount, startLabel) {
  return mount.findAll('button').find((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-event')
    && node.textContent.startsWith(startLabel));
}

function classed(node, cls) {
  return node.findAll('span').filter((child) => (child.getAttribute('class') ?? '').split(' ').includes(cls));
}

test('29bb3f2c0d64 (a): originOf reads only what the row proves', () => {
  assert.equal(originOf({ channel: 'whatsapp', sourceKey: 'calendario:x' }), 'whatsapp', 'the WA marker wins');
  assert.equal(originOf({ sourceKey: 'gcal:cal:evt' }), 'google');
  assert.equal(originOf({ sourceKey: 'gcal:cal:evt:r2' }), 'google', 'a rescheduled import is still Google');
  assert.equal(originOf({ sourceKey: 'booking-link:tok:2026' }), 'link');
  assert.equal(originOf({ sourceKey: 'calendario:marco:2026:c1' }), 'calendario');
  assert.equal(originOf({ sourceKey: 'k1' }), null, 'an unknown key is no origin');
  assert.equal(originOf({}), null);
  assert.equal(originOf(null), null);
});

test('29bb3f2c0d64 (a): blocks carry the channel pill of their origin', async () => {
  const { mount } = await open();
  const google = blockOf(mount, '10:00');
  const link = blockOf(mount, '12:00');
  const here = blockOf(mount, '14:00');
  assert.ok(google && link && here, 'the three blocks paint');
  const gPill = classed(google, 'cal-pill-google');
  assert.equal(gPill.length, 1, 'the Google-imported block carries its pill');
  assert.equal(gPill[0].textContent, '↔ Google');
  const lPill = classed(link, 'cal-pill-link');
  assert.equal(lPill.length, 1, 'the online-link block carries its pill');
  assert.equal(lPill[0].textContent, 'Link');
  assert.equal(classed(here, 'cal-pill').length, 0, 'a booking made here carries no pill, like the prototype');
  assert.equal(classed(here, 'cal-wa').length, 0);
});

test('29bb3f2c0d64 (a): the detail card shows the origin pill and «↔ Google Calendar» only for an imported event', async () => {
  const { mount } = await open({ calendar: 'connected' });
  blockOf(mount, '10:00').dispatch('click');
  await settle();
  let card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card, 'the card opens');
  assert.ok(card.textContent.includes('Arrivato da Google Calendar'), card.textContent);
  const sync = card.findAll('p').find((node) => node.getAttribute('data-role') === 'event-sync');
  assert.ok(sync, 'the sync line paints');
  assert.equal(sync.textContent, '↔ Google Calendar · evento importato dal calendario collegato');

  blockOf(mount, '14:00').dispatch('click');
  await settle();
  card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card.textContent.includes('Fissato dal calendario'), card.textContent);
  assert.ok(!card.textContent.includes('Google Calendar'), 'no sync claim on a booking made here');
  assert.ok(!card.textContent.includes("Fissato con l'AI"), 'never an AI claim the row cannot prove');

  blockOf(mount, '12:00').dispatch('click');
  await settle();
  card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card.textContent.includes('Prenotato dal cliente con il link online'), card.textContent);
  assert.ok(!card.textContent.includes('Google Calendar'));
});

test('29bb3f2c0d64 (a): a disconnected calendar says so on an imported event', async () => {
  const { mount } = await open({ calendar: 'revoked' });
  blockOf(mount, '10:00').dispatch('click');
  await settle();
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  const sync = card.findAll('p').find((node) => node.getAttribute('data-role') === 'event-sync');
  assert.equal(sync.textContent, '↔ Google Calendar · non più collegato: ricollegalo dal Profilo');
});

test('review #678: with the calendar state unknown the Google line names only the origin', async () => {
  // calendar null: the profile is not composed here, so nothing proves
  // the calendar is connected — never «collegato» without proof.
  const { mount } = await open({ calendar: null });
  blockOf(mount, '10:00').dispatch('click');
  await settle();
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  const sync = card.findAll('p').find((node) => node.getAttribute('data-role') === 'event-sync');
  assert.equal(sync.textContent, '↔ Google Calendar · evento importato da Google Calendar');
  assert.ok(!sync.textContent.includes('collegato'), 'no connection claim without proof');
});

test('29bb3f2c0d64 (b): the title uses the prototype size of the other /bo screens', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const rule = css.split('\n').find((line) => line.startsWith('.cal-wrap .panel-heading h2 {'));
  assert.ok(rule, 'the calendar title rule exists');
  assert.match(rule, /font-size: clamp\(32px, 4vw, 46px\)/, rule);
  assert.doesNotMatch(rule, /50px/, 'never the 50px title');
  const clienti = css.split('\n').find((line) => line.startsWith('.bo-clienti-title {'));
  assert.match(clienti, /clamp\(32px, 4vw, 46px\)/, 'the same size as Clienti');
});

test('29bb3f2c0d64 (c): a proposed slot names the weekday', () => {
  assert.equal(slotLabel({ startsAt: '2026-11-12T09:00:00.000Z', endsAt: '2026-11-12T09:45:00.000Z' }), 'gio 12 nov · 10:00–10:45');
  assert.equal(slotLabel({ startsAt: '2026-10-19T14:00:00.000Z', endsAt: '2026-10-19T14:30:00.000Z' }), 'lun 19 ott · 16:00–16:30');
});

test('29bb3f2c0d64 (d): a space with no people still shows the empty grid with its empty state', async () => {
  const { mount, api } = await open({ roster: [] });
  const grid = mount.querySelector('.cal-grid');
  assert.ok(grid, 'the week grid paints with nobody in the space');
  const days = grid.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'));
  assert.equal(days.length, 5, 'five empty work-day columns');
  const hours = grid.findAll('div').filter((node) => node.getAttribute('class') === 'cal-hour');
  assert.equal(hours.length, 10, 'the 09:00–18:00 hour gutter');
  const line = mount.querySelector('.cal-week-empty');
  assert.ok(line, 'one honest line above the grid');
  assert.match(line.textContent, /nessuna persona/);
  assert.ok(!api.calls.some((path) => path.startsWith('/api/appointments/team-week')), 'no week is read for nobody');
});

test('29bb3f2c0d64 (d): with the roster unread the grid paints under the naming prompt', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    doc,
    mount,
    client: {
      async request(path, options = {}) {
        enforceAdminWriteGate(path, options);
        const error = new Error('absent');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      },
    },
    now: () => NOW,
  });
  await view.render();
  await settle();
  assert.ok(mount.querySelector('.cal-grid'), 'the grid paints');
  assert.match(mount.querySelector('.cal-week-empty').textContent, /Mostra settimana/);
});
