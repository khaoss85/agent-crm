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
// The due slot instant: run identity comes from the assignment's nextRunAt,
// never from the sweep clock, so every sweep of this slot mints this key.
const SLOT_0800 = '2026-11-02T08:00:00.000Z';

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
  assert.deepEqual(summary, { advanced: 1, proposed: 1, applied: 0, artifacts: 0, capped: 0, failed: 0, skipped: 0, errors: [] });
  assert.equal(applied.length, 0, 'nothing is applied before approval');
  // The proposal waits: approving with a non-human actor refuses.
  await assert.rejects(
    () => ops.approveRun({
      actor: SYSTEM, spaceId: SPACE, runSourceKey: 'run:as-report:2026-11-02T08:00:00.000Z', applyAction: async () => ({}),
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
    runSourceKey: 'run:as-report:2026-11-02T08:00:00.000Z',
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
      runSourceKey: 'run:as-report:2026-11-02T08:00:00.000Z',
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
    costPerRunCents: 9,
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

test('a capped agent refuses an assignment without a cost estimate', async () => {
  const { ops } = compose();
  await makeAgent(ops, { sourceKey: 'ag-cap', spendingCapCents: 100 });
  await assert.rejects(
    () => ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey: 'as-noest',
      agentSourceKey: 'ag-cap',
      phrase: 'ogni giorno il report',
      plan: { cadence: 'daily', timeOfDay: '08:00' },
    }),
    (error) => error.code === 'AGENT_COST_ESTIMATE_REQUIRED',
  );
});

test('two overlapping sweeps execute once: the loser never re-executes', async () => {
  const { ops } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-race',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  let executions = 0;
  const execute = async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { kind: 'artifact', costCents: 3, artifact: { n: executions } };
  };
  const [first, second] = await Promise.all([
    ops.runDue({ actor: SYSTEM, at: MON_0801, execute }),
    ops.runDue({ actor: SYSTEM, at: MON_0801, execute }),
  ]);
  assert.equal(executions, 1, 'one execution for one due slot');
  // Per-agent serialization: the loser waits for the winner's finalize,
  // then replays its terminal row instead of skipping a live claim.
  assert.equal(first.artifacts + second.artifacts, 2);
  assert.equal(first.skipped + second.skipped, 0);
});

test('a retry at the same instant replays every terminal outcome with the exact summary shape', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops);
  const outcomes = ['proposed', 'applied', 'artifact', 'capped', 'failed'];
  for (const outcome of outcomes) {
    await ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey: `as-replay-${outcome}`,
      agentSourceKey: 'ag-vendite',
      phrase: 'ogni lunedì il report vendite',
      plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
    });
    await modules.get('teammate-run').service.createManaged({
      sourceKey: `run:as-replay-${outcome}:${SLOT_0800}`,
      spaceId: SPACE,
      agentSourceKey: 'ag-vendite',
      assignmentSourceKey: `as-replay-${outcome}`,
      startedAt: SLOT_0800,
      decidedAt: MON_0801,
      actorType: 'system',
      actorId: 'agent-sweep',
      sourcePackage: 'agents',
      sourceAction: 'run-due',
      costCents: 5,
      outcome,
      proposals: outcome === 'proposed' ? '[]' : undefined,
    }, { actor: SYSTEM });
  }
  let executions = 0;
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => { executions += 1; throw new Error('must not execute on replay'); },
  });
  assert.equal(executions, 0, 'a retry replays the stored rows, never executes again');
  // Exact shape: no NaN, no verbatim 'artifact' key, 'applied' has its bucket.
  assert.deepEqual(summary, {
    advanced: 5, proposed: 1, applied: 1, artifacts: 1, capped: 1, failed: 1, skipped: 0, errors: [],
  });
});

test('two concurrent capped sweeps never crash: one records, the other replays', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops, { sourceKey: 'ag-race-cap', spendingCapCents: 100 });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-race-cap',
    agentSourceKey: 'ag-race-cap',
    phrase: 'ogni giorno il report',
    plan: { cadence: 'daily', timeOfDay: '08:00' },
    costPerRunCents: 60,
  });
  await modules.get('teammate-run').service.createManaged({
    sourceKey: 'run:as-race-cap:2026-11-01T08:01:00.000Z',
    spaceId: SPACE,
    agentSourceKey: 'ag-race-cap',
    assignmentSourceKey: 'as-race-cap',
    startedAt: '2026-11-01T08:01:00.000Z',
    decidedAt: '2026-11-01T08:01:00.000Z',
    actorType: 'system',
    actorId: 'agent-sweep',
    sourcePackage: 'agents',
    sourceAction: 'run-due',
    costCents: 100,
    outcome: 'artifact',
    artifact: JSON.stringify({ day: 1 }),
    artifactVersion: 1,
  }, { actor: SYSTEM });
  let executions = 0;
  const execute = async () => { executions += 1; return { kind: 'artifact', costCents: 1, artifact: {} }; };
  const [first, second] = await Promise.all([
    ops.runDue({ actor: SYSTEM, at: MON_0801, execute }),
    ops.runDue({ actor: SYSTEM, at: MON_0801, execute }),
  ]);
  assert.equal(executions, 0, 'over the cap nothing executes');
  assert.equal(first.capped + second.capped, 2, 'winner records capped, loser replays capped');
  assert.equal(first.advanced + second.advanced, 2);
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, assignmentSourceKey: 'as-race-cap', sourceKey: `run:as-race-cap:${SLOT_0800}` });
  assert.equal(rows.length, 1, 'one capped row per slot');
  assert.equal(rows[0].outcome, 'capped');
});

test('two sweeps at different milliseconds contend one slot key: one executes', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-ms-race',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  let executions = 0;
  const execute = async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { kind: 'artifact', costCents: 3, artifact: { n: executions } };
  };
  const [first, second] = await Promise.all([
    ops.runDue({ actor: SYSTEM, at: '2026-11-02T08:01:00.100Z', execute }),
    ops.runDue({ actor: SYSTEM, at: '2026-11-02T08:01:00.200Z', execute }),
  ]);
  assert.equal(executions, 1, 'different sweep clocks still share one slot');
  // Per-agent serialization: the loser waits for the winner's finalize,
  // then replays its terminal row instead of skipping a live claim.
  assert.equal(first.artifacts + second.artifacts, 2);
  assert.equal(first.skipped + second.skipped, 0);
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, assignmentSourceKey: 'as-ms-race' });
  assert.equal(rows.length, 1, 'one row per slot');
  assert.equal(rows[0].sourceKey, `run:as-ms-race:${SLOT_0800}`);
  assert.equal(rows[0].startedAt, SLOT_0800, 'slot identity is the due instant, not the sweep clock');
});

test('a capped sweep that takes over a stale claim counts and advances once', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops, { sourceKey: 'ag-stale-cap', spendingCapCents: 100 });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-stale-cap',
    agentSourceKey: 'ag-stale-cap',
    phrase: 'ogni giorno il report',
    plan: { cadence: 'daily', timeOfDay: '08:00' },
    costPerRunCents: 60,
  });
  const service = modules.get('teammate-run').service;
  const managed = {
    spaceId: SPACE,
    agentSourceKey: 'ag-stale-cap',
    assignmentSourceKey: 'as-stale-cap',
    actorType: 'system',
    actorId: 'agent-sweep',
    sourcePackage: 'agents',
    sourceAction: 'run-due',
  };
  // November spend already at 60c, so the 60c estimate no longer fits the
  // 100c cap and the sweep takes the capped branch without executing.
  await service.createManaged({
    ...managed,
    sourceKey: 'run:as-stale-cap:2026-11-01T08:00:00.000Z',
    startedAt: '2026-11-01T08:00:00.000Z',
    decidedAt: '2026-11-01T08:00:00.000Z',
    costCents: 60,
    outcome: 'artifact',
    artifact: JSON.stringify({ day: 1 }),
    artifactVersion: 1,
  }, { actor: SYSTEM });
  // A crashed sweep left a `started` row for this slot, claimed long ago
  // (stale past the 15-minute claim lease under the MON_07 clock).
  const slotKey = `run:as-stale-cap:${SLOT_0800}`;
  await service.createManaged({
    ...managed,
    sourceKey: slotKey,
    startedAt: SLOT_0800,
    decidedAt: '2026-11-01T07:00:00.000Z',
    costCents: 0,
    outcome: 'started',
    note: 'Slot claimed, execution not yet recorded.',
  }, { actor: SYSTEM });
  let executions = 0;
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => { executions += 1; return { kind: 'artifact', costCents: 1, artifact: {} }; },
  });
  assert.equal(executions, 0, 'over the cap nothing executes');
  assert.equal(summary.capped, 1, 'the stolen stale claim counts exactly once');
  assert.equal(summary.advanced, 1, 'the slot advances exactly once');
  const rows = await service.listWhere({ spaceId: SPACE, sourceKey: slotKey });
  assert.equal(rows.length, 1, 'one capped row per slot');
  assert.equal(rows[0].outcome, 'capped');
});

test('an executor that reports far above the cap is stopped, not recorded as a success', async () => {
  const { ops, modules } = compose();
  const kinds = { artifact: 'ag-liar-artifact', proposals: 'ag-liar-proposals' };
  for (const [kind, agentSourceKey] of Object.entries(kinds)) {
    await makeAgent(ops, { sourceKey: agentSourceKey, spendingCapCents: 100 });
    await ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey: `as-liar-${kind}`,
      agentSourceKey,
      phrase: 'ogni giorno il report',
      plan: { cadence: 'daily', timeOfDay: '08:00' },
      costPerRunCents: 60,
    });
  }
  let executions = 0;
  const execute = async ({ assignment }) => {
    executions += 1;
    return assignment.sourceKey === 'as-liar-artifact'
      ? { kind: 'artifact', costCents: 1000, artifact: { total: 1 } }
      : { kind: 'proposals', costCents: 1000, proposals: [{ action: 'draft-report', payload: {} }] };
  };
  const summary = await ops.runDue({ actor: SYSTEM, at: MON_0801, execute });
  assert.deepEqual([summary.capped, summary.artifacts, summary.proposed], [2, 0, 0]);
  for (const agentSourceKey of Object.values(kinds)) {
    const rows = await modules.get('teammate-run').service
      .listWhere({ spaceId: SPACE, agentSourceKey });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'capped', 'the overrun is flagged, not a success');
    assert.equal(rows[0].costCents, 1000, 'the true cost stays on the ledger');
    assert.match(rows[0].note, /cap/i);
    assert.ok(!rows[0].artifact && !rows[0].proposals, 'nothing is stored from an over-cap run');
  }
  // The ledger now exceeds the cap: the next sweep stops at the gate
  // without executing again.
  const second = await ops.runDue({ actor: SYSTEM, at: '2026-11-03T08:01:00.000Z', execute });
  assert.equal(second.capped, 2);
  assert.equal(executions, 2, 'no execution past the overrun');
});

test('two concurrent approvals apply each proposal once', async () => {
  const { ops } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-approve-race',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals',
      costCents: 4,
      proposals: [
        { action: 'draft-report', payload: {} },
        { action: 'notify-owner', payload: {} },
      ],
    }),
  });
  const runKey = `run:as-approve-race:${SLOT_0800}`;
  const counts = new Map();
  const applyAction = async ({ proposal, idempotencyKey }) => {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    counts.set(proposal.action, (counts.get(proposal.action) ?? 0) + 1);
    assert.match(idempotencyKey, /^agent-approval:run:as-approve-race:/);
    return { ok: true };
  };
  const [first, second] = await Promise.all([
    ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: runKey, applyAction }),
    ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: runKey, applyAction }),
  ]);
  assert.deepEqual([counts.get('draft-report'), counts.get('notify-owner')], [1, 1]);
  assert.equal(first.run.outcome, 'applied');
  assert.equal(second.run.outcome, 'applied');
  assert.ok([first, second].some((result) => result.duplicate === true), 'the loser replays');
});

test('a retry after a partial approval failure resumes past applied proposals', async () => {
  const { ops } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-approve-retry',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals',
      costCents: 4,
      proposals: [
        { action: 'draft-report', payload: {} },
        { action: 'notify-owner', payload: {} },
      ],
    }),
  });
  const runKey = `run:as-approve-retry:${SLOT_0800}`;
  const attempts = new Map();
  let failSecond = true;
  const applyAction = async ({ proposal }) => {
    attempts.set(proposal.action, (attempts.get(proposal.action) ?? 0) + 1);
    if (proposal.action === 'notify-owner' && failSecond) throw new Error('provider down');
    return { ok: true };
  };
  await assert.rejects(
    () => ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: runKey, applyAction }),
    (error) => error.message === 'provider down',
  );
  failSecond = false;
  const { run } = await ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: runKey, applyAction });
  assert.equal(run.outcome, 'applied');
  assert.equal(attempts.get('draft-report'), 1, 'the applied proposal is not duplicated');
  assert.equal(attempts.get('notify-owner'), 2, 'the failed proposal is retried once');
});

test('a stale approval claim is taken over, a live one refuses', async () => {
  const { ops, modules } = compose();
  const { AGENT_APPROVAL_LEASE_MS } = await import('../packages/agents/src/agents.js');
  await makeAgent(ops, { sourceKey: 'ag-stale' });
  for (const sourceKey of ['as-stale', 'as-live']) {
    await ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey,
      agentSourceKey: 'ag-stale',
      phrase: 'ogni giorno il report',
      plan: { cadence: 'daily', timeOfDay: '08:00' },
    });
  }
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals', costCents: 1, proposals: [{ action: 'draft-report', payload: {} }],
    }),
  });
  const service = modules.get('teammate-run').service;
  const staleRow = (await service.listWhere({ spaceId: SPACE, sourceKey: `run:as-stale:${SLOT_0800}` }))[0];
  const staleAt = Date.parse(MON_07) - AGENT_APPROVAL_LEASE_MS - 1000;
  await service.applyManaged(staleRow.id, { note: `approval-claim someone ${staleAt}` }, { actor: SYSTEM });
  const liveRow = (await service.listWhere({ spaceId: SPACE, sourceKey: `run:as-live:${SLOT_0800}` }))[0];
  await service.applyManaged(liveRow.id, { note: `approval-claim someone ${Date.parse(MON_07)}` }, { actor: SYSTEM });
  // The stale claim is taken over and the proposal applies once.
  let staleApplied = 0;
  const stale = await ops.approveRun({
    actor: USER,
    spaceId: SPACE,
    runSourceKey: `run:as-stale:${SLOT_0800}`,
    applyAction: async () => { staleApplied += 1; return { ok: true }; },
  });
  assert.equal(stale.run.outcome, 'applied');
  assert.equal(staleApplied, 1);
  // The live claim refuses with a retryable 409: no write happens.
  let liveApplied = 0;
  await assert.rejects(
    () => ops.approveRun({
      actor: USER,
      spaceId: SPACE,
      runSourceKey: `run:as-live:${SLOT_0800}`,
      applyAction: async () => { liveApplied += 1; return { ok: true }; },
    }),
    (error) => error.code === 'AGENT_APPROVAL_IN_PROGRESS',
  );
  assert.equal(liveApplied, 0);
});

test('two concurrent sweeps over two assignments never execute past the monthly cap', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops, { sourceKey: 'ag-two-slots', spendingCapCents: 100 });
  for (const sourceKey of ['as-cap-a', 'as-cap-b']) {
    await ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey,
      agentSourceKey: 'ag-two-slots',
      phrase: 'ogni giorno il report',
      plan: { cadence: 'daily', timeOfDay: '08:00' },
      costPerRunCents: 60,
    });
  }
  let executions = 0;
  const execute = async () => {
    executions += 1;
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    return { kind: 'artifact', costCents: 60, artifact: { n: executions } };
  };
  const [first, second] = await Promise.all([
    ops.runDue({ actor: SYSTEM, at: MON_0801, execute }),
    ops.runDue({ actor: SYSTEM, at: MON_0801, execute }),
  ]);
  assert.equal(executions, 1, 'the second sweep waits for the first and sees its finalized cost');
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, agentSourceKey: 'ag-two-slots' });
  assert.equal(rows.length, 2, 'one row per slot, never two executions');
  assert.deepEqual(rows.map((row) => row.outcome).sort(), ['artifact', 'capped']);
  const spent = rows.reduce((total, row) => total + row.costCents, 0);
  assert.ok(spent <= 100, `ledger holds ${spent}c against a 100c cap`);
  assert.equal(first.capped + second.capped, 2, 'winner records capped, loser replays capped');
  assert.equal(first.artifacts + second.artifacts, 2, 'winner records the artifact, loser replays it');
});

test('a failed execution keeps a sanitized diagnostic with code and space', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops);
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-boom',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  const failure = new Error('token sk-live-abc is invalid');
  failure.code = 'PROVIDER_DOWN';
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => { throw failure; },
  });
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, assignmentSourceKey: 'as-boom' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failed');
  assert.match(rows[0].note, /PROVIDER_DOWN/);
  assert.match(rows[0].note, /presti/);
  assert.doesNotMatch(rows[0].note, /sk-live-abc/);
});
