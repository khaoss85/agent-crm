// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * lot lot-apps-admin-public-799ceeb1, item 1e3393038b8b (d): nel form «Nuovo
 * appuntamento» il blocco della nota sta sempre subito dopo il campo Fine
 * (niente salto quando il testo appare), «Mancano dei dati» resta finché un
 * edit non lo cancella, e la Conferma di uno slot vi scrive i dati mancanti.
 */

const MEMBERSHIPS = [
  { subject: 'marco', role: 'operator', displayName: 'Marco' },
];

const DRAFT = {
  teamMemberId: 'marco',
  startsAt: '2026-10-22T08:00:00.000Z',
  endsAt: '2026-10-22T08:30:00.000Z',
};

const SLOT = { startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:30:00.000Z' };

const SERVED = {
  services: [
    { serviceKey: 'taglio', name: 'Taglio', priceCents: 4500, currency: 'EUR' },
    { serviceKey: 'barba', name: 'Barba', priceCents: 2000, currency: 'EUR' },
  ],
};

function stubClient() {
  const notFound = () => {
    const error = new Error('not composed');
    error.code = 'NOT_FOUND';
    error.status = 404;
    return error;
  };
  return {
    calls: [],
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      this.calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/appointments/services') return SERVED;
      if (path === '/api/spine/memberships') return { items: MEMBERSHIPS };
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots: [SLOT] }] };
      }
      if (path === '/api/appointments/phrase' && (options.method ?? 'GET') === 'POST') {
        return { draft: { ...DRAFT }, dryRun: false, spaceId: 'locale' };
      }
      throw notFound();
    },
  };
}

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

const formPops = (mount) => mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'manual-pop');
const isOpen = (pop) => pop.getAttribute('hidden') === null && !(pop.getAttribute('class') ?? '').split(' ').includes('hidden');

function openManual(mount) {
  const toggle = mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento'));
  toggle.dispatch('click');
  const voice = mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente'));
  voice.dispatch('click');
}

test('il blocco nota sta sempre subito dopo Fine, anche senza testo', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await flush();
  openManual(mount);
  assert.ok(isOpen(formPops(mount)[0]), 'the form opens');
  const form = mount.querySelector('.cal-form');
  assert.ok(form, 'the form paints');
  const kids = form.childNodes;
  const endBox = kids.findIndex((node) => node.findAll?.('input').some((input) => input.getAttribute('name') === 'end'));
  const notes = kids.filter((node) => (node.getAttribute?.('class') ?? '').split(' ').includes('empty'));
  assert.equal(notes.length, 1, 'exactly one reserved note block');
  assert.equal(notes[0].textContent, '', 'empty until a submit names missing data');
  assert.ok(endBox >= 0 && kids.indexOf(notes[0]) === endBox + 1, 'the block follows the Fine field');
});

test('la Conferma dello slot scrive «Mancano dei dati» nel blocco dopo Fine', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = 'giovedì alle 10 con marco';
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await flush();
  formPops(mount)[0].findAll('button').find((node) => node.getAttribute('data-action') === 'manual-close').dispatch('click');
  assert.equal(isOpen(formPops(mount)[0]), false, 'the operator shut the form');
  mount.querySelector('.cal-slots').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await flush();
  assert.ok(isOpen(formPops(mount)[0]), 'the form reopens');
  const form = mount.querySelector('.cal-form');
  const kids = form.childNodes;
  const notes = kids.filter((node) => (node.getAttribute?.('class') ?? '').split(' ').includes('empty'));
  assert.equal(notes.length, 1, 'still one note block, never a second jump');
  assert.ok(notes[0].textContent.includes('Mancano dei dati: servizio'), 'the missing data stays named');
  const endBox = kids.findIndex((node) => node.findAll?.('input').some((input) => input.getAttribute('name') === 'end'));
  assert.ok(kids.indexOf(notes[0]) === endBox + 1, 'the block still follows Fine');
});
