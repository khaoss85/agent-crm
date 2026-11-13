// @ts-check

/**
 * Un solo stato per canale (backlog:e381c48581fa) e tab fissi in
 * Impostazioni (backlog:1cfc68175ab7), dal giro UX in produzione dell'11/11.
 *
 * What it must prove: on one space where WhatsApp is linked through
 * Profilo's Meta link and Google Calendar through Profilo's Google link,
 * with no channel adapter composed, every screen gives one answer —
 * Connettori, its detail, Personalizzazione «I tuoi», the space card and
 * the shared «x di 9» count; «I tuoi» shows no Kit-social hero; and a
 * settings tab keeps the tab row on screen while its content loads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_STATE_LABELS,
  NINE_CHANNEL_IDS,
  channelConnectionCount,
  channelState,
  isProfileEmailStandinRow,
  mergeProfileConnections,
} from '../apps/admin/public/admin-channels-count.js';
import { CONNECTOR_CATALOG, connectorStatus, createConnectorsView } from '../apps/admin/public/admin-connectors.js';
import { createConnectorDetailView } from '../apps/admin/public/admin-connector-detail.js';
import { createPersonalizzazioneView, filterConnettori } from '../apps/admin/public/admin-personalizzazione.js';
import { countSpaceChannels } from '../apps/admin/public/admin-spazi-accessi.js';
import { SETTINGS_VIEW_AREAS, keepSettingsTabs } from '../apps/admin/public/admin-shell.js';
import { paintScreenFailure, paintScreenLoading } from '../apps/admin/public/admin-navigation.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

/** The production space of the giro: two profile links, no adapters. */
const ROWS = Object.freeze([
  Object.freeze({ connectionKey: 'profile:whatsapp', channel: 'whatsapp', account: '+390200000001', status: 'active' }),
  Object.freeze({ connectionKey: 'profile:calendar', channel: 'calendar', account: 'dan@presti.it', status: 'active' }),
]);

test('channelState: an active row is collegato on every screen, adapter or not', () => {
  const linked = channelState('whatsapp', { rows: ROWS, adapters: [] });
  assert.equal(linked.state, 'collegato');
  assert.equal(linked.text, 'Collegato');
  assert.equal(linked.account, '+390200000001');
  assert.equal(linked.managedHere, false, 'no adapter: not configured here');
  assert.match(linked.note ?? '', /i messaggi arrivano nelle schede dei clienti/);
  assert.equal(linked.manageRoute, '#/profilo', 'a profile link is managed on Profilo');
  const packageRow = { connectionKey: 'presti:whatsapp:+390200000001', channel: 'whatsapp', status: 'active' };
  const composed = channelState('whatsapp', { rows: [packageRow], adapters: [{ name: 'wa', version: 1 }] });
  assert.equal(composed.state, 'collegato');
  assert.equal(composed.managedHere, true);
  assert.equal(composed.note, null);
  // Unknown adapters (a screen that did not read the schema) still say collegato.
  assert.equal(channelState('whatsapp', { rows: ROWS }).state, 'collegato');
  // Aliases count as the same channel.
  assert.equal(channelState('calendar', { rows: [{ channel: 'google-calendar', status: 'active' }] }).state, 'collegato');
});

test('channelState: not linked reads da-completare, da-collegare or non-disponibile in plain words', () => {
  assert.equal(channelState('instagram', { rows: [{ channel: 'instagram', status: 'pending' }], adapters: [{}] }).state, 'da-completare');
  const toConnect = channelState('instagram', { rows: [], adapters: [{}] });
  assert.equal(toConnect.state, 'da-collegare');
  assert.equal(toConnect.connectRoute, '#/connettori/instagram');
  const nowhere = channelState('instagram', { rows: [], adapters: [] });
  assert.equal(nowhere.state, 'non-disponibile');
  assert.equal(nowhere.text, 'Non ancora disponibile');
  assert.doesNotMatch(nowhere.note ?? '', /adattatore|composto/i, 'no technical jargon');
  // Profilo connects a Meta channel only on a configured Meta app.
  const meta = (configured) => ({ connections: { available: true, items: [{ connector: 'whatsapp', status: 'disconnected' }], meta: { configured } } });
  assert.equal(channelState('whatsapp', { rows: [], adapters: [], profile: meta(true) }).connectRoute, '#/profilo');
  assert.equal(channelState('whatsapp', { rows: [], adapters: [], profile: meta(false) }).state, 'non-disponibile');
  // A profile Gmail link merges like the shared count — but the stand-in
  // is no channel connection (backlog:3805161965cd): Email reads
  // da-collegare with the email connectRoute, never collegato.
  const profile = { connections: { available: true, items: [{ connector: 'gmail', status: 'connected', account: 'dan@presti.it' }] } };
  const gmailAlone = channelState('email', { rows: [], adapters: [], profile });
  assert.equal(gmailAlone.state, 'da-collegare');
  assert.equal(gmailAlone.connectRoute, '#/profilo', 'Gmail connects on Profilo, the Connettori screen is only the fallback');
  for (const label of Object.values(CHANNEL_STATE_LABELS)) {
    assert.doesNotMatch(label.text, /qui$/, 'no «Non disponibile qui»');
  }
});

/**
 * The raw production input (review #782 P1): the framework's GET
 * /api/connectors carries only channel-connection rows, and the Google and
 * Meta links live apart in GET /api/profile. No pre-merged `profile:` row.
 */
const RAW_ROWS = Object.freeze([]);
const PROFILE = Object.freeze({
  member: { name: 'Dan' },
  connections: {
    available: true,
    reason: null,
    items: [
      { connector: 'whatsapp', status: 'connected', account: '+390200000001' },
      { connector: 'calendar', status: 'connected', account: 'dan@presti.it' },
      { connector: 'gmail', status: 'disconnected', account: null },
    ],
    meta: { configured: true },
  },
});

test('e381c48581fa: from the raw rows plus the profile, every screen counts the same channels', () => {
  const merged = mergeProfileConnections(RAW_ROWS, PROFILE);
  const shared = channelConnectionCount(merged);
  assert.equal(shared.connected, 2, '«2 di 9» on Oggi and Stato sync');
  assert.equal(countSpaceChannels({ connectors: RAW_ROWS }, PROFILE), 2, 'the space card says 2 canali');
  assert.equal(countSpaceChannels({ connectors: RAW_ROWS }), 0, 'without the profile it could not know');
  const mine = filterConnettori({ connectors: RAW_ROWS, profile: PROFILE, view: 'tuoi' })
    .flatMap((group) => group.cards.map((card) => card.entry.label));
  assert.deepEqual(mine.sort(), ['Google Calendar', 'WhatsApp'], '«I tuoi» lists both, Google Calendar included');
  const whatsapp = CONNECTOR_CATALOG.find((entry) => entry.channel === 'whatsapp');
  const mapped = connectorStatus({ entry: whatsapp, adapters: [], connections: [], profile: PROFILE });
  assert.equal(mapped.status, 'collegato');
  assert.equal(mapped.shared.manageRoute, '#/profilo');
  for (const id of NINE_CHANNEL_IDS) {
    const linked = channelState(id, { rows: RAW_ROWS, profile: PROFILE }).state === 'collegato';
    assert.equal(linked, shared.connectedChannels.includes(id), `${id}: one answer`);
  }
});

test('review #782 P3: a composed adapter never routes Calendar or Stripe into the guided flow', () => {
  const offering = { connections: { available: true, items: [{ connector: 'calendar', status: 'disconnected' }] } };
  assert.equal(channelState('calendar', { rows: [], adapters: [{}], profile: offering }).connectRoute, '#/profilo');
  assert.equal(channelState('stripe', { rows: [], adapters: [{}] }).state, 'non-disponibile');
  // A profile link stays managed on Profilo even beside a composed adapter.
  const linked = channelState('whatsapp', { rows: [], adapters: [{}], profile: PROFILE });
  assert.equal(linked.state, 'collegato');
  assert.equal(linked.managedHere, false);
  assert.equal(linked.manageRoute, '#/profilo');
});

function connectorsClient(calls = []) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path === '/api/schema') return { domains: { channels: { metadata: { channelsContract: 1, adapters: [] } } } };
      if (path === '/api/profile') return PROFILE;
      if (path.startsWith('/api/connectors?')) return { connectors: [...RAW_ROWS] };
      if (path.startsWith('/api/connectors/activity')) return { connections: [] };
      if (path === '/api/space-packages/catalog') return { units: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
}

test('e381c48581fa: Connettori and the WhatsApp detail read the profile link as Collegato', async () => {
  const doc = createFakeDocument();
  const list = createMount();
  const calls = [];
  const storage = { getItem: () => 'presti', setItem: () => {} };
  await createConnectorsView({ doc, mount: list, client: connectorsClient(calls), navigate: () => {}, storage }).render();
  await flush();
  const row = list.findAll('div').find((node) => node.getAttribute('data-channel') === 'whatsapp');
  assert.ok(row.textContent.includes('Collegato'), 'the list row says Collegato');
  assert.ok(row.textContent.includes('Collegato come +390200000001'));
  assert.ok(!row.textContent.includes('Non ancora disponibile'));
  assert.equal(calls.filter((path) => path === '/api/profile').length, 1, 'one profile read, shared with the Google card');
  const detail = createMount();
  await createConnectorDetailView({ doc, mount: detail, client: connectorsClient(), navigate: () => {}, storage }).render('whatsapp');
  await flush();
  assert.ok(detail.textContent.includes('WhatsApp · +390200000001 · Collegato'));
  assert.ok(detail.textContent.includes('Si gestisce dal Profilo'));
  assert.ok(!detail.textContent.includes('Nessun adattatore'));
  // Instagram: no row, no adapter, and the profile does not offer it:
  // nothing here connects it.
  const instagram = list.findAll('div').find((node) => node.getAttribute('data-channel') === 'instagram');
  assert.ok(instagram.textContent.includes('Non ancora disponibile'));
});

test('e381c48581fa: a Meta channel Profilo can connect offers the green Collega towards Profilo', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const offering = {
    connections: { available: true, items: [{ connector: 'instagram', status: 'disconnected', account: null }], meta: { configured: true } },
  };
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { domains: { channels: { metadata: { channelsContract: 1, adapters: [] } } } };
      if (path === '/api/profile') return offering;
      if (path.startsWith('/api/connectors?')) return { connectors: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  const storage = { getItem: () => 'presti', setItem: () => {} };
  await createConnectorsView({ doc, mount, client, navigate: (hash) => navigated.push(hash), storage }).render();
  await flush();
  const row = mount.findAll('div').find((node) => node.getAttribute('data-channel') === 'instagram');
  assert.ok(row.textContent.includes('Da collegare'));
  const collega = row.findAll('a').find((node) => node.getAttribute('data-action') === 'connect-elsewhere');
  assert.ok(collega, 'Collega is there');
  assert.match(collega.getAttribute('class') ?? '', /\bui-btn-cta\b/, 'green');
  assert.equal(collega.getAttribute('href'), '#/profilo');
  collega.dispatch('click', { preventDefault() {} });
  assert.deepEqual(navigated, ['#/profilo'], 'it leads to Profilo, never into a wizard with no adapter');
});

function perso(connectors) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/profile') return PROFILE;
      if (path === '/api/space-packages/catalog') return { units: [] };
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      if (path.startsWith('/api/connectors?')) return { connectors };
      if (path.startsWith('/api/customer-data/') || path.startsWith('/api/connectors/activity') || path.startsWith('/api/modules/')) {
        return { items: [], connections: [] };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

test('e381c48581fa: «I tuoi» shows the linked cards without the Kit social hero', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createPersonalizzazioneView({ doc, mount, client: perso([...RAW_ROWS]), navigate: () => {}, spaceId: () => 'presti' });
  view.test.state.tab = 'connettori';
  view.test.state.view = 'tuoi';
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(!text.includes('Kit social'), 'no promotional hero over what is already linked');
  assert.ok(text.includes('WhatsApp'));
  assert.ok(text.includes('Google Calendar'), 'Calendar linked on Profilo is one of yours');
  // Scopri keeps the prototype hero.
  view.test.state.view = 'scopri';
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Kit social'));
});

test('1cfc68175ab7: a settings tab keeps the tab row while its content loads', () => {
  const doc = createFakeDocument();
  for (const [view, area] of Object.entries(SETTINGS_VIEW_AREAS)) {
    const mount = createMount();
    mount.appendChild(doc.createElement('p')).textContent = 'Personalizzazione: Connettori';
    const loading = paintScreenLoading({ doc, mount, label: 'Stato sync' });
    const navigated = [];
    assert.equal(keepSettingsTabs(doc, { mount, loading, view, fixCount: 3, navigate: (hash) => navigated.push(hash) }), true);
    assert.ok(mount.textContent.includes('IMPOSTAZIONI'), `${view}: the tab row stays`);
    assert.ok(mount.textContent.includes('Carico Stato sync…'), `${view}: only the content loads`);
    assert.ok(!mount.textContent.includes('Personalizzazione: Connettori'), `${view}: the old content is gone`);
    const tabs = mount.findAll('button').filter((node) => node.getAttribute('data-tab'));
    assert.equal(tabs.length, 4);
    const active = tabs.find((node) => node.getAttribute('aria-selected') === 'true');
    assert.equal(active?.getAttribute('data-tab'), area, `${view}: the opened tab is underlined at once`);
    assert.ok(mount.textContent.includes('3'), 'the fix badge stays on Stato sync');
    // The tabs stay clickable while the content loads.
    const other = tabs.find((node) => node.getAttribute('data-tab') !== area);
    other.dispatch('click', {});
    assert.equal(navigated.length, 1, 'a tab click during loading navigates');
    // A failure still replaces the loading line with the honest note.
    assert.equal(paintScreenFailure({ doc, mount, loading, label: 'Stato sync' }), true);
  }
  // Any other screen keeps the plain loading line.
  const mount = createMount();
  const loading = paintScreenLoading({ doc, mount, label: 'Clienti' });
  assert.equal(keepSettingsTabs(doc, { mount, loading, view: 'customer-data' }), false);
  assert.ok(!mount.textContent.includes('IMPOSTAZIONI'));
});

// Review giro 4 P1 (backlog:3805161965cd): the Email stand-in rule is the
// composer's rule — a `source: 'profile'` marker or a `profile:` key (any
// case), never a real route. Only Email rows count; other channels and
// real Email rows stay out.
test('isProfileEmailStandinRow shares the composer rule, key and alias spellings included', () => {
  assert.equal(isProfileEmailStandinRow({ channel: 'email', status: 'active', connectionKey: 'profile:gmail', source: 'profile' }), true);
  assert.equal(isProfileEmailStandinRow({ channel: 'email', status: 'active', connectionKey: 'profile:gmail' }), true, 'key-only row');
  assert.equal(isProfileEmailStandinRow({ channel: 'Email', status: 'active', connectionKey: 'PROFILE:Gmail' }), true, 'key match ignores case');
  assert.equal(isProfileEmailStandinRow({ channel: 'email', status: 'active', connectionKey: 'gmail-1' }), false, 'a real route stays in');
  assert.equal(isProfileEmailStandinRow({ channel: 'whatsapp', status: 'active', connectionKey: 'profile:whatsapp' }), false, 'only Email is a stand-in');
  assert.equal(isProfileEmailStandinRow({ channel: 'email', status: 'active' }), false, 'no marker, no key');
  assert.equal(isProfileEmailStandinRow({ channel: 'gmail', status: 'active', connectionKey: 'profile:gmail', source: 'profile' }), true, 'alias spelling still a stand-in');
  assert.equal(isProfileEmailStandinRow({ channel: 'gmail', status: 'active', connectionKey: 'PROFILE:Gmail' }), true, 'alias spelling, key only');
  assert.equal(isProfileEmailStandinRow({ channel: 'gmail', status: 'active', connectionKey: 'gmail-1' }), false, 'a real gmail route stays in');
  assert.equal(isProfileEmailStandinRow(null), false);
});
