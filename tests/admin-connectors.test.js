import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTOR_BADGES,
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
  flowResumeImport,
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
 * Italian label and a badge; every channel is one Canali card row like the
 * Google rows above it (badge, bold name, one muted line, status pill,
 * Collega), with no underlined link and no bullet list in the list; the row
 * itself opens the detail; there is no Spazio field and no Ricarica button;
 * the status mapping is honest (no adapter → non-disponibile, no row →
 * da-collegare); the flow advances only autorizza → sincronizza → fatto;
 * the screen drives the three server calls; hostile server text stays text.
 * A channels package the server does not compose renders an honest note,
 * never a blank page.
 */

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

test('catalog covers every channel with a what-happens preview', () => {
  const channels = CONNECTOR_CATALOG.map((entry) => entry.channel).sort();
  assert.deepEqual(channels, ['email', 'facebook', 'instagram', 'site-form', 'sms', 'telegram', 'tiktok', 'voice', 'whatsapp']);
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

test('Personalizzazione opens the BO-F4-01 screen (connectors stay at #/connettori)', () => {
  const area = SETTINGS_AREAS.find((row) => row.id === 'personalizzazione');
  assert.equal(area.route, '#/personalizzazione');
  assert.equal(parseModuleRoute('#/connettori').view, 'connectors');
  // BO-F5-03: the detail lives one level down; an unknown slug still reaches
  // the detail view, which renders an honest note without fetching for it.
  assert.deepEqual(parseModuleRoute('#/connettori/whatsapp'), { view: 'connector-detail', channel: 'whatsapp' });
  assert.deepEqual(parseModuleRoute('#/connettori/altro'), { view: 'connector-detail', channel: 'altro' });
  assert.equal(parseModuleRoute('#/connettori/a/b').view, 'invalid');
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

test('resume continues a partial import from fatto without restarting it', () => {
  const adapter = { name: 'wa', version: 1 };
  const step1 = flowAuthorized(createConnectFlow({ channel: 'whatsapp', adapter }), { connectionKey: 'k' });
  assert.equal(step1.step, 1);
  const step2 = flowFinished(step1, { started: true, done: false });
  assert.equal(step2.step, 2);
  // A stray finish onto a settled fatto step changes nothing.
  assert.deepEqual(flowFinished(step2, { started: 'stray' }).finish, { started: true, done: false });
  const resuming = flowResumeImport(step2);
  assert.equal(resuming.busy, true);
  assert.equal(resuming.step, 2);
  // Resuming from step 0 changes nothing, and resuming twice stays busy.
  assert.equal(flowResumeImport(createConnectFlow({ channel: 'whatsapp', adapter })).busy, false);
  assert.equal(flowResumeImport(resuming).busy, true);
  const relanded = flowFinished(resuming, { started: true, done: true });
  assert.equal(relanded.step, 2);
  assert.equal(relanded.busy, false);
  assert.equal(relanded.finish?.done, true);
});

function stubBody(options) {
  // Through the submission controller the transport JSON-encodes the body,
  // like the real module client: accept either shape, like the server does.
  const raw = options.body;
  if (typeof raw === 'string') {
    try { return raw === '' ? {} : JSON.parse(raw); } catch { return raw; }
  }
  return raw ?? {};
}

function stubClient({ schema = null, sync = null, calls = null, authorize = null, finish = null, profile = null } = {}) {
  const seen = calls ?? [];
  return {
    calls: seen,
    async request(path, options = {}) {
      const body = stubBody(options);
      seen.push({ path, body });
      if (path === '/api/schema') {
        if (schema === null) throw new Error('schema down');
        return schema;
      }
      if (path.startsWith('/api/connectors?')) return sync ?? { connectors: [] };
      if (path === '/api/profile') {
        if (profile === null) throw new Error('profile down');
        return profile;
      }
      if (path === '/api/connectors/authorize') {
        if (typeof authorize === 'function') return authorize(body);
        return { duplicate: false, connection: { connectionKey: 'ck', status: 'active', importable: true, sync: null } };
      }
      if (path === '/api/connectors/finish') {
        if (typeof finish === 'function') return finish(body);
        return { started: body?.history !== false, resumed: false };
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

test('every channel is one Canali card row: badge, name, line, pill, Collega', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const full = {
    domains: { channels: { metadata: { channelsContract: 1,
      adapters: CONNECTOR_CATALOG.map((entry) => ({ name: `${entry.channel}-fake`, version: 1, channel: entry.channel })) } } },
  };
  const client = stubClient({ schema: full, sync: { connectors: [] } });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  const card = mount.findAll('section').find((node) => node.getAttribute('data-section') === 'canali');
  assert.ok(card, 'channels render inside the Canali card');
  assert.ok(card.textContent.includes('Canali'));
  for (const entry of CONNECTOR_CATALOG) {
    const badge = CONNECTOR_BADGES[entry.channel];
    assert.ok(badge && badge.tile !== '', `${entry.channel} has a badge tile`);
    assert.ok(badge && badge.tint.startsWith('ui-chip-'), `${entry.channel} reuses a timeline tint`);
    const row = card.querySelector(`div[data-channel="${entry.channel}"]`);
    assert.ok(row, `${entry.channel} renders one row`);
    const tile = row.findAll('span').find((node) => node.textContent === badge.tile);
    assert.ok(tile && (tile.getAttribute('class') ?? '').split(/\s+/).includes(badge.tint),
      `${entry.channel} shows its tile with its tint`);
    const name = row.findAll('span').find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-profilo-conn-name'));
    assert.equal(name?.textContent, entry.label, `${entry.channel} names itself in bold`);
    const line = row.findAll('span').find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-profilo-conn-line'));
    assert.ok(line && line.textContent !== '', `${entry.channel} shows one description line`);
    assert.ok(row.textContent.includes('Da collegare'), `${entry.channel} shows its pill`);
    const go = row.findAll('button').find((node) => node.textContent === 'Collega');
    assert.ok(go, `${entry.channel} offers Collega`);
  }
  assert.ok(!card.textContent.includes('Dettaglio '), 'no Dettaglio affordance text in the channel list');
  for (const link of card.findAll('a')) {
    assert.ok((link.getAttribute('class') ?? '').split(/\s+/).includes('bo-conn-open'),
      'every link in the list is a row opener wearing the row words, never a blue link');
  }
  assert.equal(card.findAll('ul').length, 0, 'no bullet list in the channel list');
  assert.equal(card.findAll('li').length, 0, 'no bullet item in the channel list');
});

test('the channels screen has no Spazio field and no Ricarica button', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  assert.equal(mount.findAll('input').filter((node) => node.getAttribute('name') === 'spaceId').length, 0,
    'no Spazio field: the shell picker owns the space');
  assert.equal(mount.findAll('button').filter((node) => node.textContent === 'Ricarica').length, 0,
    'no Ricarica button');
});

test('the row opens the channel detail', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  const navigated = [];
  await createConnectorsView({
    doc, mount, client, navigate: (hash) => navigated.push(hash), storage: storageWith('presti'),
  }).render();
  const card = mount.findAll('section').find((node) => node.getAttribute('data-section') === 'canali');
  assert.ok(card, 'channels render inside the Canali card');
  card.querySelector('div[data-channel="whatsapp"]')?.querySelector('.bo-conn-open')?.dispatch('click');
  assert.deepEqual(navigated, ['#/connettori/whatsapp'], 'the whatsapp row opens its detail');
});

test('a connected row shows Collegato with its account and no Collega', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const full = {
    domains: { channels: { metadata: { channelsContract: 1,
      adapters: [
        { name: 'wa-fake', version: 1, channel: 'whatsapp' },
        { name: 'mail-fake', version: 1, channel: 'email' },
      ] } } },
  };
  const client = stubClient({
    schema: full,
    sync: { connectors: [
      { channel: 'whatsapp', connectionKey: 'ck-wa', status: 'active', account: '+390200000001', importable: true, sync: null },
      { channel: 'email', connectionKey: 'ck-mail', status: 'pending', account: 'info@presti.it', importable: true, sync: null },
    ] },
  });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  const card = mount.findAll('section').find((node) => node.getAttribute('data-section') === 'canali');
  const connected = card.querySelector('div[data-channel="whatsapp"]');
  assert.ok(connected.textContent.includes('Collegato'), 'the active row pills Collegato');
  assert.ok(connected.textContent.includes('Collegato come +390200000001'), 'the active row names its account');
  assert.equal(connected.findAll('button').filter((node) => node.textContent === 'Collega').length, 0,
    'a connected row offers no second Collega');
  const completing = card.querySelector('div[data-channel="email"]');
  assert.ok(completing.textContent.includes('Da completare'), 'the pending row pills Da completare');
  assert.ok(completing.findAll('button').some((node) => node.textContent === 'Collega'),
    'a pending row still offers Collega');
});

test('a channel with no composed adapter pills Non disponibile qui with no Collega', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  const card = mount.findAll('section').find((node) => node.getAttribute('data-section') === 'canali');
  const row = card.querySelector('div[data-channel="instagram"]');
  assert.ok(row.textContent.includes('Non disponibile qui'), 'no adapter reads as non-disponibile');
  assert.equal(row.findAll('button').filter((node) => node.textContent === 'Collega').length, 0,
    'nothing to connect with offers no Collega');
});

test('no composed channels renders an honest note', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: { domains: {} }, sync: { connectors: [] } });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  assert.ok(mount.textContent.includes('non sono composti'));
});

test('Google Calendar and Gmail offer Collega even without composed channels', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: { domains: {} }, profile: { member: {}, connections: { available: true, reason: null,
    items: [{ connector: 'calendar', status: 'disconnected', account: null }, { connector: 'gmail', status: 'connected', account: 'dan@presti.it' }] } } });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  await new Promise((resolve) => setImmediate(resolve));
  const card = mount.findAll('section').find((node) => node.getAttribute('data-section') === 'google-connections');
  assert.ok(card, 'the Google card heads the screen');
  assert.ok(card.textContent.includes('Collegamenti Google'));
  const collega = card.findAll('a').find((node) => node.textContent === 'Collega');
  assert.equal(collega.getAttribute('href'), '../profile/collega?connector=calendar');
  assert.ok(card.textContent.includes('Collegato come dan@presti.it'));
  assert.ok(mount.textContent.includes('non sono composti'), 'the channels note stays honest');
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
    sync: { connectors: [{ connectionKey: 'ck-mail', channel: 'email', status: 'active', account: '"><img src=x>', importable: false, sync: null }] },
  });
  await createConnectorsView({ doc, mount, client, navigate: () => {}, storage: storageWith('presti') }).render();
  // Rows show the account, never the connection key: the hostile account
  // stays text and creates no element.
  assert.ok(mount.textContent.includes('"><img src=x>'));
  assert.equal(mount.findAll('img').length, 0, 'hostile account creates no element');
  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes('<script>alert(1)</script>'));
  assert.equal(mount.findAll('script').length, 0, 'hostile adapter label creates no element');
});

test('the wizard drives authorize, sync choice and finish', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  const navigated = [];
  await createConnectorsView({
    doc, mount, client, navigate: (hash) => navigated.push(hash), storage: storageWith('presti'),
  }).render();

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
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

test('mutations go through the submission controller, never raw', async () => {
  // The shared module client refuses a POST without a submission-owned
  // Idempotency-Key: driving the wizard against such an enforcing client
  // proves authorize and finish travel through bindAdminMutations.
  const doc = createFakeDocument();
  const mount = createMount();
  const inner = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  const enforcing = {
    calls: inner.calls,
    async request(path, options = {}) {
      const method = String(options.method ?? 'GET').toUpperCase();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        && !(typeof options.idempotencyKey === 'string' && options.idempotencyKey !== '')) {
        const error = new Error('Admin mutations require a submission-owned Idempotency-Key');
        error.code = 'ADMIN_SUBMISSION_REQUIRED';
        throw error;
      }
      return inner.request(path, options);
    },
  };
  await createConnectorsView({
    doc, mount, client: enforcing, navigate: () => {}, storage: storageWith('presti'),
  }).render();

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush();
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'account');
  input.value = '+390200000001';
  mount.findAll('button').find((node) => node.textContent === 'Autorizza e collega').dispatch('click');
  await flush(10);
  assert.ok(enforcing.calls.some((call) => call.path === '/api/connectors/authorize'),
    'authorize reaches the server through the submission controller');
  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Concludi il collegamento'),
    'authorize lands on the sync choice');

  mount.findAll('button').find((node) => node.textContent === 'Concludi il collegamento').dispatch('click');
  await flush(10);
  assert.ok(enforcing.calls.some((call) => call.path === '/api/connectors/finish'),
    'finish reaches the server through the submission controller');
  assert.ok(mount.textContent.includes('è collegato. Fatto.'));
});

test('the fatto step reports the import the server actually ran', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    schema: SCHEMA,
    sync: { connectors: [] },
    finish: () => ({
      started: true,
      resumed: false,
      connectionKey: 'ck',
      done: true,
      import: {
        status: 'done', importedEvents: 3, createdContacts: 1, unresolvedContacts: 1,
      },
    }),
  });
  await createConnectorsView({
    doc, mount, client, navigate: () => {}, storage: storageWith('presti'),
  }).render();

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush();
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'account');
  input.value = '+390200000001';
  mount.findAll('button').find((node) => node.textContent === 'Autorizza e collega').dispatch('click');
  await flush(10);
  mount.findAll('button').find((node) => node.textContent === 'Concludi il collegamento').dispatch('click');
  await flush(10);
  assert.ok(mount.textContent.includes('Cronologia completata: 3 eventi importati, 1 contatti creati, 1 da decidere.'));
});

test('the view re-reads the active space on every load', async () => {
  let current = 'presti';
  const storage = {
    getItem: () => current,
    setItem: (key, value) => { current = String(value); },
    removeItem: () => {},
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ schema: SCHEMA, sync: { connectors: [] } });
  const view = createConnectorsView({
    doc, mount, client, navigate: () => {}, storage,
  });
  await view.render();
  // The shell picker switches the space without telling this view.
  current = 'altro-spazio';
  await view.render();
  const loads = client.calls.filter((call) => call.path.startsWith('/api/connectors?'));
  assert.equal(loads.length, 2);
  assert.ok(loads[1].path.includes('altro-spazio'),
    `the second load reads the switched space, got ${loads[1].path}`);

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush();
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'account');
  input.value = '+390200000001';
  mount.findAll('button').find((node) => node.textContent === 'Autorizza e collega').dispatch('click');
  await flush(10);
  const authorized = client.calls.find((call) => call.path === '/api/connectors/authorize');
  assert.equal(authorized.body.spaceId, 'altro-spazio',
    'authorize writes to the switched space, not the construction-time one');
});

test('Collega reactivates a pending row before the sync choice', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const pending = {
    connectionKey: 'ck-pending',
    channel: 'whatsapp',
    account: '+390200000001',
    adapter: 'wa-fake',
    adapterVersion: 1,
    status: 'pending',
    importable: true,
    sync: null,
  };
  const client = stubClient({
    schema: SCHEMA,
    sync: { connectors: [pending] },
    authorize: () => ({
      duplicate: true,
      connection: { ...pending, status: 'active' },
    }),
  });
  await createConnectorsView({
    doc, mount, client, navigate: () => {}, storage: storageWith('presti'),
  }).render();
  assert.ok(mount.textContent.includes('Da completare'));

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush(10);
  const authorized = client.calls.find((call) => call.path === '/api/connectors/authorize');
  assert.deepEqual(authorized.body, {
    spaceId: 'presti',
    channel: 'whatsapp',
    account: '+390200000001',
    adapter: 'wa-fake',
    adapterVersion: 1,
  });
  assert.ok(!client.calls.some((call) => call.path === '/api/connectors/finish'),
    'a non-active connection never finishes without activation');
  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Concludi il collegamento'),
    'reactivation lands on the sync choice, not on fatto');
});

test('Collega refuses a revoked row clearly', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const revoked = {
    connectionKey: 'ck-revoked',
    channel: 'whatsapp',
    account: '+390200000001',
    adapter: 'wa-fake',
    adapterVersion: 1,
    status: 'revoked',
    importable: false,
    sync: null,
  };
  const client = stubClient({
    schema: SCHEMA,
    sync: { connectors: [revoked] },
    authorize: () => {
      const error = new Error('This connection was revoked: register a new account to reconnect');
      error.code = 'CHANNEL_CONNECTION_REVOKED';
      throw error;
    },
  });
  await createConnectorsView({
    doc, mount, client, navigate: () => {}, storage: storageWith('presti'),
  }).render();

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush(10);
  assert.ok(client.calls.some((call) => call.path === '/api/connectors/authorize'));
  assert.ok(!client.calls.some((call) => call.path === '/api/connectors/finish'),
    'a revoked connection never finishes');
  assert.ok(!mount.findAll('button').some((node) => node.textContent === 'Concludi il collegamento'),
    'no sync choice is offered for a revoked connection');
  assert.ok(mount.textContent.includes('revocato'),
    'the refusal names the revoked connection in Italian instead of failing with NOT_ACTIVE');
  assert.ok(mount.textContent.includes('+390200000001'),
    'the refusal names the revoked account so the operator reconnects it');
});

test('the fatto step resumes a partial import instead of promising background progress', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let finishes = 0;
  const client = stubClient({
    schema: SCHEMA,
    sync: { connectors: [] },
    finish: () => {
      finishes += 1;
      return finishes === 1
        ? {
          started: true, resumed: false, connectionKey: 'ck', done: false,
          import: { status: 'running', importedEvents: 4, createdContacts: 1, unresolvedContacts: 1 },
        }
        : {
          started: true, resumed: true, connectionKey: 'ck', done: true,
          import: { status: 'done', importedEvents: 7, createdContacts: 2, unresolvedContacts: 1 },
        };
    },
  });
  await createConnectorsView({
    doc, mount, client, navigate: () => {}, storage: storageWith('presti'),
  }).render();

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush();
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'account');
  input.value = '+390200000001';
  mount.findAll('button').find((node) => node.textContent === 'Autorizza e collega').dispatch('click');
  await flush(10);
  mount.findAll('button').find((node) => node.textContent === 'Concludi il collegamento').dispatch('click');
  await flush(10);
  assert.ok(mount.textContent.includes('Cronologia in corso: 4 eventi importati finora.'),
    'a partial import reports its real progress, never background completion');
  assert.ok(!mount.textContent.includes('in sottofondo'), 'no background promise is rendered');

  mount.findAll('button').find((node) => node.textContent === 'Continua l\u2019importazione').dispatch('click');
  await flush(10);
  assert.equal(finishes, 2, 'continuing re-posts finish, resuming from the stored cursor');
  assert.ok(mount.textContent.includes('Cronologia completata: 7 eventi importati, 2 contatti creati, 1 da decidere.'));
});

test('Collega re-authorizes with the row adapter, not adapters[0]', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const multi = {
    domains: {
      channels: {
        metadata: {
          channelsContract: 1,
          adapters: [
            { name: 'wa-a', version: 1, label: 'WhatsApp A', channel: 'whatsapp' },
            { name: 'wa-b', version: 1, label: 'WhatsApp B', channel: 'whatsapp' },
          ],
        },
      },
    },
  };
  const pending = {
    connectionKey: 'ck-pending-b',
    channel: 'whatsapp',
    account: '+390200000001',
    adapter: 'wa-b',
    adapterVersion: 1,
    status: 'pending',
    importable: true,
    sync: null,
  };
  const client = stubClient({
    schema: multi,
    sync: { connectors: [pending] },
    authorize: () => ({
      duplicate: true,
      connection: { ...pending, status: 'active' },
    }),
  });
  await createConnectorsView({
    doc, mount, client, navigate: () => {}, storage: storageWith('presti'),
  }).render();

  mount.findAll('button').find((node) => node.textContent === 'Collega').dispatch('click');
  await flush(10);
  const authorized = client.calls.find((call) => call.path === '/api/connectors/authorize');
  assert.equal(authorized.body.adapter, 'wa-b',
    'the pending row reactivates under its own adapter instead of conflicting under wa-a');
  assert.equal(authorized.body.adapterVersion, 1);
});
