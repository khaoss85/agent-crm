import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_CATALOG,
  CONNECT_STEPS,
  connectorStatus,
  createConnectFlow,
  createConnectorsView,
  flowAuthorized,
  flowAuthorizeStart,
  flowBack,
  flowChooseHistory,
  flowFail,
  flowFinished,
  flowFinishStart,
  flowSetAccount,
  matchAdapters,
  matchConnections,
} from '../apps/admin/public/admin-connectors.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { SETTINGS_AREAS } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Backoffice BO-F1-02 — collegare un connettore in 3 passi.
 *
 * What it must prove: the catalog covers every connectable channel with an
 * Italian label and a "cosa succede quando colleghi" preview; the status
 * mapping is honest (no adapter → non-disponibile, no row → da-collegare);
 * the flow advances only autorizza → sincronizza → fatto; the screen renders
 * the preview for unconnected connectors and drives the three server calls;
 * hostile server text stays text. A channels package the server does not
 * compose renders an honest note, never a blank page.
 */

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

test('catalog covers every channel with a what-happens preview', () => {
  const channels = CONNECTOR_CATALOG.map((entry) => entry.channel).sort();
  assert.deepEqual(channels, ['email', 'facebook', 'instagram', 'site-form', 'sms', 'tiktok', 'voice', 'whatsapp']);
  for (const entry of CONNECTOR_CATALOG) {
    assert.ok(entry.label !== '', `${entry.channel} has an Italian label`);
    assert.ok(entry.whatHappens.length >= 2, `${entry.channel} previews what connecting does`);
    assert.ok(
      entry.whatHappens.some((line) => line.includes('mai uniti da soli')),
      `${entry.channel} promises duplicates are never merged silently`,
    );
  }
  assert.deepEqual([...CONNECT_STEPS], ['autorizza', 'sincronizza', 'fatto']);
});

test('Personalizzazione opens the connectors screen', () => {
  const area = SETTINGS_AREAS.find((row) => row.id === 'personalizzazione');
  assert.equal(area.route, '#/connettori');
  assert.equal(parseModuleRoute('#/connettori').view, 'connectors');
  assert.equal(parseModuleRoute('#/connettori/altro').view, 'invalid');
});

test('status mapping stays honest with no adapter or no connection', () => {
  const entry = CONNECTOR_CATALOG[0];
  assert.equal(
    connectorStatus({ entry, adapters: [], connections: [] }).status,
    'non-disponibile',
  );
  assert.equal(
    connectorStatus({ entry, adapters: [{ name: 'a', version: 1 }], connections: [] }).status,
    'da-collegare',
  );
  assert.equal(
    connectorStatus({ entry, adapters: [{ name: 'a', version: 1 }], connections: [{ status: 'pending' }] }).status,
    'da-completare',
  );
  assert.equal(
    connectorStatus({ entry, adapters: [{ name: 'a', version: 1 }], connections: [{ status: 'active' }] }).status,
    'collegato',
  );
});

test('matchers ignore hostile or malformed rows', () => {
  assert.deepEqual(matchAdapters('whatsapp', null), []);
  assert.deepEqual(matchAdapters('whatsapp', [
    { channel: 'whatsapp', name: 'wa', version: 1 },
    { channel: 'whatsapp', name: '__proto__', version: 1 },
    { channel: 'email', name: 'mail', version: 1 },
    { channel: 'whatsapp', name: 'broken' },
    null,
  ]).map((row) => row.name), ['wa', '__proto__']);
  assert.deepEqual(matchConnections('whatsapp', [
    { channel: 'whatsapp', connectionKey: 'k1' },
    { channel: 'whatsapp' },
    null,
  ]).map((row) => row.connectionKey), ['k1']);
});

test('flow transitions enforce the step order', () => {
  const adapter = { name: 'wa', version: 1 };
  let flow = createConnectFlow({ channel: 'whatsapp', adapter });
  assert.equal(flow.step, 0);
  // Finishing or going back from step 0 is a no-op.
  assert.equal(flowFinished(flow, {}).step, 0);
  assert.equal(flowBack(flow).step, 0);
  flow = flowSetAccount(flow, '+390200000001');
  assert.equal(flow.account, '+390200000001');
  flow = flowAuthorizeStart(flow);
  assert.equal(flow.busy, true);
  // A second authorize while busy changes nothing.
  assert.equal(flowAuthorizeStart(flow).busy, true);
  flow = flowAuthorized(flow, { connectionKey: 'k', status: 'active', importable: true });
  assert.equal(flow.step, 1);
  assert.equal(flow.busy, false);
  flow = flowChooseHistory(flow, false);
  assert.equal(flow.history, false);
  flow = flowFinishStart(flow);
  assert.equal(flow.busy, true);
  flow = flowFinished(flow, { started: true });
  assert.equal(flow.step, 2);
  assert.equal(flowBack(flow).step, 2);
  const failed = flowFail(createConnectFlow({ channel: 'sms', adapter }), '');
  assert.equal(failed.error, 'La richiesta non è riuscita.');
});

function stubClient({ schema = null, sync = null, calls = null } = {}) {
  const seen = calls ?? [];
  return {
    calls: seen,
    async request(path, options = {}) {
      seen.push({ path, body: options.body });
      if (path === '/api/schema') {
        if (schema === null) throw new Error('schema down');
        return schema;
      }
      if (path.startsWith('/api/connectors?')) return sync ?? { connectors: [] };
      if (path === '/api/connectors/authorize') {
        return { duplicate: false, connection: { connectionKey: 'ck', status: 'active', importable: true, sync: null } };
      }
      if (path === '/api/connectors/finish') {
        return { started: options.body?.history !== false, resumed: false };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
}

const SCHEMA = {
  domains: {
    channels: {
      metadata: {
        channelsContract: 1,
        adapters: [{ name: 'wa-fake', version: 1, label: 'WhatsApp (prova)', channel: 'whatsapp' }],
      },
    },
  },
};

const storageWith = (spaceId) => ({
  getItem: () => spaceId,
  setItem: () => {},
  removeItem: () => {},
});

test('unconnected connectors show the what-happens preview', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  const text = mount.textContent;
  assert.ok(text.includes('Connettori'));
  assert.ok(text.includes('Cosa succede quando colleghi:'));
  assert.ok(text.includes('mai uniti da soli'));
  const open = mount.findAll('button').find((node) => node.textContent === 'Collega in 3 passi');
  assert.ok(open, 'an unconnected connector offers the guided flow');
});

test('no composed channels renders an honest note', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: { domains: {} }, sync: { connectors: [] } });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  assert.ok(mount.textContent.includes('non sono composti'));
});

test('hostile server text stays text', async () => {
  const hostile = {
    domains: {
      channels: {
        metadata: {
          channelsContract: 1,
          adapters: [
            { name: 'x', version: 1, label: '<script>alert(1)</script>', channel: 'whatsapp' },
            { name: 'mail', version: 1, label: 'Email', channel: 'email' },
          ],
        },
      },
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    schema: hostile,
    sync: { connectors: [{ connectionKey: '"><img src=x>', channel: 'email', status: 'active', importable: false, sync: null }] },
  });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  assert.ok(mount.textContent.includes('"><img src=x>'));
  mount.findAll('button').find((node) => node.textContent === 'Collega in 3 passi').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes('<script>alert(1)</script>'));
});

test('the wizard drives authorize, sync choice and finish', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  const navigated = [];
  await createConnectorsView({
    doc, mount, client, navigate: (hash) => navigated.push(hash), storage: storageWith('presti'),
  }).render();

  mount.findAll('button').find((node) => node.textContent === 'Collega in 3 passi').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes('1 · Autorizza'));

  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'account');
  input.value = '+390200000001';
  mount.findAll('button').find((node) => node.textContent === 'Autorizza e collega').dispatch('click');
  await flush(10);
  const authorized = client.calls.find((call) => call.path === '/api/connectors/authorize');
  assert.deepEqual(authorized.body, {
    spaceId: 'presti', channel: 'whatsapp', account: '+390200000001', adapter: 'wa-fake', adapterVersion: 1,
  });
  assert.ok(mount.textContent.includes('2 · Cosa sincronizzare'));

  mount.findAll('button').find((node) => node.textContent === 'Concludi il collegamento').dispatch('click');
  await flush(10);
  const finished = client.calls.find((call) => call.path === '/api/connectors/finish');
  assert.deepEqual(finished.body, { spaceId: 'presti', connectionKey: 'ck', history: true });
  assert.ok(mount.textContent.includes('è collegato. Fatto.'));
  assert.ok(mount.textContent.includes('mai uniti da soli'));
});
