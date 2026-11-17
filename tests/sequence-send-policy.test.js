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
  createSequencesPackage,
} from '../packages/sequences/src/index.js';
import { addSuppression } from '../packages/sequences/src/sequences.js';
import {
  capForChannel,
  isInsideSendWindow,
  matchSuppression,
  nextWindowStartMs,
  parsePlaybookHours,
  romeDayKey,
} from '../packages/sequences/src/send-policy.js';

/**
 * Space send rules for every send agents or sequences propose
 * (backlog:b6f8a6504a24 — Kombo map 12/11, sections 8-9): one test per
 * acceptance criterion, plus the pure rule math underneath.
 *
 * 1. A due send outside the playbook window waits for the next window
 *    start — nothing is queued and no proposal forms.
 * 2. Past the daily per-channel cap a send waits for the next day, and
 *    the approval proposal says so (`Tetto giornaliero … raggiunto`).
 * 3. A person with an active enrollment never enters a second journey
 *    (`SEQUENCE_ALREADY_ENROLLED`); re-enrolling replays.
 * 4. A listed domain or contact never forms a proposal: the step is
 *    refused row-locally with the list's reason (`DO_NOT_CONTACT`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SYSTEM = { type: 'system', id: 'sequences-kit' };
const SPACE = 'presti';
const TENANT = 'send-policy-kit';
const SECRET_REF = 'vault://kit/whatsapp-send-policy';
const SECRET = 'whatsapp-fake-send-policy';
const TO = '+393331112223';
const PLAYBOOK_HOURS = 'Lun-Ven 6:30-22:00, Sab 8:00-13:00';

const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const MANIFESTS = [
  ['sequences', 'sequence'],
  ['sequences', 'sequence-step'],
  ['sequences', 'sequence-enrollment'],
  ['sequences', 'sequence-send'],
  ['sequences', 'sequence-suppression'],
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
    nowMs: () => Date.now(),
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
  // No playbook row by default: no constraint, older spaces send as before.
  modules.set('sales-playbook', { service: { getBySpace: async () => null, listWhere: async () => [] } });
  const resolveSecret = async (ref) => {
    if (ref !== SECRET_REF) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return SECRET;
  };
  const clockBox = { ms: Date.now() };
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

function withPlaybookHours(composed, hours) {
  composed.modules.set('sales-playbook', {
    service: {
      getBySpace: async () => ({ hours }),
      listWhere: async () => [{ hours }],
    },
  });
}

function gate(composed, nowIso) {
  const definition = createSpacePermissionsDomain();
  const offered = definition.capabilities.find((entry) => entry?.name === 'space-permission-gate' && entry?.version === 1);
  assert.ok(offered, 'space-permissions publishes space-permission-gate@1');
  return offered.create({ modules: composed.modules, consumer: 'sequences', now: () => nowIso });
}

function queue(composed) {
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

async function advance(composed, connectionKey, iso) {
  composed.clockBox.ms = Date.parse(iso);
  return advanceSequences({
    modules: composed.modules,
    queueTemplate: queue(composed).queueTemplate,
    permissionGate: gate(composed, iso),
    replyWindows: { [connectionKey]: composed.adapterDefinition.outboundWindow },
    now: () => iso,
    actor: SYSTEM,
  });
}

function sequenceOps(composed, connectionKey) {
  const definition = createSequencesPackage({
    spacePermissions: createSpacePermissionsDomain(),
    queueTemplate: queue(composed).queueTemplate,
    replyWindows: { [connectionKey]: composed.adapterDefinition.outboundWindow },
  });
  const runtime = { modules: composed.modules, config: {} };
  return Object.fromEntries(
    definition.operations.map((entry) => [entry.appMethod, entry.create(runtime)]),
  );
}

async function activeConnection(composed, account = '+390200000099', spaceId = SPACE) {
  const reg = await composed.ops.registerChannelConnection({
    spaceId,
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
    input: { reason: 'send-policy kit activation' },
    actor: USER,
    modules: composed.modules,
    managed: (id, patch) => connectionService().applyManaged(id, patch, { actor: USER }),
    now: () => new Date().toISOString(),
  });
  return reg.connection.sourceKey;
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

const ONE_STEP = [
  {
    dayOffset: 0, channel: 'whatsapp', templateName: 'presti_seq', templateLanguage: 'it',
    templateVars: ['Ciao {{name}}, ti ricordo la lezione di domani alle {{hour}}.'],
  },
];

const TWO_STEPS = [
  ...ONE_STEP,
  {
    dayOffset: 1, channel: 'whatsapp', templateName: 'presti_seq', templateLanguage: 'it',
    templateVars: ['{{name}}, ultimo posto libero questa settimana: rispondi pure qui.'],
  },
];

async function createActiveSequence(ops, sourceKey, steps = TWO_STEPS) {
  const created = await ops.createSequence({ spaceId: SPACE, sourceKey, name: 'Invii spazio', steps, actor: USER });
  assert.equal(created.replayed, false);
  const activated = await ops.activateSequence({ spaceId: SPACE, sourceKey, actor: USER });
  assert.equal(activated.sequence.status, 'active');
  return created.sequence;
}

/** The next Rome Sunday (any time: Sundays carry no send window). */
function nextSundayMs() {
  const step = 15 * 60 * 1000;
  let ms = Math.floor((Date.now() + 10 * 60 * 1000) / step) * step;
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', weekday: 'short' });
  for (let i = 0; i < 8 * 24 * 4; i += 1) {
    if (format.format(new Date(ms)) === 'Sun') return ms;
    ms += step;
  }
  throw new Error('no Sunday found in the next eight days');
}

test('fuori orario: l\u2019invio aspetta la prossima finestra, senza coda n\u00e9 proposta', async (t) => {
  // Pure math on fixed dates (November 2026, Rome is UTC+1).
  const windows = parsePlaybookHours(PLAYBOOK_HOURS);
  assert.ok(windows, 'the Kombo playbook text parses');
  const sunNoon = Date.parse('2026-11-15T11:00:00.000Z'); // Sunday 12:00 in Rome
  assert.equal(isInsideSendWindow(sunNoon, windows), false);
  assert.equal(isInsideSendWindow(Date.parse('2026-11-16T08:00:00.000Z'), windows), true); // Monday 9:00
  assert.equal(
    nextWindowStartMs(sunNoon, windows),
    Date.parse('2026-11-16T05:30:00.000Z'), // Monday 6:30 in Rome
  );
  assert.equal(parsePlaybookHours(''), null);
  assert.equal(parsePlaybookHours('orari strani senza numeri'), null);

  // Sweep wiring: even an allowed send waits outside the window.
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  withPlaybookHours(composed, PLAYBOOK_HOURS);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:window');
  await ops.enrollSequencePerson({
    spaceId: SPACE,
    sequenceSourceKey: 'seq:window',
    subject: { resource: 'contact', id: 'c-guido', owner: 'host' },
    subjectLabel: 'Guido',
    recipient: TO,
    connectionKey,
    actor: USER,
    vars: { name: 'Guido', hour: '17:00' },
  });
  const at = new Date(nextSundayMs()).toISOString();
  const swept = await advance(composed, connectionKey, at);
  assert.equal(swept.advanced, 0);
  assert.equal(swept.waitingApproval, 0);
  assert.equal(composed.api.state.sendCalls, 0);
  const sends = composed.modules.get('sequence-send').service;
  assert.equal((await sends.listWhere({ sequenceSourceKey: 'seq:window' })).length, 0);
  const proposals = composed.modules.get('space-ai-proposal').service;
  assert.equal((await proposals.listWhere({ spaceId: SPACE })).length, 0);
  const enrollments = composed.modules.get('sequence-enrollment').service;
  const stored = (await enrollments.listWhere({ sequenceSourceKey: 'seq:window' }))[0];
  const expected = new Date(nextWindowStartMs(Date.parse(at), windows)).toISOString();
  assert.equal(stored.nextDueAt, expected);
});

test('tetto giornaliero: al ventunesimo whatsapp la proposta dice che si parte domani', async (t) => {
  assert.equal(capForChannel('whatsapp'), 20);
  assert.equal(capForChannel('email'), 40);
  assert.equal(capForChannel('piccione'), 40);

  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  // No permission: the step becomes a human-decided proposal.
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:cap', ONE_STEP);
  const at = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const sends = composed.modules.get('sequence-send').service;
  for (let i = 0; i < 20; i += 1) {
    await sends.createManaged({
      sourceKey: `seq-cap:fill:${i}`,
      enrollmentSourceKey: `seq-cap:fake-enroll:${i}`,
      sequenceSourceKey: 'seq:cap',
      spaceId: SPACE,
      stepOrder: 0,
      messageKey: `seq-cap:fake:${i}`,
      jobId: `fake-job-${i}`,
      variables: '[]',
      status: 'queued',
      queuedAt: at,
      decidedAt: at,
      detail: '',
      actorType: 'system',
      actorId: 'send-policy-kit',
    }, { actor: SYSTEM });
  }
  await ops.enrollSequencePerson({
    spaceId: SPACE,
    sequenceSourceKey: 'seq:cap',
    subject: { resource: 'contact', id: 'c-maria', owner: 'host' },
    subjectLabel: 'Maria',
    recipient: '+393334445556',
    connectionKey,
    actor: USER,
    vars: { name: 'Maria', hour: '18:00' },
  });
  const swept = await advance(composed, connectionKey, at);
  assert.equal(swept.advanced, 0);
  assert.equal(swept.waitingApproval, 1);
  const proposals = composed.modules.get('space-ai-proposal').service;
  const recorded = await proposals.listWhere({ spaceId: SPACE });
  assert.equal(recorded.length, 1);
  assert.match(recorded[0].summary, /Tetto giornaliero whatsapp raggiunto/);
  const enrollments = composed.modules.get('sequence-enrollment').service;
  const stored = (await enrollments.listWhere({ sequenceSourceKey: 'seq:cap' }))[0];
  assert.ok(stored.nextDueAt > at, 'the step waits instead of firing tonight');
  assert.notEqual(romeDayKey(Date.parse(stored.nextDueAt)), romeDayKey(Date.parse(at)));
});

test('una persona in un percorso attivo non entra in un secondo', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:prima');
  await createActiveSequence(ops, 'seq:seconda');
  const first = await ops.enrollSequencePerson({
    spaceId: SPACE,
    sequenceSourceKey: 'seq:prima',
    subject: { resource: 'contact', id: 'c-doppio', owner: 'host' },
    subjectLabel: 'Doppio',
    recipient: TO,
    connectionKey,
    actor: USER,
    vars: {},
  });
  assert.equal(first.enrollment.status, 'active');
  await assert.rejects(
    ops.enrollSequencePerson({
      spaceId: SPACE,
      sequenceSourceKey: 'seq:seconda',
      subject: { resource: 'contact', id: 'c-doppio', owner: 'host' },
      subjectLabel: 'Doppio',
      recipient: TO,
      connectionKey,
      actor: USER,
      vars: {},
    }),
    (error) => error?.code === 'SEQUENCE_ALREADY_ENROLLED',
  );
  const replay = await ops.enrollSequencePerson({
    spaceId: SPACE,
    sequenceSourceKey: 'seq:prima',
    subject: { resource: 'contact', id: 'c-doppio', owner: 'host' },
    subjectLabel: 'Doppio',
    recipient: TO,
    connectionKey,
    actor: USER,
    vars: {},
  });
  assert.equal(replay.replayed, true);
});

test('dominio da non contattare: la proposta non si forma, il motivo resta nella riga', async (t) => {
  assert.deepEqual(
    matchSuppression({
      recipient: 'Luca@Bloccato.it',
      rows: [{ kind: 'domain', value: 'bloccato.it', reason: 'opt-out', status: 'active' }],
    }),
    { kind: 'domain', value: 'bloccato.it', reason: 'opt-out' },
  );
  assert.equal(
    matchSuppression({
      recipient: '+393331112223',
      rows: [{ kind: 'domain', value: 'bloccato.it', reason: 'opt-out', status: 'active' }],
    }),
    null,
  );
  assert.equal(
    matchSuppression({
      recipient: '+393331112223',
      rows: [{ kind: 'domain', value: 'bloccato.it', reason: 'opt-out', status: 'removed' }],
    }),
    null,
  );

  const composed = compose();
  t.after(() => composed.database.close());
  const connectionKey = await activeConnection(composed);
  await allowSends(composed);
  const listed = await addSuppression({
    modules: composed.modules,
    input: {
      spaceId: SPACE,
      kind: 'domain',
      value: 'bloccato.it',
      reason: 'il cliente ha chiesto di non essere ricontattato',
      actor: USER,
    },
  });
  assert.equal(listed.replayed, false);
  assert.equal(listed.suppression.status, 'active');
  const ops = sequenceOps(composed, connectionKey);
  await createActiveSequence(ops, 'seq:stop-list');
  await ops.enrollSequencePerson({
    spaceId: SPACE,
    sequenceSourceKey: 'seq:stop-list',
    subject: { resource: 'contact', id: 'c-luca', owner: 'host' },
    subjectLabel: 'Luca',
    recipient: 'luca@bloccato.it',
    connectionKey,
    actor: USER,
    vars: { name: 'Luca', hour: '17:00' },
  });
  const at = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const swept = await advance(composed, connectionKey, at);
  assert.equal(swept.advanced, 0);
  assert.equal(swept.skipped, 1);
  assert.equal(composed.api.state.sendCalls, 0);
  const sends = composed.modules.get('sequence-send').service;
  const rows = await sends.listWhere({ sequenceSourceKey: 'seq:stop-list' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'skipped');
  assert.match(rows[0].detail, /DO_NOT_CONTACT: il cliente ha chiesto di non essere ricontattato/);
  const proposals = composed.modules.get('space-ai-proposal').service;
  assert.equal((await proposals.listWhere({ spaceId: SPACE })).length, 0);
  const enrollments = composed.modules.get('sequence-enrollment').service;
  const stored = (await enrollments.listWhere({ sequenceSourceKey: 'seq:stop-list' }))[0];
  assert.equal(stored.status, 'active');
  assert.equal(stored.currentStep, 1);
});
