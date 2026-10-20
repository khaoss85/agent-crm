// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AuditLog } from '../packages/core/src/audit.js';
import { createDatabase } from '../packages/core/src/database.js';
import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { ChannelRegistries } from '../packages/channels/src/adapter.js';
import { buildChannelConnectionActions } from '../packages/channels/src/index.js';
import { createChannelOperations } from '../packages/channels/src/operations.js';
import { createFixtureChannelAdapter } from '../packages/channels/src/fixture.js';
import { createSpacePermissionGateCapability } from '../packages/space-permissions/src/capability.js';
import { buildDecideAction, buildSetPermissionAction } from '../packages/space-permissions/src/actions.js';
import { createLlmOperations, openLlmComplete } from '../packages/llm/src/operations.js';
import { createFixtureLlmAdapter } from '../packages/llm/src/fixture.js';

/**
 * The backoffice reply flow (BO-F1-07, "05 Scheda cliente"): a human answer
 * on the customer's preferred channel, drafted by the caller or the
 * workspace AI ("Scrivi con AI"), gated on the space's
 * `send-without-approval` switch (off by default), sent through the
 * channel outbox with a provider receipt, and read back as a lifecycle
 * state — on real sqlite, real module services, the real gate capability,
 * the real durable-job store and worker. Fixture doubles stand in only for
 * the channel adapter, the secret vault and the LLM provider (owner
 * decision MEM_ACC_DECISIONS: no real credentials in tests).
 */

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = (name) => join(here, '..', 'packages', name);
function loadManifest(pkg, name) {
  return JSON.parse(readFileSync(join(pkgRoot(pkg), 'modules', `${name}.module.json`), 'utf8'));
}

const SPACE_A = 'reply-a';
const SPACE_B = 'reply-b';
const ACCOUNT_A = '+390200000001';
const CHANNEL_SECRET_REF = 'vault://reply/channel-a';
const CHANNEL_SECRET = 'reply-channel-secret-1';
const LLM_SECRET = 'reply-llm-secret-1';
const USER = { type: 'user', id: 'backoffice-anna' };
const OWNER = { type: 'user', id: 'owner-1' };
const NOW = '2026-10-20T12:00:00.000Z';

const CHANNEL_MODULES = [
  'channel-connection', 'channel-inbox-event', 'channel-dead-letter',
  'channel-import-state', 'channel-import-outcome',
];
const PERMISSION_MODULES = ['space-permission-override', 'space-ai-proposal'];
const LLM_MODULES = ['llm-usage-day', 'llm-call-audit'];

function setupReplyHarness({ withLlm = false, extraAdapters = [] } = {}) {
  const { definition, api } = createFixtureChannelAdapter({ secret: CHANNEL_SECRET });
  const database = createDatabase({ path: ':memory:' });
  const manifests = [
    ...CHANNEL_MODULES.map((name) => ({ pkg: 'channels', name })),
    ...PERMISSION_MODULES.map((name) => ({ pkg: 'space-permissions', name })),
    ...(withLlm ? LLM_MODULES.map((name) => ({ pkg: 'llm', name })) : []),
  ];
  for (const { pkg, name } of manifests) {
    for (const { sql } of recordModuleMigrations([{ name, manifest: loadManifest(pkg, name) }])) {
      database.raw.exec(sql);
    }
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const { name } of manifests) {
    const built = createRecordModuleFromManifest(
      loadManifest(manifests.find((entry) => entry.name === name).pkg, name),
      { database, audit, events, references: {} },
    );
    modules.set(name, { service: built.service });
  }

  const permissionGate = createSpacePermissionGateCapability().create({
    modules, consumer: 'channel-reply-test',
  });

  let llm = null;
  let llmApi = null;
  if (withLlm) {
    const fixture = createFixtureLlmAdapter({ secret: LLM_SECRET });
    llmApi = fixture.api;
    const llmOps = createLlmOperations({
      adapters: [fixture.definition],
      spaces: { [SPACE_A]: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
      secretRef: `secret://${SPACE_A}/llm`,
      resolveSecret: async () => LLM_SECRET,
      clock: () => Date.parse(NOW),
    });
    llm = openLlmComplete(llmOps, { modules });
  }

  const registries = new ChannelRegistries({ channelAdapters: [definition, ...extraAdapters] });
  const resolveSecret = async (ref) => {
    if (ref !== CHANNEL_SECRET_REF) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return CHANNEL_SECRET;
  };
  const ops = createChannelOperations({
    database, modules, registries, resolveSecret, tenantId: 'reply-kit',
    permissionGate, llm,
  });

  const jobRegistry = createDurableJobHandlerRegistry();
  ops.registerChannelSendHandlers(jobRegistry);
  const jobStore = createDurableJobStore({ storage: database.storage, tenantId: 'reply-kit' });
  const worker = createDurableJobWorker({
    store: jobStore, registry: jobRegistry, workerId: 'reply-kit',
    actor: { type: 'system', id: 'reply-kit' }, backoff: () => 0, pollIntervalMs: 60000,
  });
  worker.start();

  const connectionActions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  const connectionService = () => modules.get('channel-connection').service;
  const proposalService = () => modules.get('space-ai-proposal').service;

  async function register(spaceId, account = ACCOUNT_A, channel = 'whatsapp', adapter = definition) {
    const reg = await ops.registerChannelConnection({
      spaceId, channel, account, adapter: adapter.name, adapterVersion: adapter.version,
      secretRef: CHANNEL_SECRET_REF, actor: USER,
    });
    return reg.connection.sourceKey;
  }

  async function activate(spaceId, connectionKey) {
    const record = ops.getConnection(spaceId, connectionKey);
    assert.ok(record, 'connection missing for activation');
    return connectionActions['activate-connection'].execute({
      record,
      input: { reason: 'reply kit activation' },
      actor: USER,
      modules,
      managed: (id, patch) => connectionService().applyManaged(id, patch, { actor: USER }),
      now: () => NOW,
    });
  }

  async function decide(proposalId, spaceId, decision, actor = OWNER, input = {}) {
    const rows = await proposalService().listWhere({ spaceId });
    const record = rows.find((row) => row.id === proposalId);
    assert.ok(record, 'proposal row missing for the decision');
    const action = buildDecideAction(decision);
    return action.execute({
      record, input, actor, modules,
      managed: (id, patch) => proposalService().applyManaged(id, patch, { actor }),
      now: () => NOW,
      step: () => {},
    });
  }

  async function setPermission(spaceId, enabled, actor = OWNER) {
    const action = buildSetPermissionAction();
    return action.execute({
      input: { spaceId, permission: 'send-without-approval', enabled },
      actor, modules,
      managed: (id, patch) => modules.get('space-permission-override').service.applyManaged(id, patch, { actor }),
      now: () => NOW,
      step: () => {},
    });
  }

  async function pump(jobId, maxRounds = 12) {
    let settled = null;
    for (let round = 0; round < maxRounds; round += 1) {
      const ran = await worker.run(jobId);
      settled = ran ?? await jobStore.get(jobId);
      if (settled && (settled.state === 'succeeded' || settled.state === 'failed_terminal')) return settled;
    }
    throw new Error(`send job never settled: ${JSON.stringify(settled)}`);
  }

  return {
    database, modules, ops, api, llmApi, permissionGate,
    register, activate, decide, setPermission, pump,
    sentCount: () => api.state.sentByKey.size,
    sendCalls: () => api.state.sendCalls,
    jobs: () => jobStore.list(500),
    proposals: (spaceId) => proposalService().listWhere({ spaceId }),
    auditRows: () => audit.list({ limit: 500 }),
    async close() {
      await worker.close();
      database.close();
    },
  };
}

const codeOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error && typeof error === 'object' ? error.code : null;
  }
  return null;
};

test('switch off by default: the reply waits for the ok and nothing is enqueued', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A, text: 'Ciao, ti confermo le 18:00.', actor: USER,
  });
  assert.equal(proposed.state, 'pending-approval');
  assert.ok(typeof proposed.proposalId === 'string' && proposed.proposalId !== '');
  assert.equal(proposed.replayed, false);
  assert.equal(proposed.connectionKey, key);
  assert.equal(proposed.channel, 'whatsapp');

  assert.equal((await h.jobs()).length, 0, 'no outbox job exists while the reply waits');
  assert.equal(h.sentCount(), 0, 'the provider saw nothing while the reply waits');
  assert.equal(h.sendCalls(), 0, 'no send was attempted while the reply waits');

  const read = await h.ops.readReply({ spaceId: SPACE_A, proposalId: proposed.proposalId });
  assert.equal(read.state, 'pending-approval');
  assert.equal(read.to, ACCOUNT_A);
});

test('approval sends the approved bytes: outbox, provider receipt, consegnato', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, channel: 'whatsapp', to: ACCOUNT_A,
    text: 'Ciao, ti confermo le 18:00.', messageKey: 'reply-1', actor: USER,
  });
  assert.equal(proposed.state, 'pending-approval');

  await h.decide(proposed.proposalId, SPACE_A, 'approved');
  const sent = await h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER });
  assert.equal(sent.state, 'queued');
  assert.ok(typeof sent.jobId === 'string' && sent.jobId !== '');

  const settled = await h.pump(sent.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(h.sentCount(), 1, 'the provider sent exactly once');

  const read = await h.ops.readReply({ spaceId: SPACE_A, proposalId: proposed.proposalId });
  assert.equal(read.state, 'sent');
  assert.equal(read.jobId, sent.jobId);
  assert.equal(read.attempts, 1);

  // Audit with the actor on every send: the proposal names the proposer,
  // the job enqueue names the sender.
  const rows = h.auditRows();
  const texts = JSON.stringify(rows.map((row) => row.data));
  assert.ok(texts.includes(USER.id), 'the proposing actor is in the audit trail');
  assert.ok(texts.includes(OWNER.id), 'the sending actor is in the audit trail');
});

test('a refused reply never sends', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A, text: 'Offerta speciale solo per oggi.', actor: USER,
  });
  await h.decide(proposed.proposalId, SPACE_A, 'refused', OWNER, { refusalReason: 'Troppo aggressivo.' });

  assert.equal(
    await codeOf(() => h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER })),
    'CHANNEL_REPLY_REFUSED',
  );
  assert.equal((await h.jobs()).length, 0, 'a refusal enqueues nothing');
  const read = await h.ops.readReply({ spaceId: SPACE_A, proposalId: proposed.proposalId });
  assert.equal(read.state, 'refused');
  assert.equal(read.refusalReason, 'Troppo aggressivo.');
});

test('a reply still waiting for the ok never sends', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A, text: 'Ti richiamo domani.', actor: USER,
  });
  assert.equal(
    await codeOf(() => h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER })),
    'CHANNEL_REPLY_NOT_APPROVED',
  );
  assert.equal(h.sentCount(), 0);
});

test('switch on: the reply queues through the outbox at once', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);
  await h.setPermission(SPACE_A, 'on');

  const queued = await h.ops.proposeReply({
    spaceId: SPACE_A, channel: 'whatsapp', to: ACCOUNT_A,
    text: 'Confermato.', messageKey: 'reply-on-1', actor: USER,
  });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.proposalId, null);
  const settled = await h.pump(queued.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(h.sentCount(), 1, 'invio via outbox con ricevuta');
});

test('the sender is always of the right space, never of another', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const keyA = await h.register(SPACE_A);
  await h.activate(SPACE_A, keyA);
  const keyB = await h.register(SPACE_B, '+390200000002');
  await h.activate(SPACE_B, keyB);

  // Space B cannot propose on space A's connection: not found, never forbidden.
  assert.equal(
    await codeOf(() => h.ops.proposeReply({
      spaceId: SPACE_B, connectionKey: keyA, to: ACCOUNT_A, text: 'Ciao.', actor: USER,
    })),
    'CHANNEL_CONNECTION_UNKNOWN',
  );
  assert.equal((await h.jobs()).length, 0);

  // Space B cannot send or read space A's approved reply.
  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: keyA, to: ACCOUNT_A, text: 'Solo per A.', actor: USER,
  });
  await h.decide(proposed.proposalId, SPACE_A, 'approved');
  assert.equal(
    await codeOf(() => h.ops.sendApprovedReply({ spaceId: SPACE_B, proposalId: proposed.proposalId, actor: OWNER })),
    'CHANNEL_REPLY_UNKNOWN',
  );
  assert.equal(
    await codeOf(() => h.ops.readReply({ spaceId: SPACE_B, proposalId: proposed.proposalId })),
    'CHANNEL_REPLY_UNKNOWN',
  );
  assert.equal(h.sentCount(), 0, 'no cross-space send happened');
});

test('the preferred channel answers when the space holds one connection', async (t) => {
  const { definition: smsDefinition } = createFixtureChannelAdapter({
    secret: CHANNEL_SECRET, name: 'fixture-sms', channel: 'sms',
  });
  const h = setupReplyHarness({ extraAdapters: [smsDefinition] });
  t.after(() => h.close());
  const wa = await h.register(SPACE_A, ACCOUNT_A, 'whatsapp');
  await h.activate(SPACE_A, wa);
  const sms = await h.register(SPACE_A, '+390200000003', 'sms', smsDefinition);
  await h.activate(SPACE_A, sms);

  const viaSms = await h.ops.proposeReply({
    spaceId: SPACE_A, channel: 'sms', to: '+390200000003', text: 'Promemoria appuntamento.', actor: USER,
  });
  assert.equal(viaSms.state, 'pending-approval');
  assert.equal(viaSms.connectionKey, sms);

  // Two whatsapp connections: the channel alone no longer decides.
  const wa2 = await h.register(SPACE_A, '+390200000004', 'whatsapp');
  await h.activate(SPACE_A, wa2);
  assert.equal(
    await codeOf(() => h.ops.proposeReply({
      spaceId: SPACE_A, channel: 'whatsapp', to: ACCOUNT_A, text: 'Quale numero?', actor: USER,
    })),
    'CHANNEL_REPLY_AMBIGUOUS_CHANNEL',
  );
});

test('"Scrivi con AI" uses the composed adapter; without one it refuses', async (t) => {
  const h = setupReplyHarness({ withLlm: true });
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);
  h.llmApi.answer('Ciao! Ti confermo la prenotazione di domani alle 18:00.');

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A, useAi: true, actor: USER,
  });
  assert.equal(proposed.state, 'pending-approval');
  assert.equal(h.llmApi.calls(), 1, 'the workspace adapter drafted the reply');
  const rows = await h.proposals(SPACE_A);
  const row = rows.find((entry) => entry.id === proposed.proposalId);
  assert.equal(row.summary, 'Ciao! Ti confermo la prenotazione di domani alle 18:00.');

  await h.decide(proposed.proposalId, SPACE_A, 'approved');
  const sent = await h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER });
  const settled = await h.pump(sent.jobId);
  assert.equal(settled.state, 'succeeded');
  const delivered = [...h.api.state.sentByKey.values()];
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.text, row.summary, 'the approved draft is what the provider got');

  const bare = setupReplyHarness();
  t.after(() => bare.close());
  const bareKey = await bare.register(SPACE_A);
  await bare.activate(SPACE_A, bareKey);
  assert.equal(
    await codeOf(() => bare.ops.proposeReply({
      spaceId: SPACE_A, connectionKey: bareKey, to: ACCOUNT_A, useAi: true, actor: USER,
    })),
    'CHANNEL_LLM_UNAVAILABLE',
  );
  assert.equal((await bare.jobs()).length, 0, 'no fallback text was invented');
});

test('the approval authorizes exact bytes: drift refuses instead of sending', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A, text: 'Testo approvato.', actor: USER,
  });
  await h.decide(proposed.proposalId, SPACE_A, 'approved');

  // Tamper with the stored proposal text: the send must refuse, never send
  // something the human did not see.
  const service = h.modules.get('space-ai-proposal').service;
  const stored = (await service.listWhere({ spaceId: SPACE_A })).find((row) => row.id === proposed.proposalId);
  await service.applyManaged(stored.id, { summary: 'Testo cambiato dopo il via.' }, { actor: OWNER });
  assert.equal(
    await codeOf(() => h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER })),
    'CHANNEL_REPLY_TEXT_DRIFT',
  );
  assert.equal(h.sentCount(), 0);
});

test('a double approval sends once: the outbox key dedups the second send', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A,
    text: 'Conferma doppia.', messageKey: 'reply-double-1', actor: USER,
  });
  await h.decide(proposed.proposalId, SPACE_A, 'approved');
  const first = await h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER });
  const second = await h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER });
  assert.equal(second.jobId, first.jobId, 'the same outbox job answers twice');
  const settled = await h.pump(first.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(h.sentCount(), 1, 'the provider sent exactly once');
});

test('a failed send reads back as failed', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  const proposed = await h.ops.proposeReply({
    spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A,
    text: 'Non partirà mai.', messageKey: 'reply-fail-1', actor: USER,
  });
  await h.decide(proposed.proposalId, SPACE_A, 'approved');
  h.api.setMode('refuse');
  const sent = await h.ops.sendApprovedReply({ spaceId: SPACE_A, proposalId: proposed.proposalId, actor: OWNER });
  const settled = await h.pump(sent.jobId);
  assert.equal(settled.state, 'failed_terminal', 'a permanent refusal settles terminally');
  h.api.reset();
  const read = await h.ops.readReply({ spaceId: SPACE_A, proposalId: proposed.proposalId });
  assert.equal(read.state, 'failed');
  assert.equal(read.jobId, sent.jobId);
});

test('anonymous callers never propose or send', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);

  assert.equal(
    await codeOf(() => h.ops.proposeReply({
      spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A, text: 'Ciao.', actor: null,
    })),
    'HUMAN_APPROVAL_REQUIRED',
  );
  assert.equal(
    await codeOf(() => h.ops.sendApprovedReply({
      spaceId: SPACE_A, proposalId: 'nope', actor: { type: 'system', id: 'worker' },
    })),
    'HUMAN_APPROVAL_REQUIRED',
  );
});

test('an unknown gate verdict refuses fail-closed, never sends', async (t) => {
  const h = setupReplyHarness();
  t.after(() => h.close());
  const key = await h.register(SPACE_A);
  await h.activate(SPACE_A, key);
  const weird = {
    gate: async () => ({ decision: 'maybe' }),
    propose: (...args) => h.permissionGate.propose(...args),
    proposal: (...args) => h.permissionGate.proposal(...args),
  };
  const { definition: sameFixture } = createFixtureChannelAdapter({ secret: CHANNEL_SECRET });
  const ops = createChannelOperations({
    database: h.database, modules: h.modules,
    registries: new ChannelRegistries({ channelAdapters: [sameFixture] }),
    resolveSecret: async () => CHANNEL_SECRET, tenantId: 'reply-kit',
    permissionGate: weird, llm: null,
  });
  assert.equal(
    await codeOf(() => ops.proposeReply({
      spaceId: SPACE_A, connectionKey: key, to: ACCOUNT_A, text: 'Ciao.', actor: USER,
    })),
    'CHANNEL_REPLY_GATE_INVALID',
  );
  assert.equal((await h.jobs()).length, 0, 'an undecided gate enqueues nothing');
});

test('an unwired composition refuses the reply flow, never sends past it', async (t) => {
  const { definition, api } = createFixtureChannelAdapter({ secret: CHANNEL_SECRET });
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  for (const name of CHANNEL_MODULES) {
    for (const { sql } of recordModuleMigrations([{ name, manifest: loadManifest('channels', name) }])) {
      database.raw.exec(sql);
    }
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const name of CHANNEL_MODULES) {
    const built = createRecordModuleFromManifest(loadManifest('channels', name), {
      database, audit, events, references: {},
    });
    modules.set(name, { service: built.service });
  }
  const registries = new ChannelRegistries({ channelAdapters: [definition] });
  const ops = createChannelOperations({
    database, modules, registries,
    resolveSecret: async () => CHANNEL_SECRET,
    tenantId: 'reply-kit-bare',
  });
  assert.equal(
    await codeOf(() => ops.proposeReply({
      spaceId: SPACE_A, channel: 'whatsapp', to: ACCOUNT_A, text: 'Ciao.', actor: USER,
    })),
    'CHANNEL_REPLY_GATE_MISSING',
  );
  void api;
});
