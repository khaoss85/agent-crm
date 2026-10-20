import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';
import { ChannelRegistries } from '../packages/channels/src/adapter.js';
import { buildChannelConnectionActions } from '../packages/channels/src/index.js';
import { createChannelOperations } from '../packages/channels/src/operations.js';
import {
  WHATSAPP_ADAPTER_NAME,
  WHATSAPP_ADAPTER_VERSION,
  createWhatsAppChannelAdapter,
} from '../packages/channels/src/whatsapp.js';
import { createSpacePermissionsDomain } from '../packages/space-permissions/src/index.js';
import {
  advanceSequences,
  computeSequenceMetrics,
  createSequencesPackage,
} from '../packages/sequences/src/index.js';

/**
 * Follow-up sequences, stopped on reply and gated on permission
 * (backlog:22bb154a72ea, BO-F3-03 "10 Sequenze").
 *
 * A two-step WhatsApp sequence over real sqlite, the real channels outbox
 * with the fake-backed adapter, and the real space-permission gate. The
 * four acceptance tests below map one-to-one to the backlog criteria:
 * stop on the first recorded reply, fail-closed send permission (the step
 * waits for a human ok), pause and resume without double sends, and
 * metrics counted from records. A fifth test covers the backoffice elenco
 * (list with state and metrics).
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SYSTEM = { type: 'system', id: 'sequences-kit' };
const SPACE = 'presti';
const TENANT = 'sequences-kit';
const SECRET_REF = 'vault://kit/whatsapp-sequences';
const SECRET = 'whatsapp-fake-sequences';
const TO = '+393331112223';
const TO_2 = '+393334445556';
const BASE_MS = Date.now() + 60_000;
const T0 = new Date(BASE_MS).toISOString();
const T0_LATER = new Date(BASE_MS + 5 * 60_000).toISOString();
const T1 = new Date(BASE_MS + 24 * 60 * 60_000).toISOString();
const T1_LATER = new Date(BASE_MS + 24 * 60 * 60_000 + 5 * 60_000).toISOString();

const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const MANIFESTS = [
  ['sequences', 'sequence'],
  ['sequences', 'sequence-step'],
  ['sequences', 'sequence-enrollment'],
  ['sequences', 'sequence-send'],
  ['channels', 'channel-connection'],
  ['channels', 'channel-inbox-event'],
  ['space-permissions', 'space-permission-override'],
  ['space-permissions', 'space-ai-proposal'],
];

function compose() {
  const { definition, api } = createWhatsAppChannelAdapter({
    phoneNumberId: '15550001111',
    approvedTemplates: [{ name: 'presti_seq', language: 'it' }],
    businessNumber: '+390200000099',
    secret: SECRET,
    nowMs: () => Date.parse(T0),
  });
  const registries = new ChannelRegistries({ channelAdapters: [definition] });
  const database = createDatabase({ path: ':memory:' });
  for (const { sql } of recordModuleMigrations(MANIFESTS.map(([pkg, name]) => ({ name, manifest: manifest(pkg, name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const [, name] of MANIFESTS) {
    const found = MANIFESTS.find(([, manifestName]) => manifestName === name);
    const built = createRecordModuleFromManifest(manifest(found[0], found[1]), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }
  const resolveSecret = async (ref) => {
    if (ref !== SECRET_REF) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return SECRET;
  };
  const clockBox = { ms: Date.parse(T0) };
  const ops = createChannelOperations({
    database,
    modules,
    registries,
    resolveSecret,
    tenantId: TENANT,
    config: {},
    resolveSender: null,
    nowMs: () => clockBox.ms,
  });
  return { database, modules, ops, registries, api, adapterDefinition: definition, resolveSecret, clockBox };
}

function gate(composed) {
  const definition = createSpacePermissionsDomain();
  const offered = definition.capabilities.find((entry) => entry?.name === 'space-permission-gate' && entry?.version === 1);
  assert.ok(offered, 'space-permissions publishes space-permission-gate@1');
  return offered.create({ modules: composed.modules, consumer: 'sequences', now: () => T0 });
}

function queue(composed) {
  // No actor injection: the sweep carries its own timer actor to the outbox,
  // like every production caller of the seam — the assertion below fails a
  // sweep that queues anonymously.
  return {
    queueTemplate: (request) => {
      assert.ok(
        request && typeof request.actor === 'object'
          && typeof request.actor.type === 'string' && typeof request.actor.id === 'string',
        'the sweep carries its timer actor to the outbox',
      );
      return composed.ops.queueTemplateSend(request);
    },
  };
}

function windows(composed, connectionKey) {
  return { [connectionKey]: composed.adapterDefinition.outboundWindow };
}

async function advance(composed, connectionKey, iso, options = {}) {
  composed.clockBox.ms = Date.parse(iso);
  return advanceSequences({
    modules: composed.modules,
    queueTemplate: queue(composed).queueTemplate,
    permissionGate: gate(composed),
    replyWindows: windows(composed, connectionKey),
    now: () => iso,
    actor: SYSTEM,
    personalize: options.personalize ?? undefined,
  });
}

function sequenceOps(composed, connectionKey, extras = {}) {
  const definition = createSequencesPackage({
    spacePermissions: createSpacePermissionsDomain(),
    queueTemplate: queue(composed).queueTemplate,
    replyWindows: windows(composed, connectionKey),
    ...extras,
  });
  const runtime = { modules: composed.modules, config: {} };
  return Object.fromEntries(
    definition.operations.map((entry) => [entry.appMethod, entry.create(runtime)]),
  );
}

async function activeConnection(composed, account = '+390200000099') {
  const reg = await composed.ops.registerChannelConnection({
    spaceId: SPACE,
    channel: 'whatsapp',
    account,
    adapter: WHATSAPP_ADAPTER_NAME,
    adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: SECRET_REF,
    actor: USER,
  });
  const actions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  const connectionService = () => composed.modules.get('channel-connection').service;
  await actions['activate-connection'].execute({
    record: reg.connection,
    input: { reason: 'sequences kit activation' },
    actor: USER,
    modules: composed.modules,
    managed: (id, patch) => connectionService().applyManaged(id, patch, { actor: USER }),
    now: () => T0,
  });
  return reg.connection.sourceKey;
}

const STEPS = [
  {
    dayOffset: 0, channel: 'whatsapp', templateName: 'presti_seq', templateLanguage: 'it',
    templateVars: ['Ciao {{name}}, ti ricordo la lezione di domani alle {{hour}}.'],
  },
  {
    dayOffset: 1, channel: 'whatsapp', templateName: 'presti_seq', templateLanguage: 'it',
    templateVars: ['{{name}}, ultimo posto libero questa settimana: rispondi pure qui.'],
  },
];

async function createActiveSequence(ops, sourceKey, name = 'Lezione di prova') {
  const created = await ops.createSequence({
    spaceId: SPACE, sourceKey, name, steps: STEPS, actor: USER,
  });
  assert.equal(created.replayed, false);
  const activated = await ops.activateSequence({ spaceId: SPACE, sourceKey, actor: USER });
  assert.equal(activated.sequence.status, 'active');
  return created.sequence;
}

async function enroll(ops, connectionKey, sequenceSourceKey, subjectId, to, vars = {}) {
  const enrolled = await ops.enrollSequencePerson({
    spaceId: SPACE,
    sequenceSourceKey,
    subject: { resource: 'contact', id: subjectId, owner: 'host' },
    subjectLabel: vars.name ?? subjectId,
    recipient: to,
    connectionKey,
    actor: USER,
    vars,
  });
  assert.equal(enrolled.enrollment.status, 'active');
  return enrolled.enrollment;
}

function workerKit(composed, clock) {
  const store = createDurableJobStore({ storage: composed.database.storage, tenantId: TENANT, clock });
  const registry = createDurableJobHandlerRegistry();
  composed.ops.registerChannelSendHandlers(registry);
  const worker = createDurableJobWorker({
    store, registry, workerId: 'sequences-kit', actor: SYSTEM, backoff: () => 0, pollIntervalMs: 60000,
  });
  return { store, registry, worker };
}

async function replyRow(composed, connectionKey, to, at, tag = '') {
  const subject = composed.adapterDefinition.outboundWindow.subjectForRecipient(to);
  const inbox = composed.modules.get('channel-inbox-event').service;
  return inbox.createManaged({
    sourceKey: `ch-in:reply:${Date.parse(at)}${tag}`,
    spaceId: SPACE,
    connectionKey,
    importKey: null,
    adapter: WHATSAPP_ADAPTER_NAME,
    adapterVersion: WHATSAPP_ADAPTER_VERSION,
    providerEventId: `wamid.reply.${Date.parse(at)}${tag}`,
    subject,
    payloadFingerprint: 'reply-fixture',
    sequence: 1,
    occurredAt: at,
    receivedAt: at,
    processed: false,
    effect: 'applied',
    effectReason: '',
  }, { actor: SYSTEM });
}

async function allowSends(composed) {
  const overrides = composed.modules.get('space-permission-override').service;
  return overrides.createManaged({
    spaceId: SPACE,
    scopeKey: `${SPACE}:send-without-approval`,
    permission: 'send-without-approval',
    enabled: true,
    updatedBy: 'user:presti-owner',
  }, { actor: USER });
}

test('stop automatico alla prima risposta registrata', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:stop');
  await enroll(ops, connectionKey, 'seq:stop', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  // The first step fires: the timer owns when, and the outbox owns the send.
  const first = await advance(composed, connectionKey, T0);
  assert.equal(first.advanced, 1);
  assert.equal(first.stoppedReplied, 0);
  const sends = composed.modules.get('sequence-send').service;
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:stop' })).length, 1);

  // The reply is recorded after the enrollment: the next advance stops the
  // person instead of firing step two — never a second send for step one.
  await replyRow(composed, connectionKey, TO, T0_LATER);
  const second = await advance(composed, connectionKey, T0_LATER);
  assert.equal(second.stoppedReplied, 1);
  assert.equal(second.advanced, 0);
  const enrollments = composed.modules.get('sequence-enrollment').service;
  const stored = (await enrollments.listWhere({ sequenceSourceKey: 'seq:stop' }))[0];
  assert.equal(stored.status, 'stopped-replied');
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:stop' })).length, 1);

  // Delivery reports for our own send never look like a reply: same advance
  // with only a status row keeps the enrollment untouched.
  const composed2 = compose();
  t.after(() => composed2.database.close());
  const connectionKey2 = await activeConnection(composed2);
  await allowSends(composed2);
  const ops2 = sequenceOps(composed2, connectionKey2);
  await createActiveSequence(ops2, 'seq:stop-status');
  await enroll(ops2, connectionKey2, 'seq:stop-status', 'c-maria', TO, { name: 'Maria', hour: '18:00' });
  const fired = await advance(composed2, connectionKey2, T0);
  assert.equal(fired.advanced, 1);
  const inbox2 = composed2.modules.get('channel-inbox-event').service;
  await inbox2.createManaged({
    sourceKey: 'ch-in:status:1',
    spaceId: SPACE,
    connectionKey: connectionKey2,
    importKey: null,
    adapter: WHATSAPP_ADAPTER_NAME,
    adapterVersion: WHATSAPP_ADAPTER_VERSION,
    providerEventId: 'wamid.sent:delivered:read',
    subject: 'wamid.our-own-send-id',
    payloadFingerprint: 'status-fixture',
    sequence: null,
    occurredAt: T0_LATER,
    receivedAt: T0_LATER,
    processed: false,
    effect: 'applied',
    effectReason: '',
  }, { actor: SYSTEM });
  const after = await advance(composed2, connectionKey2, T0_LATER);
  assert.equal(after.stoppedReplied, 0);
  const enrollments2 = composed2.modules.get('sequence-enrollment').service;
  assert.equal((await enrollments2.listWhere({ sequenceSourceKey: 'seq:stop-status' }))[0].status, 'active');
});

test('senza permesso di invio ogni passo resta in attesa di ok', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  // No override: send-without-approval defaults to off.
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:gate');
  await enroll(ops, connectionKey, 'seq:gate', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  // The due step does not queue: it becomes a human-decided proposal and
  // the step stays due. The provider sees nothing.
  const gated = await advance(composed, connectionKey, T0);
  assert.equal(gated.advanced, 0);
  assert.equal(gated.waitingApproval, 1);
  assert.equal(composed.api.state.sendCalls, 0);
  const sends = composed.modules.get('sequence-send').service;
  const waiting = await sends.listWhere({ sequenceSourceKey: 'seq:gate' });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].status, 'waiting-approval');
  const proposals = composed.modules.get('space-ai-proposal').service;
  const recorded = await proposals.listWhere({ spaceId: SPACE });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, 'proposed');

  // The human approves (switch on): the same step fires on the next advance,
  // exactly once — the waiting row replays instead of queueing twice.
  await allowSends(composed);
  const approved = await advance(composed, connectionKey, T0_LATER);
  assert.equal(approved.advanced, 1);
  assert.equal(approved.waitingApproval, 0);
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:gate' })).length, 1);
  const enrollments = composed.modules.get('sequence-enrollment').service;
  const stored = (await enrollments.listWhere({ sequenceSourceKey: 'seq:gate' }))[0];
  assert.equal(stored.status, 'active');
  assert.equal(stored.currentStep, 1);
});

test('pausa e riattivazione senza invii doppi', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:pause');
  await enroll(ops, connectionKey, 'seq:pause', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  // Step one queues exactly one outbox job under the deterministic key.
  const first = await advance(composed, connectionKey, T0);
  assert.equal(first.advanced, 1);
  const sends = composed.modules.get('sequence-send').service;
  const one = await sends.listWhere({ sequenceSourceKey: 'seq:pause' });
  assert.equal(one.length, 1);
  assert.equal(one[0].status, 'queued');
  const jobId = one[0].jobId;

  // Pause: the advance fires nothing, and a second advance still fires
  // nothing — no retry, no duplicate.
  await ops.pauseSequenceEnrollment({ enrollmentSourceKey: one[0].enrollmentSourceKey, actor: USER });
  const enrollService = composed.modules.get('sequence-enrollment').service;
  assert.equal((await enrollService.listWhere({ sequenceSourceKey: 'seq:pause' }))[0].status, 'paused');
  for (const at of [T0, T0_LATER]) {
    const held = await advance(composed, connectionKey, at);
    assert.equal(held.advanced, 0);
    assert.equal(held.waitingApproval, 0);
  }
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:pause' })).length, 1);

  // Resume: the already-queued step replays onto the same job — still one
  // row, still one job — and the worker confirms it sent.
  const resumed = await ops.resumeSequenceEnrollment({ enrollmentSourceKey: one[0].enrollmentSourceKey, actor: USER });
  assert.equal(resumed.enrollment.status, 'active');
  const again = await advance(composed, connectionKey, T0_LATER);
  assert.equal(again.advanced, 0);
  const rows = await sends.listWhere({ sequenceSourceKey: 'seq:pause' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, jobId);
  const { worker } = workerKit(composed, () => T0_LATER);
  worker.start();
  t.after(() => worker.close());
  const settled = await worker.run(jobId);
  assert.ok(settled && settled.state === 'succeeded', 'the channel job settles');
  const confirmed = await advance(composed, connectionKey, T0_LATER);
  assert.equal(confirmed.confirmed, 1);
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:pause' }))[0].status, 'sent');

  // Step two fires on its day, still exactly once across two advances.
  for (const at of [T1, T1_LATER]) {
    await advance(composed, connectionKey, at);
  }
  const both = await sends.listWhere({ sequenceSourceKey: 'seq:pause' });
  assert.equal(both.length, 2);
  assert.deepEqual(
    both.map((row) => row.stepOrder).sort(),
    [0, 1],
  );
  const bodies = composed.api.sentMessages();
  assert.equal(bodies.length, 1);
  const texts = (bodies[0].template.components?.[0]?.parameters ?? []).map((entry) => entry.text);
  assert.ok(texts.join(' ').includes('Guido'), 'the first step is personalized');
});

test('metriche calcolate dai record', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:metrics');
  await enroll(ops, connectionKey, 'seq:metrics', 'c-guido', TO, { name: 'Guido', hour: '17:00' });
  await enroll(ops, connectionKey, 'seq:metrics', 'c-maria', TO_2, { name: 'Maria', hour: '18:00' });

  await advance(composed, connectionKey, T0);
  await replyRow(composed, connectionKey, TO, T0_LATER);
  await advance(composed, connectionKey, T0_LATER);

  const read = await ops.readSequenceMetrics({ spaceId: SPACE, sourceKey: 'seq:metrics', actor: USER });
  assert.equal(read.enrolled, 2);
  assert.equal(read.active, 1);
  assert.equal(read.stoppedReplied, 1);
  assert.equal(read.paused, 0);
  assert.equal(read.completed, 0);
  assert.equal(read.sends, 2);
  assert.equal(read.perStep.length, 1);
  assert.equal(read.perStep[0].stepOrder, 0);
  assert.equal(read.perStep[0].queued, 2);

  // The metrics prove they count rows, not stored counters: stopping the
  // second person moves the counts with no other write.
  await replyRow(composed, connectionKey, TO_2, T1);
  await advance(composed, connectionKey, T1);
  const reread = await ops.readSequenceMetrics({ spaceId: SPACE, sourceKey: 'seq:metrics', actor: USER });
  assert.equal(reread.active, 0);
  assert.equal(reread.stoppedReplied, 2);
});

test('elenco con stato e metriche', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:list-a', 'Lezione di prova');
  const draft = await ops.createSequence({
    spaceId: SPACE, sourceKey: 'seq:list-b', name: 'Bozza', steps: STEPS.slice(0, 1), actor: USER,
  });
  assert.equal(draft.sequence.status, 'draft');
  const appended = await ops.addSequenceStep({
    spaceId: SPACE, sourceKey: 'seq:list-b', actor: USER, step: STEPS[1],
  });
  assert.equal(appended.replayed, false);
  assert.equal(appended.step.stepOrder, 1);
  await assert.rejects(
    ops.addSequenceStep({ spaceId: SPACE, sourceKey: 'seq:list-a', actor: USER, step: STEPS[1] }),
    (error) => error.code === 'SEQUENCE_NOT_DRAFT',
  );
  await enroll(ops, connectionKey, 'seq:list-a', 'c-guido', TO, { name: 'Guido', hour: '17:00' });
  await advance(composed, connectionKey, T0);

  const elenco = await ops.listSequences({ spaceId: SPACE, actor: USER });
  assert.equal(elenco.length, 2);
  const active = elenco.find((entry) => entry.sourceKey === 'seq:list-a');
  assert.equal(active.status, 'active');
  assert.equal(active.enrolled, 1);
  assert.equal(active.sends, 1);
  const stillDraft = elenco.find((entry) => entry.sourceKey === 'seq:list-b');
  assert.equal(stillDraft.status, 'draft');
  assert.equal(stillDraft.enrolled, 0);
});

async function decideProposal(composed, decision, at) {
  const proposals = composed.modules.get('space-ai-proposal').service;
  const recorded = await proposals.listWhere({ spaceId: SPACE });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, 'proposed');
  await proposals.applyManaged(recorded[0].id, {
    status: decision,
    decidedBy: 'user:presti-owner',
    decidedAt: at,
    refusalReason: decision === 'refused' ? 'not now' : null,
  }, { actor: USER });
}

test("l'ok della persona sblocca il passo anche a interruttore spento", async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  // The global switch stays off: the step waits as a human-decided proposal.
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:human-ok');
  await enroll(ops, connectionKey, 'seq:human-ok', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  const gated = await advance(composed, connectionKey, T0);
  assert.equal(gated.waitingApproval, 1);
  assert.equal(gated.advanced, 0);

  // The human approves that exact proposal: the next sweep queues the step
  // without the global switch, exactly once.
  await decideProposal(composed, 'approved', T0_LATER);
  const unblocked = await advance(composed, connectionKey, T0_LATER);
  assert.equal(unblocked.advanced, 1);
  assert.equal(unblocked.waitingApproval, 0);
  const sends = composed.modules.get('sequence-send').service;
  const rows = await sends.listWhere({ sequenceSourceKey: 'seq:human-ok' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
  const enrollments = composed.modules.get('sequence-enrollment').service;
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:human-ok' }))[0].currentStep, 1);
});

test('il rifiuto della persona salta il passo senza inviare', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:human-no');
  await enroll(ops, connectionKey, 'seq:human-no', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  const gated = await advance(composed, connectionKey, T0);
  assert.equal(gated.waitingApproval, 1);

  // The human refuses: the step is recorded skipped and the cursor moves
  // past it — the sweep never queues, and the next step stays gated.
  await decideProposal(composed, 'refused', T0_LATER);
  const refused = await advance(composed, connectionKey, T0_LATER);
  assert.equal(refused.skipped, 1);
  assert.equal(refused.advanced, 0);
  assert.equal(composed.api.state.sendCalls, 0);
  const sends = composed.modules.get('sequence-send').service;
  const rows = await sends.listWhere({ sequenceSourceKey: 'seq:human-no' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped');
  assert.equal(rows[0].detail, 'SPACE_PROPOSAL_REFUSED');
  const enrollments = composed.modules.get('sequence-enrollment').service;
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:human-no' }))[0].currentStep, 1);
});

test("senza inbox non si invia: l'errore resta nel riepilogo", async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:blind');
  await enroll(ops, connectionKey, 'seq:blind', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  // The inbox read fails transiently: the sweep fires nothing, keeps the
  // enrollment active, and records the failure with the space identifier.
  const inbox = composed.modules.get('channel-inbox-event').service;
  const original = inbox.listWhere.bind(inbox);
  inbox.listWhere = () => {
    throw Object.assign(new Error('transient storage failure'), { code: 'SQLITE_IOERR' });
  };
  let blind;
  try {
    blind = await advance(composed, connectionKey, T0);
  } finally {
    inbox.listWhere = original;
  }
  assert.equal(blind.advanced, 0);
  assert.equal(blind.stoppedReplied, 0);
  assert.equal(blind.inboxUnavailable.length, 1);
  assert.equal(blind.inboxUnavailable[0].spaceId, SPACE);
  assert.equal(blind.inboxUnavailable[0].code, 'SQLITE_IOERR');
  const enrollments = composed.modules.get('sequence-enrollment').service;
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:blind' }))[0].status, 'active');
  const sends = composed.modules.get('sequence-send').service;
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:blind' })).length, 0);

  // The inbox back: the same step fires on the next sweep.
  const seeing = await advance(composed, connectionKey, T0_LATER);
  assert.equal(seeing.advanced, 1);
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:blind' })).length, 1);
});

test("la risposta su un'altra connessione non ferma l'iscrizione", async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  const otherKey = await activeConnection(composed, '+390200000077');
  assert.notEqual(otherKey, connectionKey);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:scoped');
  await enroll(ops, connectionKey, 'seq:scoped', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  // A reply to the same recipient through the OTHER connection is not ours:
  // our enrollment fires instead of stopping.
  await replyRow(composed, otherKey, TO, T0_LATER);
  const fired = await advance(composed, connectionKey, T0);
  assert.equal(fired.advanced, 1);
  assert.equal(fired.stoppedReplied, 0);
  const enrollments = composed.modules.get('sequence-enrollment').service;
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:scoped' }))[0].status, 'active');

  // The same reply through our own connection stops it.
  await replyRow(composed, connectionKey, TO, T0_LATER, ':own');
  const stopped = await advance(composed, connectionKey, T0_LATER);
  assert.equal(stopped.stoppedReplied, 1);
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:scoped' }))[0].status, 'stopped-replied');
});

test('il replay dopo un crash ripara il cursore senza doppi invii', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:crash');
  const enrollment = await enroll(ops, connectionKey, 'seq:crash', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  const first = await advance(composed, connectionKey, T0);
  assert.equal(first.advanced, 1);

  // Crash between the send row and the cursor write: the cursor still points
  // at the queued step while the send row already exists.
  const enrollments = composed.modules.get('sequence-enrollment').service;
  await enrollments.applyManaged(enrollment.id, { currentStep: 0, nextDueAt: T0 }, { actor: USER });

  const replayed = await advance(composed, connectionKey, T0_LATER);
  assert.equal(replayed.advanced, 0);
  const sends = composed.modules.get('sequence-send').service;
  const rows = await sends.listWhere({ sequenceSourceKey: 'seq:crash' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:crash' }))[0].currentStep, 1);

  // The repaired cursor fires step two on its day, still exactly once.
  await advance(composed, connectionKey, T1);
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:crash' })).length, 2);
});

test("l'ultimo invio si conferma prima di chiudere l'iscrizione", async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  const created = await ops.createSequence({
    spaceId: SPACE, sourceKey: 'seq:final', name: 'Solo uno',
    steps: STEPS.slice(0, 1), actor: USER,
  });
  assert.equal(created.steps.length, 1);
  await ops.activateSequence({ spaceId: SPACE, sourceKey: 'seq:final', actor: USER });
  await enroll(ops, connectionKey, 'seq:final', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  const queued = await advance(composed, connectionKey, T0);
  assert.equal(queued.advanced, 1);

  // The send is still unsettled: the enrollment stays active, never
  // completed on an unconfirmed send.
  const pending = await advance(composed, connectionKey, T0_LATER);
  assert.equal(pending.confirmed, 0);
  const enrollments = composed.modules.get('sequence-enrollment').service;
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:final' }))[0].status, 'active');

  // The outbox answers: the confirm pass records the send and then the
  // enrollment completes on the same sweep.
  const sends = composed.modules.get('sequence-send').service;
  const jobId = (await sends.listWhere({ sequenceSourceKey: 'seq:final' }))[0].jobId;
  const { worker } = workerKit(composed, () => T0_LATER);
  worker.start();
  t.after(() => worker.close());
  const settled = await worker.run(jobId);
  assert.ok(settled && settled.state === 'succeeded', 'the channel job settles');
  const confirmed = await advance(composed, connectionKey, T0_LATER);
  assert.equal(confirmed.confirmed, 1);
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:final' }))[0].status, 'sent');
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:final' }))[0].status, 'completed');
});

test('la conferma riusa il testo personalizzato senza mismatch', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  const created = await ops.createSequence({
    spaceId: SPACE, sourceKey: 'seq:rewrite', name: 'Riscritto',
    steps: STEPS.slice(0, 1), actor: USER,
  });
  assert.equal(created.steps.length, 1);
  await ops.activateSequence({ spaceId: SPACE, sourceKey: 'seq:rewrite', actor: USER });
  await enroll(ops, connectionKey, 'seq:rewrite', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  // The AI seam rewrites the variables: the confirm requeue must carry the
  // exact queued payload, or the outbox raises an idempotency mismatch.
  const personalize = async () => ['riscritto: ciao Guido, ore 17:00'];
  const queued = await advance(composed, connectionKey, T0, { personalize });
  assert.equal(queued.advanced, 1);
  const sends = composed.modules.get('sequence-send').service;
  const stored = (await sends.listWhere({ sequenceSourceKey: 'seq:rewrite' }))[0];
  assert.deepEqual(JSON.parse(stored.variables), ['riscritto: ciao Guido, ore 17:00']);

  const { worker } = workerKit(composed, () => T0_LATER);
  worker.start();
  t.after(() => worker.close());
  const settled = await worker.run(stored.jobId);
  assert.ok(settled && settled.state === 'succeeded', 'the channel job settles');
  const confirmed = await advance(composed, connectionKey, T0_LATER, { personalize });
  assert.equal(confirmed.confirmed, 1);
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:rewrite' }))[0].status, 'sent');
});

test('un rifiuto terminale salta il passo e avanza senza riprovare', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, connectionKey);
  await ops.createSequence({
    spaceId: SPACE, sourceKey: 'seq:refused-template', name: 'Modello non approvato',
    steps: [
      { dayOffset: 0, channel: 'whatsapp', templateName: 'presti_seq', templateLanguage: 'it', templateVars: [] },
      {
        dayOffset: 1, channel: 'whatsapp', templateName: 'mai_approvato', templateLanguage: 'it',
        templateVars: ['{{name}}'],
      },
      STEPS[1],
    ],
    actor: USER,
  });
  await ops.activateSequence({ spaceId: SPACE, sourceKey: 'seq:refused-template', actor: USER });
  await enroll(ops, connectionKey, 'seq:refused-template', 'c-guido', TO, { name: 'Guido', hour: '17:00' });

  await advance(composed, connectionKey, T0);
  const second = await advance(composed, connectionKey, T1);
  assert.equal(second.skipped, 1);
  assert.equal(second.advanced, 0);
  const sends = composed.modules.get('sequence-send').service;
  const rows = await sends.listWhere({ sequenceSourceKey: 'seq:refused-template' });
  assert.equal(rows.length, 2);
  const refused = rows.find((row) => row.stepOrder === 1);
  assert.equal(refused.status, 'skipped');
  assert.equal(refused.detail, 'CHANNEL_MESSAGE_MALFORMED');
  const enrollments = composed.modules.get('sequence-enrollment').service;
  // The cursor moved past the refused step: no retry, the next step is due.
  assert.equal((await enrollments.listWhere({ sequenceSourceKey: 'seq:refused-template' }))[0].currentStep, 2);

  // Step three is due a day after the refused step fired, not five minutes after.
  const thirdDue = new Date(Date.parse(T1) + 24 * 60 * 60 * 1000).toISOString();
  const third = await advance(composed, connectionKey, thirdDue);
  assert.equal(third.advanced, 1);
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:refused-template' })).length, 3);
});

test('la create interrotta riprende i passi mancanti', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  await activeConnection(composed);
  await allowSends(composed);
  const ops = sequenceOps(composed, 'unused-connection-key');
  const created = await ops.createSequence({
    spaceId: SPACE, sourceKey: 'seq:partial', name: 'Parziale', steps: STEPS, actor: USER,
  });
  assert.equal(created.replayed, false);
  assert.equal(created.steps.length, 2);

  // A crash after the first step row: the retry carries the same payload and
  // completes the deterministic step rows instead of returning a truncated set.
  composed.database.raw.exec("DELETE FROM sequence_steps WHERE source_key = 'seq-step:seq:partial:1'");
  const replayed = await ops.createSequence({
    spaceId: SPACE, sourceKey: 'seq:partial', name: 'Parziale', steps: STEPS, actor: USER,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.steps.length, 2);
  assert.deepEqual(replayed.steps.map((step) => step.stepOrder), [0, 1]);
});

test('il pacchetto dichiara il contratto richiesto', async () => {
  const v1 = createSequencesPackage({});
  assert.equal(v1.packageContract, 1);
  const v2 = createSequencesPackage({ packageContract: 2 });
  assert.equal(v2.packageContract, 2);
});