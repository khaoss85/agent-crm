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
import { createAgentsPackage } from '../packages/agents/src/index.js';
import { createAgentOperations } from '../packages/agents/src/operations.js';

/**
 * Teammate agents — the automation engine (backlog:8986f4459f0f).
 *
 * Real sqlite plus the real record services. The four acceptance tests map
 * one-to-one to the backlog criteria: a phrase becomes a recurring
 * assignment with a cadence and a next run (explicit plan as the fake AI,
 * and the built-in Italian parser); an execution proposes actions that wait
 * for a human approval, or stores a versioned artifact; the spending cap
 * stops executions over the threshold and says so; every execution is
 * recorded with agent, assignment, cost and outcome.
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SYSTEM = { type: 'system', id: 'agent-sweep' };
const SPACE = 'presti';
// Monday 2026-11-02, 07:00 UTC — before the 08:00 default run time.
const MON_07 = '2026-11-02T07:00:00.000Z';
const MON_0801 = '2026-11-02T08:01:00.000Z';

const manifest = (name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', 'agents', 'modules', `${name}.module.json`), 'utf8'),
);

const MANIFESTS = ['teammate-agent', 'teammate-assignment', 'teammate-run'];

function compose(nowIso = MON_07, options = {}) {
  const database = createDatabase({ path: ':memory:' });
  for (const { sql } of recordModuleMigrations(MANIFESTS.map((name) => ({ name, manifest: manifest(name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const name of MANIFESTS) {
    const built = createRecordModuleFromManifest(manifest(name), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }
  const ops = createAgentOperations({ modules, now: () => nowIso, ...options });
  return { database, modules, ops };
}

async function makeAgent(ops, over = {}) {
  const { agent } = await ops.createAgent({
    actor: USER,
    spaceId: SPACE,
    sourceKey: over.sourceKey ?? 'ag-vendite',
    name: over.name ?? 'Vendi',
    role: over.role ?? 'Prepara il report vendite',
    instructions: over.instructions ?? 'Leggi le vendite e proponi il report.',
    ...(over.spendingCapCents === undefined ? {} : { spendingCapCents: over.spendingCapCents }),
  });
  return agent;
}

test('a phrase becomes a recurring assignment with a cadence and a next run', async () => {
  const { ops } = compose();
  await makeAgent(ops);
  // Explicit plan: the fake-AI seam.
  const planned = await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-report-plan',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  assert.equal(planned.duplicate, false);
  assert.equal(planned.assignment.cadence, 'weekly');
  assert.equal(planned.assignment.nextRunAt, '2026-11-02T08:00:00.000Z');
  // Built-in Italian parser, no plan.
  const parsed = await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-report-phrase',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
  });
  assert.equal(parsed.assignment.cadence, 'weekly');
  assert.equal(parsed.assignment.nextRunAt, '2026-11-02T08:00:00.000Z');
  // A retry replays the stored assignment instead of doubling it.
  const replay = await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-report-plan',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  assert.equal(replay.duplicate, true);
});

test('an unclear phrase refuses instead of guessing a cadence', async () => {
  const { ops } = compose();
  await makeAgent(ops);
  await assert.rejects(
    () => ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey: 'as-vague',
      agentSourceKey: 'ag-vendite',
      phrase: 'fai qualcosa di utile ogni tanto',
    }),
    (error) => error.code === 'AGENT_PHRASE_UNCLEAR',
  );
});

test('an execution proposes actions that apply only after a human approval', async () => {
  const { ops } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-report',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  const applied = [];
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals',
      costCents: 12,
      proposals: [{ action: 'draft-report', payload: { title: 'Report vendite' } }],
    }),
  });
  assert.deepEqual(summary, { advanced: 1, proposed: 1, artifacts: 0, capped: 0, failed: 0, errors: [] });
  assert.equal(applied.length, 0, 'nothing is applied before approval');
  // The proposal waits: approving with a non-human actor refuses.
  await assert.rejects(
    () => ops.approveRun({
      actor: SYSTEM, spaceId: SPACE, runSourceKey: 'run:as-report:2026-11-02T08:01:00.000Z', applyAction: async () => ({}),
    }),
    (error) => error.code === 'AGENT_APPROVAL_FORBIDDEN',
  );
});

test('approval applies every proposal through the governed seam and marks the run applied', async () => {
  const { ops } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-report',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals',
      costCents: 12,
      proposals: [
        { action: 'draft-report', payload: { title: 'Report vendite' } },
        { action: 'notify-owner', payload: { channel: 'whatsapp' } },
      ],
    }),
  });
  const applied = [];
  const { run } = await ops.approveRun({
    actor: USER,
    spaceId: SPACE,
    runSourceKey: 'run:as-report:2026-11-02T08:01:00.000Z',
    applyAction: async ({ proposal }) => {
      applied.push(proposal.action);
      return { ok: true };
    },
  });
  assert.deepEqual(applied, ['draft-report', 'notify-owner']);
  assert.equal(run.outcome, 'applied');
});

test('a denied space gate blocks the approval and the proposals stay waiting', async () => {
  const { ops } = compose(MON_07, { permissionGate: { verdict: async () => ({ allowed: false }) } });
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-report',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals',
      costCents: 5,
      proposals: [{ action: 'draft-report', payload: { title: 'x' } }],
    }),
  });
  let applied = 0;
  await assert.rejects(
    () => ops.approveRun({
      actor: USER,
      spaceId: SPACE,
      runSourceKey: 'run:as-report:2026-11-02T08:01:00.000Z',
      applyAction: async () => { applied += 1; return { ok: true }; },
    }),
    (error) => error.code === 'AGENT_APPROVAL_DENIED',
  );
  assert.equal(applied, 0);
});

test('an execution can store a versioned artifact instead of proposals', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-report',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  const first = await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({ kind: 'artifact', costCents: 7, artifact: { week: 1, total: 12 } }),
  });
  assert.equal(first.artifacts, 1);
  const second = await ops.runDue({
    actor: SYSTEM,
    at: '2026-11-09T08:01:00.000Z',
    execute: async () => ({ kind: 'artifact', costCents: 7, artifact: { week: 2, total: 15 } }),
  });
  assert.equal(second.artifacts, 1);
  const rows = await modules.get('teammate-run').service.listWhere({ spaceId: SPACE });
  const versions = rows.map((row) => row.artifactVersion).sort();
  assert.deepEqual(versions, [1, 2]);
});

test('the spending cap stops executions over the threshold and says so', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops, { sourceKey: 'ag-capped', spendingCapCents: 100 });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-capped',
    agentSourceKey: 'ag-capped',
    phrase: 'ogni giorno il report vendite',
    plan: { cadence: 'daily', timeOfDay: '08:00' },
    costPerRunCents: 60,
  });
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return { kind: 'artifact', costCents: 60, artifact: { day: executions } };
  };
  const first = await ops.runDue({ actor: SYSTEM, at: MON_0801, execute });
  assert.equal(first.artifacts, 1);
  assert.equal(executions, 1);
  const second = await ops.runDue({ actor: SYSTEM, at: '2026-11-03T08:01:00.000Z', execute });
  assert.deepEqual([second.capped, second.artifacts, executions], [1, 0, 1]);
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, assignmentSourceKey: 'as-capped' });
  const capped = rows.find((row) => row.outcome === 'capped');
  assert.ok(capped, 'the capped run is recorded');
  assert.equal(capped.costCents, 0);
  assert.match(capped.note, /cap/i);
});

test('every execution is recorded with agent, assignment, cost and outcome', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops, { sourceKey: 'ag-log', spendingCapCents: 1000 });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-log',
    agentSourceKey: 'ag-log',
    phrase: 'ogni giorno il report vendite',
    plan: { cadence: 'daily', timeOfDay: '08:00' },
  });
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals', costCents: 9, proposals: [{ action: 'draft-report', payload: {} }],
    }),
  });
  await ops.runDue({
    actor: SYSTEM,
    at: '2026-11-03T08:01:00.000Z',
    execute: async () => { throw Object.assign(new Error('provider down'), { code: 'PROVIDER_DOWN' }); },
  });
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, assignmentSourceKey: 'as-log' });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.agentSourceKey, 'ag-log');
    assert.equal(row.assignmentSourceKey, 'as-log');
    assert.ok(Number.isInteger(row.costCents));
    assert.ok(['proposed', 'failed'].includes(row.outcome), `unexpected outcome ${row.outcome}`);
  }
  const outcomes = rows.map((row) => row.outcome).sort();
  assert.deepEqual(outcomes, ['failed', 'proposed']);
});

test('the package declares its identity, resources and operations', () => {
  const graph = createAgentsPackage({});
  assert.equal(graph.name, 'agents');
  assert.deepEqual(graph.resources, ['teammate-agent', 'teammate-assignment', 'teammate-run']);
  const names = (graph.operations ?? []).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['approve-run', 'create-agent', 'create-assignment', 'run-due']);
});
