// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView, memberInitials } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:667f1f1c — VERIFIER_BACK 2026-11-17 (returns: 1): «riga iniziali
 * (pallino 18px) a 42-60px in blocco 43px». Sotto i 60 minuti il piede
 * (pallino delle iniziali) non entra mai intero nel blocco: questa prova
 * fallisce sul codice che lo disegna e passa con la cura (piede solo dai
 * 60 minuti in su, distintivi in linea sulle righe che ci sono già).
 */

const NOW = new Date('2026-10-21T08:40:00Z');

function row(id, startsAt, endsAt, extra = {}) {
  return {
    id, status: 'booked', startsAt, endsAt, serviceKey: 'taglio', teamMemberId: 'marco',
    priceCents: 3000, currency: 'EUR', notes: null,
    sourceKey: `calendario:marco:2026-10-22T${id}:c-${id}`,
    subject: { resource: 'contact', id: `c-${id}`, owner: 'host', ownerPackage: null },
    ...extra,
  };
}

// Rome is UTC+2 here: 08:00Z reads 10:00 on the grid.
const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [
      row('s45', '2026-10-22T08:00:00.000Z', '2026-10-22T08:45:00.000Z'),
      row('s15', '2026-10-22T10:00:00.000Z', '2026-10-22T10:15:00.000Z'),
      row('s60', '2026-10-22T12:00:00.000Z', '2026-10-22T13:00:00.000Z'),
      row('g30', '2026-10-22T14:00:00.000Z', '2026-10-22T14:30:00.000Z', { sourceKey: 'gcal:cal:evt2' }),
      row('g45', '2026-10-22T15:00:00.000Z', '2026-10-22T15:45:00.000Z', { sourceKey: 'gcal:cal:evt3' }),
    ],
  }],
};

function client() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco Ferri' }] };
      if (path === '/api/profile') {
        const error = new Error('no profile');
        error.code = 'PROFILE_NOT_COMPOSED';
        error.status = 404;
        throw error;
      }
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
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

async function open() {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client: client(), now: () => NOW });
  await view.render();
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return mount.querySelector('.cal-week') ? mount : mount;
}

function blocks(mount) {
  return mount.findAll('button').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-event'));
}

function blockById(mount, id) {
  const found = blocks(mount).find((node) => node.getAttribute('data-event-id') === id);
  assert.ok(found, `the ${id} block paints`);
  return found;
}

function hasClass(node, cls) {
  return (node.getAttribute('class') ?? '').split(' ').includes(cls);
}

function descendants(node, cls) {
  return node.findAll('span').filter((child) => hasClass(child, cls));
}

test('667f1f1c: sotto i 60 minuti nessuna riga sotto il titolo (il pallino tagliato del verificatore)', () => {
  return open().then((mount) => {
    for (const id of ['s45', 's15']) {
      const block = blockById(mount, id);
      assert.equal(descendants(block, 'cal-day-foot').length, 0, `${id}: no foot row paints below the title`);
      assert.equal(descendants(block, 'cal-avatar').length, 0, `${id}: no initials dot paints half-cut`);
    }
  });
});

test('667f1f1c: dai 60 minuti il pallino resta (la tinta da sola non basta sul blocco lungo)', () => {
  return open().then((mount) => {
    const block = blockById(mount, 's60');
    assert.equal(descendants(block, 'cal-avatar').length, 1, 's60: the initials dot still paints');
    assert.equal(descendants(block, 'cal-avatar')[0].textContent, memberInitials('Marco Ferri'), 's60: initials come from the member, never the id');
  });
});

test('667f1f1c: sotto i 60 minuti i distintivi restano in linea (origine sempre leggibile)', () => {
  return open().then((mount) => {
    const google = blockById(mount, 'g30');
    assert.equal(descendants(google, 'cal-pill-google').length, 1, 'g30: the Google pill stays readable');
    assert.equal(descendants(google, 'cal-day-foot').length, 0, 'g30: but never on a row of its own');
    const google45 = blockById(mount, 'g45');
    assert.equal(descendants(google45, 'cal-pill-google').length, 1, 'g45: the Google pill stays readable');
    assert.equal(descendants(google45, 'cal-day-foot').length, 0, 'g45: but never on a row of its own');
    assert.equal(descendants(google45, 'cal-avatar').length, 0, 'g45: no initials dot either');
  });
});
