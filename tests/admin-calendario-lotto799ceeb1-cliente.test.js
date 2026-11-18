// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * lot lot-apps-admin-public-799ceeb1, item 3aabaea07bfe (c): la frase che
 * nomina un cliente esistente propone quel cliente nella ricerca del modulo,
 * mai come persona in servizio. Il nome fuori dal team non riempie mai
 * «Persona del team»; se appartiene a un cliente esistente, la ricerca lo
 * mostra e l'operatore lo sceglie con un clic — senza auto-scelte tra
 * omonimi.
 */

const MEMBERSHIPS = [
  { subject: 'marco', role: 'operator', displayName: 'Marco' },
];

function stubClient({ customers }) {
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
      if (path === '/api/spine/memberships') return { items: MEMBERSHIPS };
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/customer-data/customers')) {
        const query = new URL(path, 'http://stub.test').searchParams.get('q') ?? '';
        const needle = query.toLowerCase();
        return { items: customers.filter((item) => String(item?.name ?? '').toLowerCase().includes(needle)) };
      }
      if (path === '/api/appointments/phrase' && (options.method ?? 'GET') === 'POST') {
        return {
          draft: { teamMemberId: 'Ada', day: '2026-10-22' },
          dryRun: false,
          spaceId: 'locale',
        };
      }
      throw notFound();
    },
  };
}

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

const customerButtons = (mount) => (mount.querySelector('[data-role="customer-results"]')?.findAll('button') ?? [])
  .map((node) => node.textContent);
const personValue = (mount) => (mount.querySelector('select[name="teamMemberId"]') ?? mount.findAll('input').find((node) => node.getAttribute('name') === 'teamMemberId'))?.value;

async function askPhrase(view, mount) {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = 'fissa ada con marco giovedì';
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await flush();
}

test('la frase nomina una cliente esistente: la ricerca la propone, mai in servizio', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers: [{ resource: 'contact', id: 'c1', name: 'Ada' }] });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount);
  assert.ok(mount.textContent.includes('Ada non è nel team'), 'says Ada is no team member');
  assert.equal(mount.querySelector('.cal-slots'), null, 'no slot searched as Ada');
  assert.ok(client.calls.every((call) => !call.path.startsWith('/api/appointments/suggest-slots')), 'no search as staff');
  assert.equal(mount.querySelector('input[name="customerSearch"]')?.value, 'Ada', 'the customer search proposes Ada');
  assert.deepEqual(customerButtons(mount), ['Ada'], 'the existing customer is one click away');
  assert.equal(personValue(mount), '', '«Persona del team» stays empty, never the customer');
});

test('nessun cliente con quel nome: nessuna proposta, nessuna scelta inventata', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers: [] });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount);
  assert.ok(mount.textContent.includes('Ada non è nel team'), 'says Ada is no team member');
  assert.equal(customerButtons(mount).length, 0, 'no customer button invented');
  assert.ok(
    mount.textContent.includes('Nessun cliente corrisponde. Prova con un altro nome.'),
    'says no customer matches',
  );
  assert.equal(personValue(mount), '', '«Persona del team» stays empty');
});
