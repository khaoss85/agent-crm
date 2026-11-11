import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineBoard } from '../apps/admin/public/admin-pipeline.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:fb47ab99b6ee — Pipeline, vista Lista (giro UX 11/11, punto 22):
 * intestazioni ordinabili, date «11 nov 2026», colonna Cliente, referente col
 * nome della persona (mai «coach-guido»).
 */

const PIPELINE = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  stages: [
    { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'won', label: 'Vinta', order: 50, type: 'won', probability: 100 },
  ],
};

function record(id, stage, extra = {}) {
  return {
    id, name: `Offerta ${id}`, companyName: 'Acme', valueCents: 100_000, currency: 'EUR',
    pipelineKey: 'b2b-sales', pipelineStage: stage, ...extra,
  };
}

const MEMBERS = [
  { subject: 'coach-guido', role: 'member', status: 'active', displayName: 'Guido Presti' },
];

async function lista(records) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [PIPELINE] };
      if (path === '/api/spine/memberships') return { items: MEMBERS };
      return { items: records };
    },
  };
  const board = createPipelineBoard({ doc, mount, client });
  await board.renderBoard('b2b-sales');
  mount.findAll('button').find((node) => node.getAttribute('data-view') === 'lista').dispatch('click');
  return mount;
}

const table = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-listview') === 'records');
const ids = (mount) => table(mount).findAll('tr').map((row) => row.getAttribute('data-record')).filter(Boolean);
const header = (mount, key) => table(mount).findAll('th').find((node) => node.getAttribute('data-sort-key') === key);
const sortBy = (mount, key) => header(mount, key).findAll('button')[0].dispatch('click');
const cellsOf = (mount, id) => table(mount).findAll('tr').find((row) => row.getAttribute('data-record') === id).findAll('td');

test('fb47ab99b6ee: the Lista has a Cliente column — the contact, else the company, never the placeholder', async () => {
  const mount = await lista([
    record('a', 'discovery', { contactName: 'Giulia Bianchi', companyName: 'Senza azienda' }),
    record('b', 'discovery', { companyName: 'Palestra Esempio' }),
    record('c', 'discovery', { companyName: 'Senza azienda' }),
  ]);
  const headers = table(mount).findAll('th').map((node) => node.textContent);
  assert.equal(headers[1], 'Cliente');
  assert.equal(cellsOf(mount, 'a')[1].textContent, 'Giulia Bianchi', 'the contact the offer is for');
  assert.equal(cellsOf(mount, 'b')[1].textContent, 'Palestra Esempio', 'the company when there is no contact');
  assert.equal(cellsOf(mount, 'c')[1].textContent, '—', 'never «Senza azienda»');
});

test('fb47ab99b6ee: dates read «11 nov 2026», never ISO', async () => {
  const mount = await lista([record('a', 'discovery', {
    expectedCloseDate: '2026-11-11T00:00:00.000Z', createdAt: '2026-10-02T09:30:00.000Z',
  })]);
  const cells = cellsOf(mount, 'a');
  assert.equal(cells[5].textContent, '11 nov 2026');
  assert.equal(cells[6].textContent, '2 ott 2026');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(table(mount).textContent), 'no ISO day anywhere in the table');
});

test('fb47ab99b6ee: the referente reads the person\'s name, never the slug', async () => {
  const mount = await lista([record('a', 'discovery', { owner: 'coach-guido' })]);
  assert.equal(cellsOf(mount, 'a')[7].textContent, 'Guido Presti');
  assert.ok(!table(mount).textContent.includes('coach-guido'));
});

test('fb47ab99b6ee: every header sorts; a second click reverses; blanks stay last', async () => {
  const mount = await lista([
    record('a', 'demo', { name: 'Bagno', valueCents: 50_000, expectedCloseDate: '2026-12-01', contactName: 'Zeno' }),
    record('b', 'discovery', { name: 'cucina', valueCents: 300_000, expectedCloseDate: '2026-11-15', contactName: 'Anna' }),
    record('c', 'won', { name: 'Armadio', valueCents: 10_000, contactName: 'Marco' }),
  ]);
  assert.deepEqual(ids(mount), ['a', 'b', 'c'], 'server order before any sort');
  for (const th of table(mount).findAll('th')) {
    assert.equal(th.getAttribute('aria-sort'), 'none', 'no column claims a sort yet');
    assert.equal(th.findAll('button').length, 1, `${th.textContent}: the header is a button`);
  }

  sortBy(mount, 'name');
  assert.deepEqual(ids(mount), ['c', 'a', 'b'], 'Offerta A→Z, case-insensitive');
  assert.equal(header(mount, 'name').getAttribute('aria-sort'), 'ascending');
  sortBy(mount, 'name');
  assert.deepEqual(ids(mount), ['b', 'a', 'c'], 'second click: Z→A');
  assert.equal(header(mount, 'name').getAttribute('aria-sort'), 'descending');

  sortBy(mount, 'value');
  assert.deepEqual(ids(mount), ['c', 'a', 'b'], 'Valore: smallest first');
  assert.equal(header(mount, 'name').getAttribute('aria-sort'), 'none', 'only one column is sorted');

  sortBy(mount, 'stage');
  assert.deepEqual(ids(mount), ['b', 'a', 'c'], 'Stato follows the pipeline order, not the alphabet');

  sortBy(mount, 'customer');
  assert.deepEqual(ids(mount), ['b', 'c', 'a'], 'Cliente A→Z');

  sortBy(mount, 'close');
  assert.deepEqual(ids(mount), ['b', 'a', 'c'], 'Chiusura: earliest first, no date last');
  sortBy(mount, 'close');
  assert.deepEqual(ids(mount), ['a', 'b', 'c'], 'reversed: latest first, still no date last');
});

test('fb47ab99b6ee: the sort survives a search and the switch back from Kanban', async () => {
  const mount = await lista([
    record('a', 'discovery', { name: 'Bagno grande' }),
    record('b', 'discovery', { name: 'Armadio' }),
    record('c', 'discovery', { name: 'Bagno piccolo' }),
  ]);
  sortBy(mount, 'name');
  const search = mount.findAll('input').find((node) => node.getAttribute('data-filter') === 'q');
  search.value = 'Bagno';
  search.dispatch('input');
  assert.deepEqual(ids(mount), ['a', 'c']);
  mount.findAll('button').find((node) => node.getAttribute('data-view') === 'kanban').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-view') === 'lista').dispatch('click');
  assert.equal(header(mount, 'name').getAttribute('aria-sort'), 'ascending', 'the chosen sort is kept');
});
