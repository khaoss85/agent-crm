// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bookingClaim,
  createCalendarioView,
  isMovableAppointment,
} from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Team visibility (backlog:9aa5c073) in the grid: a private booking of
 * someone else reads only as «Occupato» — the block, its card, never the
 * customer, the service or the notes. The «Nuovo appuntamento» form offers
 * «Predefinita / Pubblico / Privato», preselected on Predefinita (the team
 * default: everyone reads everything).
 */

const NOW = new Date('2026-10-21T08:40:00Z');

const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [{
      // How the server masks a private booking for a non-creator viewer:
      // the slot and the hold, nothing else.
      id: 'm1', status: 'booked', startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T18:00:00.000Z',
      teamMemberId: 'marco', visibility: 'private', masked: true,
    }],
  }],
};

function stubClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco Ferri' }] };
      if (path === '/api/profile') return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
      if (path.startsWith('/api/catalog/products')) return { products: [{ sku: 'taglio', name: 'Taglio' }] };
      if (path.startsWith('/api/appointments/services')) {
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (path.startsWith('/api/customer-data/')) {
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openCalendar() {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client: stubClient(), now: () => NOW });
  await view.render();
  await settle();
  return { mount };
}

function blockOf(mount, startLabel) {
  return mount.findAll('button').find((node) => {
    if (!(node.getAttribute('class') ?? '').split(' ').includes('cal-event')) return false;
    if (node.textContent.startsWith(startLabel)) return true;
    return node.findAll('span').some((child) => {
      const childClasses = (child.getAttribute('class') ?? '').split(' ');
      if (childClasses.includes('cal-compact')) return (child.textContent ?? '').endsWith(`, ${startLabel}`);
      if (childClasses.includes('cal-time')) return (child.textContent ?? '').startsWith(startLabel);
      return false;
    });
  });
}

test('9aa5c073: a masked block reads «Occupato» with the time, never the service', async () => {
  const { mount } = await openCalendar();
  const block = blockOf(mount, '19:00');
  assert.ok(block, 'the masked block paints');
  assert.ok(block.textContent.includes('Occupato'), block.textContent);
  assert.ok(!block.textContent.includes('Taglio'), 'no service name on a masked block');
  assert.equal(block.getAttribute('data-movable'), '0', 'a masked block never drags');
});

test('9aa5c073: the masked card reads «Occupato», the time and the person — nothing else', async () => {
  const { mount } = await openCalendar();
  blockOf(mount, '19:00').dispatch('click');
  await settle();
  const card = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(card, 'the card opens');
  assert.ok(card.textContent.includes('Occupato'), card.textContent);
  assert.ok(card.textContent.includes('Marco Ferri'), 'the team person still reads');
  assert.equal(
    card.findAll('p').filter((node) => node.getAttribute('data-role') === 'event-customer').length,
    0,
    'no customer line on a masked card',
  );
  assert.ok(!card.textContent.includes('Nota:'), 'no note on a masked card');
  assert.equal(
    card.findAll('button').filter((node) => node.getAttribute('data-action') === 'event-edit').length,
    0,
    'no edit on someone else’s private booking',
  );
  assert.equal(
    card.findAll('button').filter((node) => node.getAttribute('data-action') === 'event-cancel').length,
    0,
    'no cancellation on someone else’s private booking',
  );
});

test('9aa5c073: a masked row never moves', () => {
  assert.equal(isMovableAppointment({ status: 'booked', masked: true }), false);
  assert.equal(isMovableAppointment({ status: 'confirmed', masked: true }), false);
  assert.equal(isMovableAppointment({ status: 'booked' }), true);
});

test('9aa5c073: the manual form offers Predefinita / Pubblico / Privato, preselected on Predefinita', async () => {
  const { mount } = await openCalendar();
  mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento')).dispatch('click');
  mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente')).dispatch('click');
  const select = mount.findAll('input').concat(mount.findAll('select')).find((node) => node.getAttribute('name') === 'visibility');
  assert.ok(select, 'the visibility select paints');
  const options = select.findAll('option').map((node) => [node.getAttribute('value'), node.textContent]);
  assert.deepEqual(options, [['default', 'Predefinita'], ['public', 'Pubblico'], ['private', 'Privato']]);
  const picked = select.findAll('option').find((node) => node.getAttribute('selected') !== null);
  assert.equal(picked?.getAttribute('value'), 'default', 'preselected on Predefinita');
});

test('9aa5c073: bookingClaim carries the live visibility, absent when the form never painted one', () => {
  const base = {
    spaceId: 's', customer: { resource: 'contact', id: 'c1' }, teamMemberId: 'marco',
    serviceKey: 'taglio', priceCents: null, startsAt: '2026-10-22T17:00:00.000Z', endsAt: '2026-10-22T18:00:00.000Z',
    notes: null,
  };
  assert.equal(bookingClaim({ ...base, visibility: 'private' }).visibility, 'private');
  assert.equal(bookingClaim({ ...base, visibility: 'public' }).visibility, 'public');
  assert.equal(bookingClaim({ ...base, visibility: '' }).visibility, undefined);
  assert.equal(bookingClaim(base).visibility, undefined);
});
