import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createChannelOperations } from '../packages/channels/src/operations.js';
import {
  createFixtureChannelAdapter,
  fixtureEventBody,
} from '../packages/channels/src/fixture.js';
import { buildChannelConnectionActions, createChannelsPackage } from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Space sync activity (backlog:8fdbc5f21cd0, BO-F1-03 "Stato sync"): the
 * counters and the live feed the screen renders — per-connection inbox
 * tallies from the real `channel-inbox-event` rows, open dead letters
 * from the real `channel-dead-letter` rows, the observed direction, a
 * health verdict, the same import progress `readInitialImport` returns,
 * the newest-first feed and the `needsFix` total for the badge — plus
 * "Sincronizza ora", one bounded pull through the fake adapter. On real
 * sqlite, real module services, the real durable-job store and worker.
 */

const SPACE = 'presti-sync-activity';
const ACCOUNT_A = '+390200000011';
const ACCOUNT_B = '+390200000022';
const SECRET_REF = 'vault://kit/channel-sync-activity';
const SECRET = 'kit-secret-activity-1';
const ACTOR = { type: 'user', id: 'channel-sync-activity-kit' };

function setup(options = {}) {
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  if (options.noHistory) delete definition.historyImport;
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: options.tenantId ?? 'channel-activity-kit',
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  return { harness, api };
}

async function registeredActive(harness, space = SPACE, account = ACCOUNT_A) {
  const reg = await harness.register(space, {
    channel: 'whatsapp', account, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function historySeed(count, at, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `evt-act-${offset + index + 1}`,
    subject: `chat-act-${offset + index + 1}`,
    seq: offset + index + 1,
    at,
  }));
}

test('an empty space reads zero activity, never null', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const activity = harness.ops.readSyncActivity({ spaceId: 'no-such-space' });
  assert.deepEqual(activity.connections, []);
  assert.deepEqual(activity.feed, []);
  assert.equal(activity.needsFix, 0);
  assert.equal(activity.lastActivityAt, null);
  await assert.rejects(
    (async () => harness.ops.readSyncActivity({ spaceId: SPACE, feedLimit: 0 }))(),
    (error) => error.message.includes('feed limit'),
  );
  await assert.rejects(
    (async () => harness.ops.readSyncActivity({ spaceId: SPACE, feedLimit: 101 }))(),
    (error) => error.message.includes('feed limit'),
  );
});

test('counters, direction and health read the real inbox and dead-letter rows', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);

  const newer = fixtureEventBody({ id: 'evt-act-n', subject: 'chat-act-1', seq: 2 });
  const applied = await harness.ingest(SPACE, { connectionKey: key, rawBody: newer, headers: harness.faults.sign(newer) });
  assert.equal(applied.effect, 'applied');
  const older = fixtureEventBody({ id: 'evt-act-o', subject: 'chat-act-1', seq: 1 });
  const ignored = await harness.ingest(SPACE, { connectionKey: key, rawBody: older, headers: harness.faults.sign(older) });
  assert.equal(ignored.effect, 'ignored');
  const noSubject = fixtureEventBody({ id: 'evt-act-q', subject: '', seq: 1 });
  const quarantined = await harness.ingest(SPACE, { connectionKey: key, rawBody: noSubject, headers: harness.faults.sign(noSubject) });
  assert.equal(quarantined.effect, 'quarantined');

  api.setMode('refuse');
  const queued = await harness.queue(SPACE, {
    connectionKey: key, message: { to: ACCOUNT_A, text: 'doomed' }, messageKey: 'm-act-doom',
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  assert.equal(harness.letters(SPACE, 'open').length, 1);

  const pending = await harness.register(SPACE, {
    channel: 'whatsapp', account: ACCOUNT_B, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });

  const activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  assert.equal(activity.connections.length, 2);
  const live = activity.connections.find((entry) => entry.connectionKey === key);
  assert.equal(live.direction, 'both');
  assert.equal(live.health, 'attention');
  assert.equal(live.needsFix, 2);
  assert.deepEqual(
    { received: live.inbox.received, applied: live.inbox.applied, quarantined: live.inbox.quarantined, ignored: live.inbox.ignored },
    { received: 3, applied: 1, quarantined: 1, ignored: 1 },
  );
  assert.equal(typeof live.inbox.lastReceivedAt, 'string');
  assert.equal(live.outbox.openDeadLetters, 1);
  assert.equal(typeof live.outbox.lastFailedAt, 'string');
  assert.equal(live.importable, true);

  const waiting = activity.connections.find((entry) => entry.connectionKey === pending.connection.sourceKey);
  assert.equal(waiting.direction, null);
  assert.equal(waiting.health, 'idle');
  assert.equal(waiting.needsFix, 0);

  assert.equal(activity.needsFix, 2);
  assert.equal(activity.feed.length, 4);
  const directions = activity.feed.map((entry) => entry.direction).sort();
  assert.deepEqual(directions, ['in', 'in', 'in', 'out']);
  const kinds = activity.feed.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ['applied', 'dead-letter', 'ignored', 'quarantined']);
  for (let index = 1; index < activity.feed.length; index += 1) {
    assert.ok(activity.feed[index - 1].at >= activity.feed[index].at, 'the feed reads newest first');
  }
  for (const entry of activity.feed) {
    assert.ok(!('subject' in entry), 'the feed carries no subject');
    assert.ok(!('payload' in entry), 'the feed carries no payload');
  }
  const letter = activity.feed.find((entry) => entry.direction === 'out');
  assert.equal(letter.code, 'CHANNEL_SEND_REFUSED');
  const dumped = JSON.stringify(activity.feed);
  assert.ok(!dumped.includes('doomed'), 'the feed carries no message text');
  assert.ok(!dumped.includes(SECRET), 'the feed carries no secret');
  assert.equal(activity.lastActivityAt, activity.feed.map((entry) => entry.at).sort().at(-1));
});

test('"Sincronizza ora" pulls the provider past page by page through the fake adapter', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const hour = 3600 * 1000;
  const base = Date.now();
  api.seedHistory(historySeed(3, new Date(base - 3 * hour).toISOString()));

  const first = await harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: key, limit: 2, actor: ACTOR });
  assert.equal(first.started, true);
  assert.equal(first.done, false);
  assert.equal(first.page.imported, 2);
  assert.equal(first.page.duplicates, 0);

  let activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  const running = activity.connections.find((entry) => entry.connectionKey === key);
  assert.equal(running.sync.status, 'running');
  assert.equal(running.health, 'ok');

  api.seedHistory([
    ...historySeed(3, new Date(base - 3 * hour).toISOString()),
    ...historySeed(1, new Date(base).toISOString(), 3),
  ]);
  const second = await harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: key, actor: ACTOR });
  assert.equal(second.started, false);
  assert.equal(second.done, true);
  assert.equal(second.page.imported, 2);
  assert.equal(harness.inbox(SPACE).length, 4);

  const third = await harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: key, actor: ACTOR });
  assert.equal(third.done, true);
  assert.equal(third.page, null);
  assert.equal(harness.inbox(SPACE).length, 4, 'a finished past is never re-imported');

  activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  const done = activity.connections.find((entry) => entry.connectionKey === key);
  assert.equal(done.sync.status, 'done');
  assert.equal(done.health, 'ok');
  assert.equal(done.inbox.received, 4);
});

test('"Sincronizza ora" refuses honestly where no pull exists', async (t) => {
  const { harness } = setup({ noHistory: true, tenantId: 'channel-activity-nohist' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await assert.rejects(
    harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: key, actor: ACTOR }),
    (error) => error.code === 'CHANNEL_HISTORY_UNAVAILABLE',
  );
  await assert.rejects(
    harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: 'no-such-connection', actor: ACTOR }),
    (error) => error.code === 'CHANNEL_CONNECTION_UNKNOWN',
  );
  await assert.rejects(
    harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: key }),
    (error) => error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  await assert.rejects(
    harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: key, limit: 0, actor: ACTOR }),
    (error) => error.message.includes('history page limit'),
  );

  const pendingHarness = setup({ tenantId: 'channel-activity-pending' });
  t.after(() => pendingHarness.harness.close());
  const reg = await pendingHarness.harness.register(SPACE, {
    channel: 'whatsapp', account: ACCOUNT_A, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await assert.rejects(
    pendingHarness.harness.ops.syncNowChannel({ spaceId: SPACE, connectionKey: reg.connection.sourceKey, actor: ACTOR }),
    (error) => error.code === 'CHANNEL_CONNECTION_NOT_ACTIVE',
  );
});

test('the package manifest publishes the sync activity reads beside the sync state', () => {
  const pkg = createChannelsPackage();
  const methods = pkg.operations.map((op) => op.appMethod);
  assert.ok(methods.includes('readSyncState'), 'the banner read stays published');
  assert.ok(methods.includes('readSyncActivity'), 'the screen read is published');
  assert.ok(methods.includes('syncNowChannel'), 'the pull button is published');
  assert.equal(typeof createChannelOperations, 'function');
});

const CHANNEL_MANIFESTS = [
  'channel-connection.module.json',
  'channel-inbox-event.module.json',
  'channel-dead-letter.module.json',
  'channel-import-state.module.json',
  'channel-import-outcome.module.json',
];

test('GET /api/connectors/activity and POST /api/connectors/sync-now expose the screen reads', async (t) => {
  const { createHttpServer } = await import('../apps/server/src/index.js');
  const { boot, project } = await import('./helpers/customer-data-project.js');
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');

  const root = project(t, {});
  for (const manifest of CHANNEL_MANIFESTS) {
    const applied = spawnSync(process.execPath,
      ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'),
        'module', 'create', join(root, 'packages/channels/modules', manifest), '--apply',
        '--root', root],
      { encoding: 'utf8', cwd: root });
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  const secret = 'sync-activity-http-secret';
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createChannelsPackage } from '../../channels/src/index.js';",
    "import { createFixtureChannelAdapter } from '../../channels/src/fixture.js';",
    `const fixture = createFixtureChannelAdapter({ channel: 'whatsapp', secret: '${secret}' });`,
    'export const fixtureApi = fixture.api;',
    'export const generatedDomains = [',
    '  createChannelsPackage({',
    '    channelAdapters: [fixture.definition],',
    `    resolveSecret: async () => '${secret}',`,
    "    tenantId: 'sync-activity-http',",
    '  }),',
    '];',
    '',
  ].join('\n'));
  const dbPath = join(root, 'data', 'sync-activity-http.sqlite');
  const { app, close } = await boot(root, dbPath);
  t.after(() => close());

  const reg = await app.registerChannelConnection({
    spaceId: SPACE, channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'fixture-channel', adapterVersion: 1,
    secretRef: 'vault://activity/http', actor: ACTOR,
  });
  const actions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  const service = app.modules.get('channel-connection').service;
  const record = service.listWhere({ spaceId: SPACE, sourceKey: reg.connection.sourceKey })[0];
  await actions['activate-connection'].execute({
    record,
    input: { reason: 'http exposure proof' },
    actor: ACTOR,
    modules: app.modules,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: ACTOR }),
    now: () => new Date().toISOString(),
  });

  const { fixtureApi } = await import(join(root, 'packages/domains/generated/index.js'));
  fixtureApi.seedHistory(historySeed(2, new Date(Date.now() - 3600 * 1000).toISOString()));

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
    'x-actor-id': 'sync-activity-http',
  };

  const pulling = await fetch(`${base}/api/connectors/sync-now`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ spaceId: SPACE, connectionKey: reg.connection.sourceKey }),
  });
  assert.equal(pulling.status, 200);
  const pulled = await pulling.json();
  assert.equal(pulled.started, true);
  assert.equal(pulled.done, true);
  assert.equal(pulled.page.imported, 2);

  const reading = await fetch(
    `${base}/api/connectors/activity?spaceId=${encodeURIComponent(SPACE)}&feedLimit=5`,
  );
  assert.equal(reading.status, 200);
  const activity = await reading.json();
  assert.equal(activity.needsFix, 0);
  assert.equal(activity.connections.length, 1);
  assert.equal(activity.connections[0].sync.status, 'done');
  assert.equal(activity.feed.length, 2);
  assert.ok(activity.feed.every((entry) => entry.direction === 'in'));
});
