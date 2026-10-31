// @ts-check

/**
 * Backoffice BO-F5-03 — dettaglio connettore (backlog:398ef7073cfc).
 *
 * What it must prove: the route parses `#/connettori/<canale>` and keeps
 * hostile hashes invalid; EVERY section of the detail reads the SAME
 * `channel-connection` row (each section carries that row's connectionKey);
 * "skill che lo usano" lists only declared dependencies (each row cites the
 * repo file and the verbatim string that declares the use, and this suite
 * proves the string is really there); hostile server text stays text; an
 * unknown channel renders an honest note without ever fetching for it.
 * DOM-free builders plus the fake document — no browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTOR_DETAIL_CHANNELS,
  catalogFor,
  consumersForChannel,
  createConnectorDetailView,
  detailSections,
  directionOf,
  isConnectorDetailChannel,
  statusLabel,
} from '../apps/admin/public/admin-connector-detail.js';
import { CONNECTOR_CATALOG } from '../apps/admin/public/admin-connectors.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const ENTRY = CONNECTOR_CATALOG.find((row) => row.channel === 'whatsapp');
const CONNECTION = Object.freeze({
  connectionKey: 'presti:whatsapp:+390200000001',
  spaceId: 'presti',
  channel: 'whatsapp',
  account: '+390200000001',
  adapter: 'whatsapp-cloud',
  adapterVersion: 1,
  status: 'active',
  importable: true,
  sync: { status: 'done', importedEvents: 12, createdContacts: 3, unresolvedContacts: 1 },
});

test('the detail route parses, hostile hashes stay invalid', () => {
  assert.deepEqual(parseModuleRoute('#/connettori'), { view: 'connectors' });
  assert.deepEqual(parseModuleRoute('#/connettori/whatsapp'), { view: 'connector-detail', channel: 'whatsapp' });
  assert.deepEqual(parseModuleRoute('#/connettori/site-form'), { view: 'connector-detail', channel: 'site-form' });
  // Unknown but well-formed slugs reach the detail view, which renders an
  // honest "unknown connector" note without ever fetching for them.
  assert.deepEqual(parseModuleRoute('#/connettori/altro'), { view: 'connector-detail', channel: 'altro' });
  // Hostile hashes never become a lookup.
  assert.equal(parseModuleRoute('#/connettori/%2fetc').view, 'invalid');
  assert.equal(parseModuleRoute('#/connettori/%2e%2e').view, 'invalid');
  assert.equal(parseModuleRoute('#/connettori/a/b').view, 'invalid');
  assert.ok(!isConnectorDetailChannel('altro'));
  assert.ok(!isConnectorDetailChannel(null));
  assert.ok(!isConnectorDetailChannel('__proto__'));
  assert.ok(isConnectorDetailChannel('whatsapp'));
  assert.deepEqual([...CONNECTOR_DETAIL_CHANNELS].sort(), CONNECTOR_CATALOG.map((row) => row.channel).sort());
  assert.equal(catalogFor('nope'), null);
});

test('every section reads the same channel-connection record', () => {
  const sections = detailSections({ entry: ENTRY, connection: CONNECTION });
  const keys = ['cosaEntra', 'anteprimaScheda', 'impostazioniAccount', 'interruttori', 'chiRisponde', 'dettagliTecnici', 'skillCheLoUsano'];
  assert.deepEqual(Object.keys(sections).sort(), [...keys].sort());
  for (const key of keys) {
    assert.equal(sections[key].connectionKey, CONNECTION.connectionKey, `${key} carries the record key`);
  }
  // The record's own fields surface, not invented copy.
  assert.ok(sections.anteprimaScheda.lines.some((line) => line.includes('+390200000001')));
  assert.ok(sections.impostazioniAccount.lines.some((line) => line.includes('whatsapp-cloud')));
  assert.ok(sections.interruttori.lines.some((line) => line.includes('Collegato')));
  assert.ok(sections.chiRisponde.lines.some((line) => line.includes('presti')));
  assert.ok(sections.dettagliTecnici.lines.some((line) => line.includes('presti:whatsapp:+390200000001')));
  assert.equal(statusLabel('revoked'), 'Revocato');
  assert.equal(statusLabel('nope'), 'Da collegare');
});

test('without a connection every section says so on the same null key', () => {
  const sections = detailSections({ entry: ENTRY, connection: null });
  for (const section of Object.values(sections)) {
    assert.equal(section.connectionKey, null);
  }
  assert.ok(sections.cosaEntra.lines.some((line) => line.includes('Non collegato')));
  assert.ok(sections.impostazioniAccount.lines.some((line) => line.includes('Nessun account')));
  assert.ok(sections.interruttori.lines.some((line) => line.includes('Niente da accendere')));
});

test('inbound-only channels refuse sends honestly, sms declares no direction', () => {
  assert.equal(directionOf('whatsapp'), 'in-out');
  assert.equal(directionOf('telegram'), 'in-out');
  assert.equal(directionOf('tiktok'), 'in-only');
  assert.equal(directionOf('sms'), null);
  const tiktok = detailSections({
    entry: CONNECTOR_CATALOG.find((row) => row.channel === 'tiktok'),
    connection: { ...CONNECTION, channel: 'tiktok', connectionKey: 'k', importable: false, sync: null },
  });
  assert.ok(tiktok.interruttori.lines.some((line) => line.includes('solo entrata')));
  const sms = detailSections({
    entry: CONNECTOR_CATALOG.find((row) => row.channel === 'sms'),
    connection: null,
  });
  assert.ok(sms.dettagliTecnici.lines.some((line) => line.includes('non dichiarata')));
});

test('"skill che lo usano" shows only declared dependencies', () => {
  for (const channel of CONNECTOR_DETAIL_CHANNELS) {
    const rows = consumersForChannel(channel);
    assert.ok(rows.length > 0, `${channel} names at least one declared consumer`);
    for (const row of rows) {
      assert.ok(typeof row.unit === 'string' && row.unit !== '', `${channel}: consumer names a unit`);
      assert.ok(typeof row.edge === 'string' && row.edge !== '', `${channel}: consumer names an edge`);
      assert.ok(row.evidence && typeof row.evidence.file === 'string' && typeof row.evidence.needle === 'string');
      const body = readFileSync(join(ROOT, row.evidence.file), 'utf8');
      assert.ok(
        body.includes(row.evidence.needle),
        `${channel}: «${row.unit}» declares «${row.edge}» in ${row.evidence.file}`,
      );
    }
  }
  // Unknown channels invent nothing.
  assert.deepEqual(consumersForChannel('altro'), []);
  // The detail section carries the same record key as the other six.
  const sections = detailSections({ entry: ENTRY, connection: CONNECTION });
  assert.equal(sections.skillCheLoUsano.connectionKey, CONNECTION.connectionKey);
  assert.ok(sections.skillCheLoUsano.lines.some((line) => line.includes('appointments')));
});

function stubClient({ connectors = [CONNECTION], adapters = [{ channel: 'whatsapp', name: 'whatsapp-cloud', version: 1 }], units = [], calls = [], catalogError = null, profile = null, channels = true } = {}) {
  return {
    async request(path, options = {}) {
      calls.push(path);
      void options;
      if (path === '/api/schema') {
        return channels ? { domains: { channels: { metadata: { channelsContract: 1, adapters } } } } : { domains: {} };
      }
      if (path === '/api/profile') {
        if (profile === null) throw new Error('profile down');
        return profile;
      }
      if (path === '/api/space-packages/catalog') {
        if (catalogError !== null) throw catalogError;
        return { units };
      }
      if (path.startsWith('/api/connectors?')) return { connectors };
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('the view renders all seven sections from the live row', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createConnectorDetailView({
    doc,
    mount,
    client: stubClient({ calls }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('whatsapp');
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Connettore · WhatsApp'));
  assert.ok(text.includes('Cosa entra in Accordo'));
  assert.ok(text.includes('Come appare nella scheda cliente'));
  assert.ok(text.includes('Impostazioni'));
  assert.ok(text.includes('Interruttori'));
  assert.ok(text.includes('Chi risponde'));
  assert.ok(text.includes('Dettagli tecnici'));
  assert.ok(text.includes('Skill e pacchetti che lo usano'));
  assert.ok(text.includes('+390200000001'));
  assert.ok(!calls.some((path) => path.includes('whatsapp') && path !== '/api/schema' && !path.startsWith('/api/connectors?')),
    'the channel slug never becomes a request path');
});

test('the space comes from the selected space, never from a row field', () => {
  const row = { ...CONNECTION };
  delete row.spaceId;
  const sections = detailSections({ entry: ENTRY, connection: row, spaceId: 'presti' });
  assert.ok(sections.impostazioniAccount.lines.some((line) => line.includes('Spazio: presti')));
  assert.ok(sections.chiRisponde.lines.some((line) => line.includes('spazio «presti»')));
  for (const section of Object.values(sections)) {
    assert.equal(section.connectionKey, CONNECTION.connectionKey);
  }
  // A row that still carries its own space keeps working.
  const legacy = detailSections({ entry: ENTRY, connection: CONNECTION });
  assert.ok(legacy.chiRisponde.lines.some((line) => line.includes('spazio «presti»')));
});

test('without a composed adapter the detail promises no connection', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  // A stale channel-connection row exists, but the list hides it as
  // non-disponibile: the detail must mirror that, not the raw row.
  const view = createConnectorDetailView({
    doc,
    mount,
    client: stubClient({ adapters: [], connectors: [CONNECTION] }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('whatsapp');
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Non disponibile qui'));
  assert.ok(text.includes('Nessun adattatore composto'));
  assert.ok(!text.includes('Collega in 3 passi'));
  assert.ok(!text.includes('+390200000001'), 'stale account stays hidden');
  assert.ok(!text.includes('presti:whatsapp'), 'stale connection key stays hidden');
  assert.ok(!text.includes('outbox del canale con ricevuta'), 'no outbox promise without an adapter');
  assert.ok(!text.includes('Altri collegamenti'), 'no roster without an adapter');
  // Declared consumers need no row and stay visible.
  assert.ok(text.includes('Skill e pacchetti che lo usano'));
});

test('several accounts on one channel all stay visible', async () => {
  const second = { ...CONNECTION, connectionKey: 'presti:whatsapp:+390200000002', account: '+390200000002', status: 'pending' };
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const view = createConnectorDetailView({
    doc,
    mount,
    client: stubClient({ connectors: [CONNECTION, second] }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('whatsapp');
  await flush();
  assert.ok(mount.textContent.includes('+390200000001'));
  assert.ok(mount.textContent.includes('+390200000002'));
  assert.ok(mount.textContent.includes('Altri collegamenti di questo canale'));
});

test('a catalog failure stays visible instead of failing silent', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const failure = Object.assign(new Error('no packages here'), { code: 'SPACE_PACKAGES_MISSING' });
  const view = createConnectorDetailView({
    doc,
    mount,
    client: stubClient({ catalogError: failure }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('whatsapp');
  await flush();
  // backlog:9da124e5 — the failure stays visible, but never with its code.
  assert.ok(mount.textContent.includes('Etichette non caricate'));
  assert.ok(!mount.textContent.includes('SPACE_PACKAGES_MISSING'), 'no error code reaches the customer');
  assert.ok(!mount.textContent.includes('no packages here'), 'no raw server message reaches the customer');
  assert.ok(mount.textContent.includes('Skill e pacchetti che lo usano'));
});

test('an unknown channel renders honestly without fetching for it', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createConnectorDetailView({
    doc,
    mount,
    client: stubClient({ calls }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('altro');
  await flush();
  assert.ok(mount.textContent.includes('Connettore sconosciuto'));
  assert.ok(!calls.some((path) => path.includes('altro')), 'no request carries the unknown slug');
});

test('the mount shows loading while requests are in flight', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const inner = stubClient();
  const view = createConnectorDetailView({
    doc,
    mount,
    client: { request: (path, options) => gate.then(() => inner.request(path, options)) },
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  const pending = view.render('whatsapp');
  await flush(1);
  assert.ok(mount.textContent.includes('Caricamento del connettore'), 'loading paints before load resolves');
  release();
  await pending;
  await flush();
  assert.ok(!mount.textContent.includes('Caricamento del connettore'), 'loading clears on arrival');
  assert.ok(mount.textContent.includes('Connettore · WhatsApp'));
});

test('detail blocks reuse the shipped connector row tokens', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const view = createConnectorDetailView({
    doc,
    mount,
    client: stubClient(),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('whatsapp');
  await flush();
  assert.ok(mount.querySelector('.bo-connector-row') !== null, 'sections use the styled row class');
  assert.ok(mount.querySelector('.bo-connector-section') === null, 'no unstyled container remains');
});

test('in-only channels never promise outbound in cosa entra', () => {
  for (const channel of CONNECTOR_DETAIL_CHANNELS) {
    if (directionOf(channel) !== 'in-only') continue;
    const entry = CONNECTOR_CATALOG.find((row) => row.channel === channel);
    const live = detailSections({
      entry,
      connection: {
        ...CONNECTION, channel, connectionKey: `k:${channel}`, importable: false, sync: null,
      },
    });
    assert.ok(
      live.cosaEntra.lines.every((line) => !line.includes('uscita')),
      `${channel}: cosa entra claims no outbound (${JSON.stringify(live.cosaEntra.lines)})`,
    );
  }
  // The catalog itself matches the matrix, so the wizard cannot promise it either.
  const tiktok = CONNECTOR_CATALOG.find((row) => row.channel === 'tiktok');
  assert.ok(tiktok.syncLines.every((line) => !line.includes('uscita')));
});

test('hostile server text stays text, never markup', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const hostile = {
    ...CONNECTION,
    account: '<img src=x onerror=alert(1)>',
    adapter: '<script>alert(2)</script>',
  };
  const view = createConnectorDetailView({
    doc,
    mount,
    client: stubClient({ connectors: [hostile] }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('whatsapp');
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('<img src=x onerror=alert(1)>'));
  const html = mount.innerHTML ?? '';
  assert.ok(!html.includes('<img src=x'), 'hostile account is text, never an element');
  assert.ok(!html.includes('<script>'), 'hostile adapter is text, never an element');
});

test('the Email detail offers Gmail Collega even without composed channels; other channels do not', async () => {
  const profile = { member: {}, connections: { available: true, reason: null,
    items: [{ connector: 'calendar', status: 'disconnected', account: null }, { connector: 'gmail', status: 'disconnected', account: null }] } };
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createConnectorDetailView({ doc, mount, client: stubClient({ profile, channels: false, calls }), navigate: () => {}, storage: null });
  await view.render('email');
  await new Promise((resolve) => setImmediate(resolve));
  const card = mount.findAll('section').find((node) => node.getAttribute('data-section') === 'google-connections');
  assert.ok(card, 'the Gmail card sits under the title');
  assert.deepEqual(card.findAll('div').filter((node) => node.getAttribute('data-connector')).map((node) => node.getAttribute('data-connector')), ['gmail']);
  assert.equal(card.findAll('a').find((node) => node.textContent === 'Collega').getAttribute('href'), '../profile/collega?connector=gmail');
  assert.ok(mount.textContent.includes('non sono composti'));

  const other = createMount(doc);
  const otherCalls = [];
  await createConnectorDetailView({ doc, mount: other, client: stubClient({ profile, channels: false, calls: otherCalls }), navigate: () => {}, storage: null }).render('whatsapp');
  assert.ok(!otherCalls.includes('/api/profile'), 'only Email reads the Google connections');
  assert.ok(!other.findAll('section').some((node) => node.getAttribute('data-section') === 'google-connections'));
});
