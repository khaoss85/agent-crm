// @ts-check
/**
 * backlog:6563edf41aab (ritorno verifica 19/11, prova del Mac sul live):
 * (a) Calendario › Team mostra «Daniele Pelleri (1)» e «daniele pelleri (2)»
 * senza spiegazione — deve portare lo stesso avviso di Spazi e accessi;
 * (d) Impostazioni conta il doppione ma Stato sync dice «Niente da
 * sistemare» — l'elenco deve nominare il doppione nel team con il link.
 * Rosso sul codice prima della cura, verde dopo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createSyncView } from '../apps/admin/public/admin-sync.js';

/** Le due righe viste dal Mac: stesso nome, accessi e mailbox diversi. */
const DUP_MEMBERS = [
  { subject: 'google|1049887766', displayName: 'Daniele Pelleri', email: 'daniele@example.com', role: 'owner', status: 'active', operatorAccountId: 'op-1' },
  { subject: 'broker+adopted-7f3a', displayName: 'daniele pelleri', email: 'broker+adopted-7f3a@accordo.invalid', role: 'operator', status: 'active' },
];

const EMPTY_WEEK = { from: '2026-10-19T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', members: [] };

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

function calendarioClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: DUP_MEMBERS };
      if (path.startsWith('/api/appointments/team-week')) return EMPTY_WEEK;
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [] };
      }
      if (path === '/api/appointments/services') {
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/customer-data/customers')) {
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

test('backlog:6563edf41aab: Calendario Team segnala il doppione come Spazi e accessi', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: calendarioClient(), now: () => new Date('2026-10-23T06:00:00Z'),
  });
  await view.render();
  await flush(12);
  const paragraphs = mount.findAll('p').map((node) => node.textContent);
  // Lo stesso avviso dipinto in Spazi e accessi, con la causa (accessi diversi).
  assert.ok(
    paragraphs.some((text) => text.includes('Possibile doppione') && text.toLowerCase().includes('daniele pelleri') && text.includes('accessi diversi')),
    `il Team del Calendario spiega il doppione: ${JSON.stringify(paragraphs)}`,
  );
});

const SCHEMA_OK = { domains: { channels: { metadata: { channelsContract: 1, adapters: [] } } } };
const ACTIVITY_OK = {
  spaceId: 'prova',
  connections: [],
  feed: [],
  needsFix: 0,
  lastActivityAt: '2026-10-25T11:30:00.000Z',
};

function syncClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (String(options.method ?? 'GET').toUpperCase() !== 'GET') throw new Error(`unexpected mutation ${path}`);
      if (path === '/api/schema') return SCHEMA_OK;
      if (path.startsWith('/api/connectors/activity')) return ACTIVITY_OK;
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/modules/duplicate-candidate/records')) return { items: [] };
      if (path === '/api/spine/memberships') return { items: DUP_MEMBERS };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

test('backlog:6563edf41aab: Stato sync elenca il doppione nel team con il link a Spazi e accessi', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const view = createSyncView({
    doc,
    mount,
    client: syncClient(),
    storage: { getItem: () => 'prova', setItem: () => {}, removeItem: () => {} },
    navigate: (hash) => navigated.push(hash),
    toast: () => {},
  });
  await view.render();
  await flush(12);
  const text = mount.textContent;
  // Il conteggio e l'elenco vengono dalla stessa fonte: niente all-clear
  // mentre il doppione è segnalato.
  assert.ok(text.includes('Da sistemare 1'), `la sezione conta il doppione: ${text.slice(0, 400)}`);
  assert.ok(text.includes('Doppione nel team'), `l'elenco nomina il doppione nel team: ${text.slice(0, 600)}`);
  const link = mount.findAll('a').find((node) => node.textContent === 'Vedi in Spazi e accessi');
  assert.ok(link, 'la card porta a Spazi e accessi');
  assert.equal(link.getAttribute('href'), '#/spazi-accessi');
});
