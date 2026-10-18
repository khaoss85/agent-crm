import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildChannelConnectionActions } from '../packages/channels/src/index.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * Initial history import against the real reconciliation path
 * (backlog:66282d13d81c): the composed application wires the channels
 * package beside customer-data with the created `channel-sender@1`
 * capability, a Gmail past imports page by page, and every sender becomes
 * or names its contact through `external-identity` — no second identity
 * store, no duplicate on resume or restart.
 *
 * The acceptance's own shape: Gmail threads of the last 90 days, paged and
 * resumable, contacts reconciled by normalized email, progress readable,
 * counts exact at the end.
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const SECRET = 'gmail-import-e2e-secret';
const ACTOR = { type: 'user', id: 'import-e2e' };
const HOUR = 3600 * 1000;

const CHANNEL_MANIFESTS = [
  'channel-connection.module.json',
  'channel-inbox-event.module.json',
  'channel-dead-letter.module.json',
  'channel-import-state.module.json',
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
    "import { createGmailChannelAdapter } from '../../channels/src/gmail.js';",
    'const customerData = createCustomerDataPackage();',
    `const gmail = createGmailChannelAdapter({ mailbox: '${MAILBOX}', secret: '${SECRET}' });`,
    'const channelSender = customerData.capabilities.find((entry) => entry?.name === \'channel-sender\' && entry?.version === 1);',
    'if (!channelSender) throw new Error(\'customer-data offers no channel-sender@1\');',
    'export const gmailApi = gmail.api;',
    'export const generatedDomains = [',
    '  customerData,',
    '  createChannelsPackage({',
    '    channelAdapters: [gmail.definition],',
    `    resolveSecret: async () => '${SECRET}',`,
    "    tenantId: 'import-e2e',",
    '    channelSender,',
    '  }),',
    '];',
    '',
  ].join('\n'));
  const dbPath = join(root, 'data', `${tag}.sqlite`);
  const context = await boot(root, dbPath);
  const domains = await import(`${join(root, 'packages/domains/generated/index.js')}`);
  // No t.after close here: the restart test closes the first boot by hand,
  // like tests/customer-data-faults.test.js does.
  return { root, dbPath, ...context, gmailApi: domains.gmailApi };
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
    input: { reason: 'e2e import' },
    actor: ACTOR,
    modules: app.modules,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: ACTOR }),
    now: () => new Date().toISOString(),
  });
}

function seedMailbox(gmailApi, at) {
  gmailApi.seedMailbox([
    { id: 'gmail-e2e-1', threadId: 'thread-e2e-A', from: 'anna@example.com', internalDateMs: at },
    { id: 'gmail-e2e-2', threadId: 'thread-e2e-B', from: 'bruno@example.com', internalDateMs: at + 1000 },
    { id: 'gmail-e2e-3', threadId: 'thread-e2e-A', from: 'anna@example.com', internalDateMs: at + 2000 },
    { id: 'gmail-e2e-4', threadId: 'thread-e2e-C', from: MAILBOX, to: MAILBOX, internalDateMs: at + 3000 },
  ]);
}

test('a Gmail past imports page by page and every sender names one contact', async (t) => {
  const { app, gmailApi, close } = await scene(t, 'import-reconcile');
  t.after(() => close());
  const at = Date.now() - HOUR;
  seedMailbox(gmailApi, at);

  const reg = await app.registerChannelConnection({
    spaceId: SPACE, channel: 'email', account: MAILBOX,
    adapter: 'gmail-api', adapterVersion: 1, secretRef: 'vault://presti/gmail-a', actor: ACTOR,
  });
  assert.equal(reg.duplicate, false);
  const key = reg.connection.sourceKey;
  await activate(app, SPACE, key);

  const started = await app.startInitialImport({ spaceId: SPACE, connectionKey: key, actor: ACTOR });
  assert.equal(started.started, true);
  const windowMs = Date.now() - Date.parse(started.state.windowStart);
  assert.ok(
    windowMs >= 90 * 24 * HOUR - 5 * 60 * 1000 && windowMs <= 90 * 24 * HOUR + 5 * 60 * 1000,
    `the import covers the Gmail 90-day window, got ${windowMs}ms`,
  );

  const first = await app.advanceInitialImport({ spaceId: SPACE, connectionKey: key, limit: 2 });
  assert.equal(first.done, false);
  assert.equal(first.page.imported, 2);
  const progress = await app.readInitialImport({ spaceId: SPACE, connectionKey: key });
  assert.equal(progress.status, 'running');
  assert.equal(progress.importedEvents, 2);

  const second = await app.advanceInitialImport({ spaceId: SPACE, connectionKey: key, limit: 2 });
  assert.equal(second.done, true);
  assert.equal(second.state.importedEvents, 4);
  assert.equal(second.state.createdContacts, 2);
  assert.equal(second.state.matchedContacts, 1);
  assert.equal(second.state.unresolvedContacts, 0);
  assert.ok(second.state.finishedAt);

  const contacts = app.database.raw.prepare('SELECT id, email FROM contacts ORDER BY email').all();
  assert.deepEqual(contacts.map((row) => row.email), ['anna@example.com', 'bruno@example.com']);
  const identities = app.modules.get('external-identity').service
    .listWhere({ system: 'email', status: 'active' });
  assert.equal(identities.length, 2, 'one email identity per contact, never a duplicate');
  const anna = contacts.find((row) => row.email === 'anna@example.com');
  const profile = await app.readCustomerProfile({ resource: 'contact', id: anna.id });
  assert.ok(
    profile.externalIdentities.some((identity) => identity.system === 'email' && identity.externalId === 'anna@example.com'),
    'the card carries the reconciled email identity',
  );
  const echo = app.modules.get('channel-inbox-event').service.listWhere({ providerEventId: 'gmail-e2e-4' });
  assert.equal(echo.length, 1);
  assert.equal(echo[0].effect, 'quarantined', 'our own sent copy stays evidence, never a customer');
});

test('an app restart mid-import resumes from the stored cursor with no duplicate', async (t) => {
  // The first boot is closed by hand mid-test (like the faults suite's
  // restart test): nothing about the run may live in the closed process.
  const first = await scene(t, 'import-restart');
  const at = Date.now() - HOUR;
  seedMailbox(first.gmailApi, at);
  const reg = await first.app.registerChannelConnection({
    spaceId: SPACE, channel: 'email', account: MAILBOX,
    adapter: 'gmail-api', adapterVersion: 1, secretRef: 'vault://presti/gmail-b', actor: ACTOR,
  });
  const key = reg.connection.sourceKey;
  await activate(first.app, SPACE, key);
  await first.app.startInitialImport({ spaceId: SPACE, connectionKey: key, actor: ACTOR });
  const page = await first.app.advanceInitialImport({ spaceId: SPACE, connectionKey: key, limit: 2 });
  assert.equal(page.done, false);
  await first.close();

  // A restarted worker opens the same database: nothing about the run
  // lived in the closed process.
  const again = await boot(first.root, first.dbPath);
  t.after(() => again.close());
  const resumed = await again.app.advanceInitialImport({ spaceId: SPACE, connectionKey: key, limit: 2 });
  assert.equal(resumed.done, true);
  assert.equal(resumed.state.importedEvents, 4);
  assert.equal(resumed.state.createdContacts, 2);
  assert.equal(resumed.state.matchedContacts, 1);
  const contacts = again.app.database.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  assert.equal(contacts, 2, 'two senders, two contacts — the restart created nothing twice');
  const rows = again.app.modules.get('channel-inbox-event').service.listWhere({ spaceId: SPACE });
  assert.equal(rows.length, 4, 'four messages, four rows');
});
