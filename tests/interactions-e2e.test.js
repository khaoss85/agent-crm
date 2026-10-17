import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { boot } from './helpers/contracts-project.js';
import { assertPackageConforms } from './helpers/package-conformance.js';
import { createInteractionsPackage } from '../packages/interactions/src/index.js';
import { NotFoundError } from '../packages/core/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const ACTOR = { type: 'user', id: 'e2e' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'seed' };

const INTERACTION_MANIFESTS = ['conversation.module.json', 'interaction-message.module.json', 'interaction-call.module.json',
  'conversation-assignment.module.json', 'conversation-read.module.json', 'conversation-thread-key.module.json'];
const WORK_MANIFESTS = ['work-task.module.json', 'work-activity.module.json'];

function cli(root, args) {
  return spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/**
 * A throwaway project composing interactions, with the work package when the
 * timeline has work-activity to read across. `withProbe` adds a consumer that
 * declares both interaction capabilities, so they open exactly as a real
 * consumer opens them — through `app.domains.capability`.
 */
function project(t, { withWork = true, withProbe = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-interactions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const manifest of INTERACTION_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/interactions/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  if (withWork) {
    for (const manifest of WORK_MANIFESTS) {
      const applied = cli(root, ['module', 'create', join(root, 'packages/work/modules', manifest), '--apply']);
      assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
    }
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createInteractionsPackage } from '../../interactions/src/index.js';",
    ...(withWork ? ["import { createWorkPackage } from '../../work/src/index.js';"] : []),
    ...(withProbe ? ["import { definePackage } from '../../core/index.js';"] : []),
    ...(withProbe ? [
      'const timelineProbe = definePackage({',
      "  packageContract: 1, name: 'timeline-probe', version: 1, label: 'Timeline probe',",
      "  description: 'A do-nothing consumer that declares the interaction capabilities so a test can open them through the registry.',",
      '  resources: [], actions: [], policies: [], capabilities: [],',
      '  requires: [',
      "    { package: 'interactions', capability: 'interaction-log', version: 1 },",
      "    { package: 'interactions', capability: 'interaction-timeline', version: 1 },",
      '  ],',
      '});',
    ] : []),
    'export const generatedDomains = [',
    '  createInteractionsPackage(),',
    ...(withWork ? ['  createWorkPackage(),'] : []),
    ...(withProbe ? ['  timelineProbe,'] : []),
    '];',
    '',
  ].join('\n'));
  return root;
}

const interactionsFrom = (root) => import(pathToFileURL(join(root, 'packages/interactions/src/index.js')).href);
const workFrom = (root) => import(pathToFileURL(join(root, 'packages/work/src/follow-up.js')).href);

const run = (app, module, action, recordId, input, actor = ACTOR) =>
  app.runAction({ module, action, recordId, input, actor });

// ---------------------------------------------------------------------------
// Conversations: open, replay, conflict, close
// ---------------------------------------------------------------------------

test('a conversation opens once per source key, replays identically, and closes once', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'conv.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation } = await interactionsFrom(root);

  const request = {
    sourceKey: 'wa:thread:3902000001',
    subject: SUBJECT,
    channel: 'whatsapp',
    remoteHandle: '+3902000001',
    source: SOURCE,
  };
  const first = await openConversation({ modules: app.modules, actor: ACTOR }, request);
  assert.equal(first.replayed, false);
  assert.equal(first.conversation.status, 'open');

  const replay = await openConversation({ modules: app.modules, actor: ACTOR }, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.conversation.id, first.conversation.id);

  // Same key, different channel: refused 409, never adopted.
  await assert.rejects(
    openConversation({ modules: app.modules, actor: ACTOR }, { ...request, channel: 'instagram' }),
    (error) => error.code === 'INTERACTIONS_LOG_CONFLICT' && error.status === 409,
  );

  const closed = await run(app, 'conversation', 'close', first.conversation.id, {});
  assert.equal(closed.result.conversation.status, 'closed');
  await assert.rejects(
    run(app, 'conversation', 'close', first.conversation.id, {}),
    (error) => error.code === 'INVALID_STATE' && error.status === 409,
  );
});

// ---------------------------------------------------------------------------
// Messages: inbound is terminal, outbound walks the lifecycle through actions
// ---------------------------------------------------------------------------

test('messages walk the delivery lifecycle through record actions, never rewrites', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'msg.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, logMessage, readConversationThread } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:life', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });

  const inbound = await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:in:1', conversationId: conversation.id, direction: 'inbound',
    channel: 'whatsapp', body: 'Avete posto sabato?', remoteHandle: '+3902000001',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:01.000Z', source: SOURCE,
  });
  assert.equal(inbound.message.status, 'received');
  // A received message advances nowhere, through the action runtime too.
  await assert.rejects(
    run(app, 'interaction-message', 'advance', inbound.message.id, { to: 'delivered' }),
    (error) => error.code === 'INVALID_STATE' && error.status === 409,
  );

  const outbound = await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:out:1', conversationId: conversation.id, direction: 'outbound',
    channel: 'whatsapp', body: 'Si, alle 18.', teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:02.000Z', source: SOURCE,
  });
  assert.equal(outbound.message.status, 'sent');

  const delivered = await run(app, 'interaction-message', 'advance', outbound.message.id, { to: 'delivered' });
  assert.equal(delivered.result.message.status, 'delivered');
  const read = await run(app, 'interaction-message', 'advance', outbound.message.id, { to: 'read' });
  assert.equal(read.result.message.status, 'read');
  await assert.rejects(
    run(app, 'interaction-message', 'advance', outbound.message.id, { to: 'failed', errorCode: 'X' }),
    (error) => error.code === 'INVALID_STATE' && error.status === 409,
  );

  // The failed path carries its reason code on the row.
  const doomed = await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:out:2', conversationId: conversation.id, direction: 'outbound',
    channel: 'whatsapp', body: 'Ci vediamo!', teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:03.000Z', source: SOURCE,
  });
  await assert.rejects(
    run(app, 'interaction-message', 'advance', doomed.message.id, { to: 'failed' }),
    (error) => /errorCode is required/.test(error.message),
  );
  const failed = await run(app, 'interaction-message', 'advance', doomed.message.id, { to: 'failed', errorCode: 'PROVIDER_500' });
  assert.equal(failed.result.message.status, 'failed');
  assert.equal(failed.result.message.errorCode, 'PROVIDER_500');

  // The thread reads the conversation with its messages oldest-first.
  const thread = await readConversationThread(
    { modules: app.modules, moduleNames: {} }, conversation.id,
  );
  assert.equal(thread.conversation.id, conversation.id);
  assert.deepEqual(thread.entries.map((entry) => entry.status), ['received', 'read', 'failed']);
  assert.equal(await readConversationThread({ modules: app.modules, moduleNames: {} }, 'no-such-id'), null);
});

// ---------------------------------------------------------------------------
// Replay identity: the whole subject envelope, including who owns it
// ---------------------------------------------------------------------------

test('replay identity carries the whole subject envelope: a moved owner is refused', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'owner.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, logMessage, logCall } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:owner', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  const base = {
    sourceKey: 'wa:msg:own:1', conversationId: conversation.id, direction: 'outbound',
    channel: 'whatsapp', body: 'Ti mando il preventivo in serata.', teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:01.000Z', source: SOURCE,
  };
  const first = await logMessage({ modules: app.modules, actor: ACTOR }, base);
  assert.equal(first.message.subjectOwner, 'host');
  assert.equal(first.message.subjectOwnerPackage, null);

  const replay = await logMessage({ modules: app.modules, actor: ACTOR }, base);
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, first.message.id);

  // Same key, same contact, moved from host-owned to package-owned: a
  // different claim behind the same key — refused 409, never replayed.
  await assert.rejects(
    logMessage({ modules: app.modules, actor: ACTOR }, {
      ...base,
      subject: { resource: 'contact', id: 'c-presti', owner: 'package', ownerPackage: 'work' },
    }),
    (error) => error.code === 'INTERACTIONS_LOG_CONFLICT' && error.status === 409,
  );

  const completed = await logCall({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'tel:call:own:1', direction: 'outbound', channel: 'phone', outcome: 'completed',
    durationSec: 60, teamAuthorId: 'guido', subject: SUBJECT,
    occurredAt: '2026-09-15T10:00:02.000Z', source: SOURCE,
  });
  assert.equal(completed.call.subjectOwner, 'host');
  await assert.rejects(
    logCall({ modules: app.modules, actor: ACTOR }, {
      sourceKey: 'tel:call:own:1', direction: 'outbound', channel: 'phone', outcome: 'completed',
      durationSec: 60, teamAuthorId: 'guido',
      subject: { resource: 'contact', id: 'c-presti', owner: 'package', ownerPackage: 'work' },
      occurredAt: '2026-09-15T10:00:02.000Z', source: SOURCE,
    }),
    (error) => error.code === 'INTERACTIONS_LOG_CONFLICT' && error.status === 409,
  );
});

test('a concurrent move beats a stale advance: the loser names the winner', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'stale.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, logMessage } = await interactionsFrom(root);
  const { buildAdvanceMessageAction } = await import(
    pathToFileURL(join(root, 'packages/interactions/src/interactions.js')).href
  );

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:stale', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  const { message } = await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:stale:1', conversationId: conversation.id, direction: 'outbound',
    channel: 'whatsapp', body: 'Ci vediamo domani.', teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:01.000Z', source: SOURCE,
  });
  const stale = { ...message };
  assert.equal(stale.status, 'sent');

  // The concurrent branch commits first, through the action runtime.
  await run(app, 'interaction-message', 'advance', message.id, { to: 'delivered' });
  await run(app, 'interaction-message', 'advance', message.id, { to: 'read' });

  // The stale branch re-reads before writing: without the re-read, sent ->
  // delivered would still be a legal move on the stale record and would
  // silently drag a read message back to delivered.
  const advance = buildAdvanceMessageAction();
  await assert.rejects(
    advance.execute({ record: stale, input: { to: 'delivered' }, actor: ACTOR, modules: app.modules }),
    (error) => error.code === 'INTERACTIONS_INVALID_STATE'
      && error.status === 409
      && /moved while this action ran/.test(error.message),
  );
  const messages = app.modules.get('interaction-message').service;
  assert.equal((await messages.get(message.id)).status, 'read');
});

// ---------------------------------------------------------------------------
// Calls: outcome and duration logged once, with the team author on outbound
// ---------------------------------------------------------------------------

test('calls log outcome and duration once, and never transition', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'call.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { logCall } = await interactionsFrom(root);

  const completed = await logCall({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'tel:call:187', direction: 'outbound', channel: 'phone', outcome: 'completed',
    durationSec: 187, teamAuthorId: 'guido', remoteHandle: '+3902000001',
    subject: SUBJECT, occurredAt: '2026-09-15T10:05:00.000Z', source: SOURCE,
  });
  assert.equal(completed.call.durationSec, 187);
  const replay = await logCall({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'tel:call:187', direction: 'outbound', channel: 'phone', outcome: 'completed',
    durationSec: 187, teamAuthorId: 'guido', remoteHandle: '+3902000001',
    subject: SUBJECT, occurredAt: '2026-09-15T10:05:00.000Z', source: SOURCE,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.call.id, completed.call.id);

  const missed = await logCall({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'tel:call:missed', direction: 'inbound', channel: 'phone', outcome: 'missed',
    durationSec: 0, remoteHandle: '+3902000001',
    subject: SUBJECT, occurredAt: '2026-09-15T10:06:00.000Z', source: SOURCE,
  });
  assert.equal(missed.call.durationSec, 0);
  // No transition exists on any call: the record has no status to move.
  const schema = await context.client.schema();
  const callModule = schema.generatedModules.find((m) => m.name === 'interaction-call');
  assert.deepEqual(callModule.capabilities, ['get', 'list']);
});

// ---------------------------------------------------------------------------
// Timeline: messages and calls with work-activity, oldest first
// ---------------------------------------------------------------------------

test('the customer history merges messages, calls and work-activity in time order', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'timeline.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, logMessage, logCall, readTimeline } = await interactionsFrom(root);
  const { createFollowUp } = await workFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:history', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:h:1', conversationId: conversation.id, direction: 'inbound',
    channel: 'whatsapp', body: 'Quanto costa il pacchetto da 10 ingressi?',
    remoteHandle: '+3902000001', subject: SUBJECT, occurredAt: '2026-09-15T10:00:01.000Z', source: SOURCE,
  });
  await logCall({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'tel:call:h:1', conversationId: conversation.id, direction: 'outbound',
    channel: 'phone', outcome: 'completed', durationSec: 187, teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:02.000Z', source: SOURCE,
  });
  // The work entry arrives through work's own front door, inside a transaction,
  // exactly as a consuming domain writes it — never as a direct row insert.
  await app.database.transactionAsync(() => createFollowUp(
    { modules: app.modules, actor: ACTOR, now: () => '2026-09-15T10:00:03.000Z' },
    {
      sourceKey: 'quote-sent:c-presti',
      title: 'Send the 10-entry pack quote',
      subject: SUBJECT,
      source: { package: 'host', action: 'seed' },
    },
  ));
  await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:h:2', conversationId: conversation.id, direction: 'outbound',
    channel: 'whatsapp', body: 'Ti mando il preventivo in serata.', teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:04.000Z', source: SOURCE,
  });

  const history = await readTimeline({ modules: app.modules, moduleNames: {} }, SUBJECT);
  assert.deepEqual(history.entries.map((entry) => entry.entry), ['message', 'call', 'work-note', 'message']);
  assert.deepEqual(history.sources.interactions, { available: true, messageCount: 2, callCount: 1 });
  assert.deepEqual(history.sources.workActivity, { available: true, count: 1 });
  const [first, second] = history.entries;
  assert.equal(first.body, 'Quanto costa il pacchetto da 10 ingressi?');
  assert.equal(second.durationSec, 187);
  assert.ok(Object.isFrozen(history) && Object.isFrozen(history.entries));
});

test('without the work package the timeline says so, instead of reporting no work', async (t) => {
  const root = project(t, { withWork: false });
  const context = await boot(root, join(root, 'data', 'no-work.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { logMessage, readTimeline } = await interactionsFrom(root);

  await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'ig:msg:1', conversationId: 'conv-ig', direction: 'inbound',
    channel: 'instagram', body: 'Fate lezioni la domenica?',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:01.000Z', source: SOURCE,
  });
  const history = await readTimeline({ modules: app.modules, moduleNames: {} }, SUBJECT);
  assert.equal(history.entries.length, 1);
  assert.equal(history.sources.workActivity.available, false);
  assert.match(history.sources.workActivity.reason, /not composed/);
});

// ---------------------------------------------------------------------------
// Capabilities: declared consumers log and read through the registry
// ---------------------------------------------------------------------------

test('the log and timeline capabilities open for a declared consumer, with provenance bound', async (t) => {
  const root = project(t, { withProbe: true });
  const context = await boot(root, join(root, 'data', 'caps.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  const log = app.domains.capability({
    consumer: 'timeline-probe', capability: 'interaction-log', version: 1,
    context: { modules: app.modules, actor: ACTOR },
  });
  assert.deepEqual(Object.keys(log).sort(), ['assignConversation', 'capabilityContract', 'logCall', 'logMessage', 'markConversationRead', 'openConversation']);
  const opened = await log.openConversation({
    sourceKey: 'wa:thread:probe', subject: SUBJECT, channel: 'whatsapp',
    source: { package: 'timeline-probe', action: 'probe' },
  });
  assert.equal(opened.conversation.sourcePackage, 'timeline-probe');

  // A declared consumer cannot stamp another package's name on its rows.
  await assert.rejects(
    log.openConversation({
      sourceKey: 'wa:thread:spoof', subject: SUBJECT, channel: 'whatsapp',
      source: { package: 'interactions', action: 'probe' },
    }),
    (error) => error.code === 'INTERACTIONS_SOURCE_PACKAGE_MISMATCH' && error.status === 403,
  );
  // An undeclared consumer never opens either capability.
  assert.throws(
    () => app.domains.capability({
      consumer: 'nobody', capability: 'interaction-timeline', version: 1,
      context: { modules: app.modules },
    }),
  );

  const timeline = app.domains.capability({
    consumer: 'timeline-probe', capability: 'interaction-timeline', version: 1,
    context: { modules: app.modules },
  });
  const history = await timeline.timeline(SUBJECT);
  assert.equal(history.entries.length, 0);
  assert.equal(history.sources.interactions.messageCount, 0);
});

// ---------------------------------------------------------------------------
// Evidence boundaries: no public create or update, on any route
// ---------------------------------------------------------------------------

test('interaction records are evidence: no public write path, and the schema publishes the contract', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'bounds.sqlite'));
  t.after(() => context.close());
  const { app, client } = context;
  const { openConversation } = await interactionsFrom(root);
  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:bounds', subject: SUBJECT, channel: 'email', source: SOURCE,
  });

  const schema = await client.schema();
  for (const name of ['conversation', 'interaction-message', 'interaction-call', 'conversation-assignment', 'conversation-read']) {
    const meta = schema.generatedModules.find((m) => m.name === name);
    assert.deepEqual(meta.capabilities, ['get', 'list'], name);
    await assert.rejects(
      () => client.request(`/api/modules/${name}/records`, { method: 'POST', body: JSON.stringify({}) }),
      (error) => error.status === 404 || error.status === 405,
    );
    await assert.rejects(
      () => client.request(`/api/modules/${name}/records/${conversation.id}`, { method: 'PATCH', body: JSON.stringify({}) }),
      (error) => error.status === 404 || error.status === 405,
    );
  }
  assert.equal(schema.domains.interactions.interactionsContract, 1);
});

// ---------------------------------------------------------------------------
// Exact reads past the display bound, and audit exactness of a transition
// ---------------------------------------------------------------------------

test('the timeline is complete past 500 rows, and an advance writes exactly one audit entry', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'bound.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, logMessage, readTimeline } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:crowded', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  for (let n = 0; n < 600; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await logMessage({ modules: app.modules, actor: ACTOR }, {
      sourceKey: `wa:msg:crowd:${n}`, conversationId: conversation.id, direction: 'inbound',
      channel: 'whatsapp', body: `message ${n}`, remoteHandle: '+3902000001',
      subject: SUBJECT, occurredAt: '2026-09-15T10:00:01.000Z', source: SOURCE,
    });
  }
  const history = await readTimeline({ modules: app.modules, moduleNames: {} }, SUBJECT);
  assert.equal(history.entries.length, 600);
  assert.deepEqual(history.sources.interactions, { available: true, messageCount: 600, callCount: 0 });

  const outbound = await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:crowd:out', conversationId: conversation.id, direction: 'outbound',
    channel: 'whatsapp', body: 'Riassumiamo.', teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:02.000Z', source: SOURCE,
  });
  await run(app, 'interaction-message', 'advance', outbound.message.id, { to: 'delivered' });
  // Every row is present, and the advanced message carries exactly its create
  // audit plus its transition audit — counts, not presence.
  assert.equal(
    app.modules.get('interaction-message').service.countWhere({ subjectResource: 'contact', subjectId: 'c-presti' }),
    601,
  );
  const messageAudits = app.audit.list({ entityType: 'interaction-message', entityId: outbound.message.id });
  assert.equal(messageAudits.length, 2);
  assert.deepEqual(messageAudits.map((entry) => entry.action).sort(), ['interaction-message.created', 'interaction-message.updated']);
});

// ---------------------------------------------------------------------------
// Absence: without the package nothing is registered and rows are untouched
// ---------------------------------------------------------------------------

test('without the interactions package the application boots and the records stay quiet', async (t) => {
  const root = project(t, { withWork: true });
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [',
    '  createWorkPackage(),',
    '];',
    '',
  ].join('\n'));
  const context = await boot(root, join(root, 'data', 'absent.sqlite'));
  t.after(() => context.close());
  const { app, client } = context;

  const schema = await client.schema();
  assert.equal(schema.domains.interactions, undefined);
  // The applied records survive the detach — like work's rows — but the
  // package's actions go with it: removing the import removes the behavior
  // and leaves the data alone.
  const meta = schema.generatedModules.find((m) => m.name === 'interaction-message');
  assert.deepEqual(meta.actions, []);
  await assert.rejects(
    run(app, 'interaction-message', 'advance', 'no-such-id', { to: 'delivered' }),
    (error) => error.status === 404,
  );
});

// ---------------------------------------------------------------------------
// Conformance: the package answers the same questions every package answers
// ---------------------------------------------------------------------------

test('interactions conforms to the domain-package contract it ships', () => {
  assertPackageConforms({
    definition: createInteractionsPackage(),
    dir: join(repoRoot, 'packages/interactions'),
    expected: {
      name: 'interactions',
      version: 1,
      resources: ['conversation', 'interaction-message', 'interaction-call', 'conversation-assignment', 'conversation-read', 'conversation-thread-key'],
      actions: ['conversation.assign', 'conversation.close', 'conversation.mark-read', 'conversation.open-opportunity', 'interaction-message.advance'],
      requires: [],
      provides: ['interaction-log@1', 'interaction-timeline@1'],
    },
  });
  const metadata = createInteractionsPackage().metadata();
  for (const claim of ['message sending or delivery', 'scheduling', 'call recording or consent']) {
    assert.ok(metadata.notModeled.includes(claim), claim);
  }
});

// ---------------------------------------------------------------------------
// Assignment: one owner per conversation, every handover kept as audit
// ---------------------------------------------------------------------------

test('a conversation is assigned, reassigned and unassigned with a full audit trail', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'assign.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, assignConversation, readConversationThread } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:assign', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });

  const scope = { modules: app.modules, moduleNames: {} };
  const first = await assignConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'assign:1', conversationId: conversation.id, assigneeMemberId: 'guido', source: SOURCE,
  });
  assert.equal(first.replayed, false);
  assert.equal(first.assignment.assigneeMemberId, 'guido');
  assert.equal(first.assignment.previousAssigneeMemberId, null);
  assert.equal(first.previous, null);

  // Same key, same payload: replayed, never a second row.
  const replay = await assignConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'assign:1', conversationId: conversation.id, assigneeMemberId: 'guido', source: SOURCE,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.assignment.id, first.assignment.id);

  // Same key, divergent payload: refused 409, never adopted.
  await assert.rejects(
    assignConversation({ modules: app.modules, actor: ACTOR }, {
      sourceKey: 'assign:1', conversationId: conversation.id, assigneeMemberId: 'maria', source: SOURCE,
    }),
    (error) => error.code === 'INTERACTIONS_LOG_CONFLICT' && error.status === 409,
  );

  // Reassign: a new row, the previous owner named on it.
  const second = await assignConversation({ modules: app.modules, actor: { type: 'user', id: 'maria' } }, {
    sourceKey: 'assign:2', conversationId: conversation.id, assigneeMemberId: 'maria',
    note: 'passo a Maria per il preventivo', source: SOURCE,
  });
  assert.equal(second.assignment.assigneeMemberId, 'maria');
  assert.equal(second.assignment.previousAssigneeMemberId, 'guido');
  assert.equal(second.previous, 'guido');

  // The thread carries the current owner and the whole history, oldest first.
  const thread = await readConversationThread(scope, conversation.id);
  assert.equal(thread.assignment.assignee, 'maria');
  assert.equal(thread.assignment.assignedBy.id, 'maria');
  assert.deepEqual(thread.assignment.history.map((entry) => entry.assignee), ['guido', 'maria']);

  // Unassign: a row with no assignee, never a deleted row.
  const cleared = await assignConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'assign:3', conversationId: conversation.id, assigneeMemberId: null, source: SOURCE,
  });
  assert.equal(cleared.assignment.assigneeMemberId, null);
  assert.equal(cleared.previous, 'maria');
  const reopened = await readConversationThread(scope, conversation.id);
  assert.equal(reopened.assignment.assignee, null);
  assert.equal(reopened.assignment.history.length, 3);

  // Hostile and empty owners are refused, never stored.
  await assert.rejects(
    assignConversation({ modules: app.modules, actor: ACTOR }, {
      sourceKey: 'assign:bad', conversationId: conversation.id, assigneeMemberId: '  ', source: SOURCE,
    }),
    (error) => error.code === 'VALIDATION_ERROR' && error.status === 400,
  );
  await assert.rejects(
    assignConversation({ modules: app.modules, actor: ACTOR }, {
      sourceKey: 'assign:bad2', conversationId: conversation.id, assigneeMemberId: '__proto__', source: SOURCE,
    }),
    (error) => error.code === 'VALIDATION_ERROR' && error.status === 400,
  );
  await assert.rejects(
    assignConversation({ modules: app.modules, actor: ACTOR }, {
      sourceKey: 'assign:ghost', conversationId: 'no-such-conversation', assigneeMemberId: 'guido', source: SOURCE,
    }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
  );
});

test('the assign action replays a repeated handover instead of writing audit noise', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'assign-action.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:assign-action', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  const first = await run(app, 'conversation', 'assign', conversation.id, { assigneeMemberId: 'guido' });
  assert.equal(first.result.assignment.assigneeMemberId, 'guido');
  assert.equal(first.result.replayed, false);
  const again = await run(app, 'conversation', 'assign', conversation.id, { assigneeMemberId: 'guido' });
  assert.equal(again.result.replayed, true);
  assert.equal(
    app.modules.get('conversation-assignment').service.countWhere({ conversationId: conversation.id }),
    1,
  );
});

// ---------------------------------------------------------------------------
// Team read state: per-member unread, apart from channel delivery
// ---------------------------------------------------------------------------

test('team unread is per member, counts inbound only, and ignores channel delivery', async (t) => {
  const root = project(t);
  // The harness clock is fixed: pin it past the fixtures so the action-path
  // mark below moves its watermark past every message, like a real reader.
  const context = await boot(root, join(root, 'data', 'read.sqlite'), {
    clock: () => '2026-09-15T10:08:00.000Z',
  });
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, logMessage, markConversationRead, unreadCount } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:read', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  const scope = { modules: app.modules, moduleNames: {} };
  const at = (sourceKey, direction, extra = {}) => logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey, conversationId: conversation.id, direction,
    channel: 'whatsapp', body: 'domanda sui pacchetti', remoteHandle: '+3902000001',
    ...(direction === 'outbound' ? { teamAuthorId: 'guido' } : {}),
    subject: SUBJECT, occurredAt: '2026-09-15T10:00:01.000Z', source: SOURCE, ...extra,
  });
  await at('wa:msg:r:1', 'inbound');
  await at('wa:msg:r:2', 'inbound');

  assert.equal((await unreadCount(scope, conversation.id, 'guido')).unread, 2);

  // Guido reads: his count clears, Maria's does not.
  let clock = Date.parse('2026-09-15T10:05:00.000Z');
  const marked = await markConversationRead(
    { modules: app.modules, actor: { type: 'user', id: 'guido' }, now: () => new Date(clock).toISOString() },
    { conversationId: conversation.id, source: SOURCE },
  );
  assert.equal(marked.created, true);
  assert.equal((await unreadCount(scope, conversation.id, 'guido')).unread, 0);
  assert.equal((await unreadCount(scope, conversation.id, 'maria')).unread, 2);

  // A new customer message unreads whoever has read; the team's own reply does not.
  clock = Date.parse('2026-09-15T10:06:00.000Z');
  await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:r:3', conversationId: conversation.id, direction: 'inbound',
    channel: 'whatsapp', body: 'ci sono ancora?', remoteHandle: '+3902000001',
    subject: SUBJECT, occurredAt: new Date(clock).toISOString(), source: SOURCE,
  });
  assert.equal((await unreadCount(scope, conversation.id, 'guido')).unread, 1);
  assert.equal((await unreadCount(scope, conversation.id, 'maria')).unread, 3);
  const outbound = await logMessage({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:msg:r:out', conversationId: conversation.id, direction: 'outbound',
    channel: 'whatsapp', body: 'Si, dica pure.', teamAuthorId: 'guido',
    subject: SUBJECT, occurredAt: new Date(clock + 1000).toISOString(), source: SOURCE,
  });
  assert.equal((await unreadCount(scope, conversation.id, 'guido')).unread, 1);

  // A channel delivery confirmation is not a team read: advancing the team's
  // own message to read moves nothing on any member's watermark.
  await run(app, 'interaction-message', 'advance', outbound.message.id, { to: 'delivered' });
  await run(app, 'interaction-message', 'advance', outbound.message.id, { to: 'read' });
  assert.equal((await unreadCount(scope, conversation.id, 'guido')).unread, 1);
  assert.equal((await unreadCount(scope, conversation.id, 'maria')).unread, 3);

  // Reading again is an update of the same row, never a second row.
  clock = Date.parse('2026-09-15T10:07:00.000Z');
  const again = await markConversationRead(
    { modules: app.modules, actor: { type: 'user', id: 'guido' }, now: () => new Date(clock).toISOString() },
    { conversationId: conversation.id, source: SOURCE },
  );
  assert.equal(again.created, false);
  assert.equal((await unreadCount(scope, conversation.id, 'guido')).unread, 0);
  assert.equal(
    app.modules.get('conversation-read').service.countWhere({ conversationId: conversation.id }),
    1,
  );

  // The mark-read action marks the acting member through the record runtime.
  clock = Date.parse('2026-09-15T10:08:00.000Z');
  await run(app, 'conversation', 'mark-read', conversation.id, {}, { type: 'user', id: 'maria' });
  assert.equal((await unreadCount(scope, conversation.id, 'maria')).unread, 0);
});

// ---------------------------------------------------------------------------
// One conversation per customer: channels join the same thread in time order
// ---------------------------------------------------------------------------

test('one customer keeps one conversation across channels, oldest first', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'unified.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, logMessage, readConversationThread } = await interactionsFrom(root);
  const scope = { modules: app.modules, moduleNames: {} };

  const first = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:uni', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  assert.equal(first.joined, false);

  // The same customer on Instagram: no new conversation, the thread is joined.
  const second = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'ig:thread:uni', subject: SUBJECT, channel: 'instagram', source: SOURCE,
  });
  assert.equal(second.conversation.id, first.conversation.id);
  assert.equal(second.joined, true);
  assert.equal(second.replayed, false);

  // Same key, divergent channel: still refused 409, never adopted.
  await assert.rejects(
    openConversation({ modules: app.modules, actor: ACTOR }, {
      sourceKey: 'wa:thread:uni', subject: SUBJECT, channel: 'instagram', source: SOURCE,
    }),
    (error) => error.code === 'INTERACTIONS_LOG_CONFLICT' && error.status === 409,
  );

  // Messages from three channels land on the one thread, oldest first.
  const body = (sourceKey, channel, direction, occurredAt, extra = {}) => logMessage(
    { modules: app.modules, actor: ACTOR },
    {
      sourceKey, conversationId: first.conversation.id, direction, channel,
      body: `${channel} ciao`, remoteHandle: '+3902000001',
      ...(direction === 'outbound' ? { teamAuthorId: 'guido' } : {}),
      subject: SUBJECT, occurredAt, source: SOURCE, ...extra,
    },
  );
  await body('ig:msg:u:1', 'instagram', 'inbound', '2026-09-15T10:00:02.000Z');
  await body('wa:msg:u:1', 'whatsapp', 'inbound', '2026-09-15T10:00:01.000Z');
  await body('em:msg:u:1', 'email', 'outbound', '2026-09-15T10:00:03.000Z');
  const thread = await readConversationThread(scope, first.conversation.id);
  assert.deepEqual(thread.entries.map((entry) => entry.channel), ['whatsapp', 'instagram', 'email']);

  // A different customer still gets their own conversation.
  const other = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:other', subject: { resource: 'contact', id: 'c-altro', owner: 'host' },
    channel: 'whatsapp', source: SOURCE,
  });
  assert.notEqual(other.conversation.id, first.conversation.id);
  assert.equal(other.joined, false);

  // A closed thread stays resolved: the next message opens a fresh one.
  await run(app, 'conversation', 'close', first.conversation.id, {});
  const fresh = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:uni:2', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  assert.notEqual(fresh.conversation.id, first.conversation.id);
  assert.equal(fresh.joined, false);
});

// ---------------------------------------------------------------------------
// Thread keys: a joined key replays its thread, even after the thread closed
// ---------------------------------------------------------------------------

test('a joined key retried after close replays the joined thread, never a duplicate', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'joinkey.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation } = await interactionsFrom(root);

  const first = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:jk', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  const second = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'ig:thread:jk', subject: SUBJECT, channel: 'instagram', source: SOURCE,
  });
  assert.equal(second.joined, true);
  assert.equal(second.conversation.id, first.conversation.id);

  // The join left exactly one thread-key row behind.
  const keys = app.modules.get('conversation-thread-key').service;
  assert.equal(keys.countWhere({ sourceKey: 'ig:thread:jk' }), 1);

  // Retry while open: replays the join, writes nothing new.
  const retry = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'ig:thread:jk', subject: SUBJECT, channel: 'instagram', source: SOURCE,
  });
  assert.equal(retry.replayed, true);
  assert.equal(retry.joined, true);
  assert.equal(retry.conversation.id, first.conversation.id);
  assert.equal(keys.countWhere({ sourceKey: 'ig:thread:jk' }), 1);

  // Close the thread, then retry the joined key: the closed thread replays,
  // and no second conversation opens behind the same key.
  await run(app, 'conversation', 'close', first.conversation.id, {});
  const afterClose = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'ig:thread:jk', subject: SUBJECT, channel: 'instagram', source: SOURCE,
  });
  assert.equal(afterClose.replayed, true);
  assert.equal(afterClose.conversation.id, first.conversation.id);
  assert.equal(afterClose.conversation.status, 'closed');
  assert.equal(
    app.modules.get('conversation').service.countWhere({ subjectResource: 'contact', subjectId: 'c-presti' }),
    1,
  );

  // The channel on the retry is where the message arrived, not a new claim:
  // the same key on another channel still replays the joined thread.
  const arrived = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'ig:thread:jk', subject: SUBJECT, channel: 'email', source: SOURCE,
  });
  assert.equal(arrived.replayed, true);
  assert.equal(arrived.conversation.id, first.conversation.id);

  // Same joined key naming another customer: refused 409, never adopted.
  await assert.rejects(
    openConversation({ modules: app.modules, actor: ACTOR }, {
      sourceKey: 'ig:thread:jk',
      subject: { resource: 'contact', id: 'c-altro', owner: 'host' },
      channel: 'instagram', source: SOURCE,
    }),
    (error) => error.code === 'INTERACTIONS_LOG_CONFLICT' && error.status === 409,
  );
});

// ---------------------------------------------------------------------------
// Default handover keys: returns to a prior owner, repeats replay
// ---------------------------------------------------------------------------

test('the assign action cycles owners on default keys: a return is a new row, a repeat replays', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'assign-cycle.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, readConversationThread } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:cycle', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });
  const count = () => app.modules.get('conversation-assignment')
    .service.countWhere({ conversationId: conversation.id });

  const toGuido = await run(app, 'conversation', 'assign', conversation.id, { assigneeMemberId: 'guido' });
  assert.equal(toGuido.result.replayed, false);
  const toMaria = await run(app, 'conversation', 'assign', conversation.id, { assigneeMemberId: 'maria' });
  assert.equal(toMaria.result.replayed, false);
  assert.equal(toMaria.result.previous, 'guido');
  // A return to a prior owner is a new row naming Maria as previous, never a 409.
  const backToGuido = await run(app, 'conversation', 'assign', conversation.id, { assigneeMemberId: 'guido' });
  assert.equal(backToGuido.result.replayed, false);
  assert.equal(backToGuido.result.assignment.assigneeMemberId, 'guido');
  assert.equal(backToGuido.result.previous, 'maria');
  assert.equal(count(), 3);

  // Repeating the current owner replays the establishing row, writes nothing.
  const again = await run(app, 'conversation', 'assign', conversation.id, { assigneeMemberId: 'guido' });
  assert.equal(again.result.replayed, true);
  assert.equal(again.result.assignment.id, backToGuido.result.assignment.id);
  assert.equal(count(), 3);

  // Clearing twice: the first clear writes, the second replays it.
  const cleared = await run(app, 'conversation', 'assign', conversation.id, {});
  assert.equal(cleared.result.replayed, false);
  assert.equal(cleared.result.assignment.assigneeMemberId, null);
  const clearedAgain = await run(app, 'conversation', 'assign', conversation.id, {});
  assert.equal(clearedAgain.result.replayed, true);
  assert.equal(clearedAgain.result.assignment.id, cleared.result.assignment.id);
  assert.equal(count(), 4);

  const thread = await readConversationThread({ modules: app.modules, moduleNames: {} }, conversation.id);
  assert.deepEqual(thread.assignment.history.map((entry) => entry.assignee), ['guido', 'maria', 'guido', null]);
  assert.deepEqual(thread.assignment.history.map((entry) => entry.previous), [null, 'guido', 'maria', 'guido']);
});

// ---------------------------------------------------------------------------
// Assignment races: serialized per thread, every row names its true predecessor
// ---------------------------------------------------------------------------

test('concurrent handovers on one thread serialize: no two rows share a predecessor', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'assign-race.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, assignConversation, readConversationThread } = await interactionsFrom(root);

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:race', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });

  // Five handovers with distinct keys racing in the same tick: without
  // serialization several would read the same current owner and commit with
  // it, and whichever sorts last would claim the wrong predecessor.
  const owners = ['guido', 'maria', 'luca', 'anna', 'sara'];
  const results = await Promise.all(owners.map((owner, n) => assignConversation(
    { modules: app.modules, actor: ACTOR },
    { sourceKey: `assign:race:${n}`, conversationId: conversation.id, assigneeMemberId: owner, source: SOURCE },
  )));
  assert.ok(results.every((result) => result.replayed === false));

  const thread = await readConversationThread({ modules: app.modules, moduleNames: {} }, conversation.id);
  assert.equal(thread.assignment.history.length, 5);
  // An exact chain, read through the previous pointers rather than the list
  // order: rows committed in the same instant sort by id, not by handover
  // order, so the list order proves nothing. One row follows nobody, every
  // other row follows exactly one predecessor, and walking the predecessors
  // visits every row exactly once — no two rows share a predecessor.
  const chain = thread.assignment.history;
  const byPrevious = new Map();
  for (const row of chain) {
    assert.ok(!byPrevious.has(row.previous), `two rows claim predecessor ${row.previous}`);
    byPrevious.set(row.previous, row);
  }
  assert.equal(byPrevious.size, 5);
  assert.ok(byPrevious.has(null), 'one row starts the chain');
  let current = byPrevious.get(null);
  let visited = 1;
  while (byPrevious.has(current.assignee)) {
    current = byPrevious.get(current.assignee);
    visited += 1;
  }
  assert.equal(visited, 5);
});

// ---------------------------------------------------------------------------
// Renamed records: the actions forward the complete mapping, never a subset
// ---------------------------------------------------------------------------

test('assign and mark-read run on renamed records: the full mapping is forwarded', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'renamed.sqlite'), {
    clock: () => '2026-09-15T10:08:00.000Z',
  });
  t.after(() => context.close());
  const { app } = context;
  const { openConversation, unreadCount } = await interactionsFrom(root);
  const { buildAssignConversationAction, buildMarkReadConversationAction } = await import(
    pathToFileURL(join(root, 'packages/interactions/src/interactions.js')).href
  );

  const { conversation } = await openConversation({ modules: app.modules, actor: ACTOR }, {
    sourceKey: 'wa:thread:renamed', subject: SUBJECT, channel: 'whatsapp', source: SOURCE,
  });

  // The package composed with every record renamed: only the renamed names
  // resolve, and the canonical ones read as absent — exactly what a renamed
  // composition looks like to the actions.
  const renamed = {
    conversation: 'conv2',
    'interaction-message': 'msg2',
    'interaction-call': 'call2',
    'conversation-assignment': 'assign2',
    'conversation-read': 'read2',
  };
  const reverse = Object.fromEntries(Object.entries(renamed).map(([from, to]) => [to, from]));
  const modules = {
    get: (name) => {
      const canonical = reverse[name];
      if (!canonical) throw new NotFoundError('Module', String(name));
      return app.modules.get(canonical);
    },
  };
  const now = () => '2026-09-15T10:08:00.000Z';

  const handed = await buildAssignConversationAction(renamed).execute({
    record: conversation, input: { assigneeMemberId: 'guido' }, actor: ACTOR, modules, now,
  });
  assert.equal(handed.assignment.assigneeMemberId, 'guido');
  assert.equal(handed.replayed, false);

  const marked = await buildMarkReadConversationAction(renamed).execute({
    record: conversation, input: {}, actor: { type: 'user', id: 'guido' }, modules, now,
  });
  assert.equal(marked.created, true);
  assert.equal((await unreadCount({ modules: app.modules, moduleNames: {} }, conversation.id, 'guido')).unread, 0);
});
