// @ts-check
/**
 * Repro per backlog:6d0df351 (supervisore 17/11, prova del Mac): tre difetti
 * nella tabella dei canali di Stato sync.
 *
 * - scrive «non collegato» invece di «Non ancora disponibile»;
 * - Telegram è «TE» con direzione «—» mentre in Connettori è «TG ↔»
 *   (una sola fonte per sigla e direzione);
 * - la tabella mostra SMS e dice «2 di 9 collegati» su 11 righe
 *   (il conteggio usa le righe mostrate).
 *
 * Rosso sul codice prima della cura, verde dopo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createSyncView, syncChannelTable } from '../apps/admin/public/admin-sync.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const entryOf = (over = {}) => ({
  connectionKey: 'wa-1',
  channel: 'whatsapp',
  account: '+39 333 1234567',
  status: 'active',
  importable: true,
  sync: null,
  inbox: { received: 10, lastReceivedAt: '2026-10-25T11:30:00.000Z' },
  outbox: { openDeadLetters: 0, lastFailedAt: null },
  direction: 'both',
  health: 'ok',
  ...over,
});

const activityOf = (over = {}) => ({
  spaceId: 'prova',
  connections: [entryOf(), entryOf({ connectionKey: 'ig-1', channel: 'instagram' })],
  feed: [],
  needsFix: 0,
  lastActivityAt: '2026-10-25T11:30:00.000Z',
  ...over,
});

const COMPOSED_ADAPTERS = ['whatsapp', 'instagram', 'telegram', 'facebook', 'tiktok', 'sms', 'email', 'voice', 'site-form']
  .map((channel) => ({ channel, name: `${channel}-adapter`, version: 1 }));

function fakeClient({ activity = activityOf() } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (String(options.method ?? 'GET').toUpperCase() !== 'GET') throw new Error(`unexpected mutation ${path}`);
      if (path === '/api/schema') return { domains: { channels: { metadata: { channelsContract: 1, adapters: COMPOSED_ADAPTERS } } } };
      if (path.startsWith('/api/connectors/activity')) return activity;
      if (path === '/api/profile') throw new Error('profile not served');
      if (path.startsWith('/api/modules/duplicate-candidate/records')) return { items: [] };
      throw new Error(`unexpected GET ${path}`);
    },
  };
}

test('6d0df351: Stato sync parla come Connettori (scritta, TG/↔, conteggio sulle righe mostrate)', async () => {
  const rows = syncChannelTable(activityOf(), Date.parse('2026-10-25T12:00:00.000Z'), { adapters: COMPOSED_ADAPTERS });
  const telegram = rows.find((row) => row.channel === 'telegram');
  assert.ok(telegram, 'Telegram compare in tabella');
  assert.equal(telegram.mark, 'TG', 'stessa sigla di Connettori');
  assert.equal(telegram.direction, '↔ bidirezionale', 'stessa direzione di Connettori');
  const sms = rows.find((row) => row.channel === 'sms');
  assert.ok(sms, 'SMS compare in tabella');
  assert.equal(sms.mark, 'S', 'stessa sigla di Connettori');

  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSyncView({
    doc,
    mount,
    client: fakeClient(),
    storage: { getItem: () => 'prova', setItem: () => {}, removeItem: () => {} },
    navigate: () => {},
    toast: () => {},
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(!text.includes('non collegato'), 'mai «non collegato» in tabella');
  assert.ok(text.includes('Non ancora disponibile'), 'le righe senza collegamento dicono «Non ancora disponibile»');
  assert.ok(text.includes(`2 di ${rows.length} collegati`), `il conteggio usa le righe mostrate (${rows.length})`);
});

test('6d0df351/P2 review #1010: un osservatore vede «Da collegare» dove si puo, «Non ancora disponibile» solo dove non si puo', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSyncView({
    doc,
    mount,
    client: fakeClient({ activity: activityOf({ connections: [], feed: [] }) }),
    storage: { getItem: () => 'prova', setItem: () => {}, removeItem: () => {} },
    role: () => 'observer',
    navigate: () => {},
    toast: () => {},
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  const whatsapp = mount.findAll('tr').find((row) => row.textContent.includes('WhatsApp'));
  assert.ok(whatsapp, 'la riga WhatsApp resta in tabella');
  assert.ok(whatsapp.textContent.includes('Da collegare'), 'un canale collegabile non dice mai «Non ancora disponibile»');
  assert.ok(!whatsapp.textContent.includes('Non ancora disponibile'), 'osservatore: permesso, non indisponibilita');
  assert.equal(whatsapp.findAll('a').length, 0, 'nessun Collega per un osservatore');
  const stripe = mount.findAll('tr').find((row) => row.textContent.includes('Stripe'));
  assert.ok(stripe && stripe.textContent.includes('Non ancora disponibile'), 'Stripe resta «Non ancora disponibile»');
  assert.ok(!text.includes('non collegato'), 'mai «non collegato» in tabella');
});
