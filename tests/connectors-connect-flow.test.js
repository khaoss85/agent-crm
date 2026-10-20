import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildChannelConnectionActions } from '../packages/channels/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * Backoffice BO-F1-02 — collegare un connettore in 3 passi.
 *
 * Acceptance under test: duplicates found at connect time become
 * `duplicate-candidate` rows, never silent merges. The test drives the exact
 * path the Connettori screen drives (register → activate → start initial
 * import → advance) against the real reconciliation: a WhatsApp past whose
 * sender carries Bruno's handle with Anna's email is conflicting evidence
 * about one sender, so it lands as one unresolved candidate naming both
 * contacts, and both contacts keep their own identities.
 */

const SPACE = 'presti';
const ACCOUNT = '+390200000001';
const SECRET = 'connect-flow-e2e-secret';
const ACTOR = { type: 'user', id: 'connect-flow-e2e' };

const ANNA_EMAIL = 'anna@prestigroup.example';
const BRUNO_HANDLE = '+393330000001';
const BRUNO_EMAIL = 'bruno@prestigroup.example';

const CHANNEL_MANIFESTS = [
  'channel-connection.module.json',
  'channel-inbox-event.module.json',
  'channel-dead-letter.module.json',
  'channel-import-state.module.json',
  'channel-import-outcome.module.json',
];

async function scene(t, tag) {
  const root = project(t, {});
  const { spawnSync } = await import('node:child_process');
  for (const manifest of CHANNEL_MANIFESTS) {
    const applied = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'),
        'module', 'create', join(root, 'packages/channels/modules', manifest), '--apply',
        '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    "import { createChannelsPackage } from '../../channels/src/index.js';",
    "import { createFixtureChannelAdapter } from '../../channels/src/fixture.js';",
    'const customerData = createCustomerDataPackage();',
    `const fixture = createFixtureChannelAdapter({ channel: 'whatsapp', secret: '${SECRET}' });`,
    'export const fixtureApi = fixture.api;',
    'export const generatedDomains = [',
    '  customerData,',
    '  createChannelsPackage({',
    '    channelAdapters: [fixture.definition],',
    `    resolveSecret: async () => '${SECRET}',`,
    "    tenantId: 'connect-flow-e2e',",
    '    customerData,',
    '  }),',
    '];',
    '',
  ].join('\n'));
  const dbPath = join(root, 'data', `${tag}.sqlite`);
  const context = await boot(root, dbPath);
  const domains = await import(`${join(root, 'packages/domains/generated/index.js')}`);
  return { root, dbPath, ...context, fixtureApi: domains.fixtureApi };
}

async function activate(app, spaceId, connectionKey) {
  const service = app.modules.get('channel-connection').service;
  const record = service.listWhere({ spaceId, sourceKey: connectionKey })[0];
  assert.ok(record, 'connection registered');
  const actions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  await actions['activate-connection'].execute({
    record,
    input: { reason: 'connected from the guided Connectors flow (BO-F1-02)' },
    actor: ACTOR,
    modules: app.modules,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: ACTOR }),
    now: () => new Date().toISOString(),
  });
}

function contactsCount(app) {
  return app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
}

function identitiesOf(app, contactId) {
  return app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId, status: 'active' });
}

test('connecting a channel files conflicting senders as candidates, never merging', async (t) => {
  const { app, fixtureApi, close } = await scene(t, 'connect-flow-duplicates');
  t.after(() => close());

  // Passo 1 · autorizza: register the space account, then activate it.
  const reg = await app.registerChannelConnection({
    spaceId: SPACE, channel: 'whatsapp', account: ACCOUNT,
    adapter: 'fixture-channel', adapterVersion: 1,
    secretRef: 'vault://presti/whatsapp', actor: ACTOR,
  });
  assert.equal(reg.duplicate, false);
  const key = reg.connection.sourceKey;
  await activate(app, SPACE, key);

  // Two contacts already known: Anna by email, Bruno by WhatsApp handle.
  const anna = await app.resolveChannelSender({
    channel: 'email', handle: ANNA_EMAIL,
    firstName: 'Anna', lastName: 'Bianchi', actor: ACTOR,
  });
  assert.equal(anna.outcome, 'created');
  const bruno = await app.resolveChannelSender({
    channel: 'whatsapp', handle: BRUNO_HANDLE, email: BRUNO_EMAIL,
    firstName: 'Bruno', lastName: 'Neri', actor: ACTOR,
  });
  assert.equal(bruno.outcome, 'created');

  // Passo 2+3 · cosa sincronizzare + fatto: start the progressive import of
  // a past whose sender carries Bruno's handle with Anna's email.
  const at = new Date(Date.now() - 3600 * 1000).toISOString();
  fixtureApi.seedHistory([{
    id: 'conn-evt-1', subject: 'chat-conn-1', seq: 1, at,
    sender: { handle: BRUNO_HANDLE, email: ANNA_EMAIL },
  }]);
  const started = await app.startInitialImport({ spaceId: SPACE, connectionKey: key, actor: ACTOR });
  assert.equal(started.started, true);

  const page = await app.advanceInitialImport({ spaceId: SPACE, connectionKey: key, limit: 10 });
  assert.equal(page.done, true);
  assert.equal(page.page.unresolved, 1, 'the conflicting sender stays unresolved');

  const candidates = app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
  assert.equal(candidates.length, 1, 'the conflict became exactly one candidate for a human');
  const pair = [`${candidates[0].leftResource}:${candidates[0].leftId}`, `${candidates[0].rightResource}:${candidates[0].rightId}`].sort();
  assert.deepEqual(pair, [`contact:${anna.contact.id}`, `contact:${bruno.contact.id}`].sort());

  assert.equal(contactsCount(app), 2, 'no contact was fused or removed by the connect');
  const brunoIdentities = identitiesOf(app, bruno.contact.id);
  assert.equal(brunoIdentities.length, 1, 'no identity was re-linked by the conflict');
  assert.equal(brunoIdentities[0].externalId, BRUNO_HANDLE);
  const annaIdentities = identitiesOf(app, anna.contact.id);
  assert.equal(annaIdentities.length, 1, 'no identity was re-linked by the conflict');

  const progress = await app.readInitialImport({ spaceId: SPACE, connectionKey: key });
  assert.equal(progress.status, 'done');
  assert.equal(progress.unresolvedContacts, 1, 'the fatto step can report what still needs a human');
});

test('POST /api/connectors/finish drives the history import to done', async (t) => {
  // The fatto step promises past history in pages: with no scheduler
  // advancing running imports, finish itself must pull to completion —
  // otherwise the wizard reports background progress that never arrives.
  const { app, fixtureApi, close } = await scene(t, 'connect-flow-finish-http');
  t.after(() => close());
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'content-type': 'application/json',
    'x-actor-type': 'user',
    'x-actor-id': 'connect-flow-finish-http',
  };

  const reg = await app.registerChannelConnection({
    spaceId: SPACE, channel: 'whatsapp', account: ACCOUNT,
    adapter: 'fixture-channel', adapterVersion: 1,
    secretRef: 'vault://presti/whatsapp', actor: ACTOR,
  });
  await activate(app, SPACE, reg.connection.sourceKey);

  const at = new Date(Date.now() - 3600 * 1000).toISOString();
  fixtureApi.seedHistory([
    { id: 'conn-evt-http-1', subject: 'chat-conn-http-1', seq: 1, at, sender: { handle: BRUNO_HANDLE } },
    { id: 'conn-evt-http-2', subject: 'chat-conn-http-2', seq: 2, at, sender: { handle: BRUNO_HANDLE } },
  ]);

  const response = await fetch(`${base}/api/connectors/finish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ spaceId: SPACE, connectionKey: reg.connection.sourceKey, history: true }),
  });
  assert.equal(response.status, 200);
  const finished = await response.json();
  assert.equal(finished.started, true);
  assert.equal(finished.done, true);
  assert.equal(finished.import?.status, 'done');
  assert.equal(finished.import?.importedEvents, 2, 'finish pulled every page, not just the cursor');
});
