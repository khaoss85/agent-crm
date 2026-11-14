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
  assert.deepEqual(names, ['approve-run', 'create-agent', 'create-assignment', 'reject-run', 'revise-run', 'run-due', 'set-agent-status', 'update-agent']);
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
    // Two agents of one space never share a name (backlog:1f7cb20d3c30).
    await makeAgent(ops, { sourceKey: agentSourceKey, name: `Vendi ${kind}`, spendingCapCents: 100 });
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

test('two sweeps from two processes never execute past the monthly cap', async () => {
  const { ops, modules } = compose();
  // A second module instance has its own in-memory agent chains: the
  // same-process lock does not serialize it, exactly like another process
  // sharing the database. Only the ledger reservation can hold the cap.
  const other = await import('../packages/agents/src/operations.js?process=b');
  const opsB = other.createAgentOperations({ modules, now: () => MON_07 });
  await makeAgent(ops, { sourceKey: 'ag-two-procs', spendingCapCents: 100 });
  for (const sourceKey of ['as-proc-a', 'as-proc-b']) {
    await ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey,
      agentSourceKey: 'ag-two-procs',
      phrase: 'ogni giorno il report',
      plan: { cadence: 'daily', timeOfDay: '08:00' },
      costPerRunCents: 60,
    });
  }
  let executions = 0;
  let executing;
  const started = new Promise((resolve) => { executing = resolve; });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const execute = async () => {
    executions += 1;
    if (executions === 1) {
      executing();
      await held;
    }
    return { kind: 'artifact', costCents: 60, artifact: { n: executions } };
  };
  const sweepA = ops.runDue({ actor: SYSTEM, at: MON_0801, execute });
  await started;
  // Process B sweeps while A is still executing its first slot.
  const sweepB = await opsB.runDue({ actor: SYSTEM, at: MON_0801, execute });
  release();
  const sweepAResult = await sweepA;
  assert.equal(executions, 1, 'the reservation of A stops B before execute');
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, agentSourceKey: 'ag-two-procs' });
  assert.equal(rows.length, 2, 'one row per slot');
  assert.deepEqual(rows.map((row) => row.outcome).sort(), ['artifact', 'capped']);
  const spent = rows.reduce((total, row) => total + row.costCents, 0);
  assert.ok(spent <= 100, `ledger holds ${spent}c against a 100c cap`);
  assert.equal(sweepB.artifacts, 0);
  assert.equal(sweepAResult.artifacts, 1);
});

test('a claim that meets a reservation landed after the gate records capped and never executes', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops, { sourceKey: 'ag-window', spendingCapCents: 100 });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-window',
    agentSourceKey: 'ag-window',
    phrase: 'ogni giorno il report',
    plan: { cadence: 'daily', timeOfDay: '08:00' },
    costPerRunCents: 60,
  });
  // Another process passes the same gate (spent 0) and stores its 60c
  // reservation just before this sweep's claim lands.
  const real = modules.get('teammate-run').service;
  let injected = false;
  const racing = new Proxy(real, {
    get(target, prop) {
      if (prop === 'createManaged') {
        return async (data, opts) => {
          if (!injected && data.outcome === 'started') {
            injected = true;
            await target.createManaged({
              ...data,
              sourceKey: `run:as-elsewhere:${SLOT_0800}`,
              assignmentSourceKey: 'as-elsewhere',
              costCents: 60,
            }, opts);
          }
          return target.createManaged(data, opts);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const racingModules = new Map(modules);
  racingModules.set('teammate-run', { service: racing });
  const opsRace = createAgentOperations({ modules: racingModules, now: () => MON_07 });
  let executions = 0;
  const summary = await opsRace.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => { executions += 1; return { kind: 'artifact', costCents: 60, artifact: {} }; },
  });
  assert.equal(injected, true);
  assert.equal(executions, 0, 'the re-check after the claim stops the run');
  assert.equal(summary.capped, 1);
  const row = (await real.listWhere({ spaceId: SPACE, sourceKey: `run:as-window:${SLOT_0800}` }))[0];
  assert.equal(row.outcome, 'capped');
  assert.equal(row.costCents, 0, 'the capped slot releases its reservation');
  assert.match(row.note, /reserved 60c of 100c/);
});

test('a broken assignment does not stop the sweep', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops);
  // A dangling assignment written out of band: its agent does not exist.
  await modules.get('teammate-assignment').service.createManaged({
    sourceKey: 'as-ghost',
    spaceId: SPACE,
    agentSourceKey: 'ag-ghost',
    phrase: 'ogni lunedì il report vendite',
    cadence: 'weekly',
    weekday: 1,
    timeOfDay: '08:00',
    nextRunAt: SLOT_0800,
    status: 'active',
    decidedAt: MON_07,
    actorType: USER.type,
    actorId: USER.id,
    sourcePackage: 'agents',
    sourceAction: 'create-assignment',
  }, { actor: USER });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-healthy',
    agentSourceKey: 'ag-vendite',
    phrase: 'ogni lunedì il report vendite',
    plan: { cadence: 'weekly', weekday: 1, timeOfDay: '08:00' },
  });
  let executions = 0;
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => { executions += 1; return { kind: 'artifact', costCents: 1, artifact: {} }; },
  });
  assert.equal(executions, 1, 'the healthy assignment still runs');
  assert.equal(summary.artifacts, 1);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(summary.errors, [{ assignmentSourceKey: 'as-ghost', spaceId: SPACE, code: 'AGENT_UNKNOWN' }]);
});

test('a progress heartbeat at done == total stays live for the lease, then finalizes without re-applying', async () => {
  const { ops, modules } = compose();
  const { AGENT_APPROVAL_LEASE_MS } = await import('../packages/agents/src/agents.js');
  await makeAgent(ops, { sourceKey: 'ag-done' });
  for (const sourceKey of ['as-done-live', 'as-done-stale']) {
    await ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey,
      agentSourceKey: 'ag-done',
      phrase: 'ogni giorno il report',
      plan: { cadence: 'daily', timeOfDay: '08:00' },
    });
  }
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals',
      costCents: 1,
      proposals: [{ action: 'draft-report', payload: {} }, { action: 'notify-owner', payload: {} }],
    }),
  });
  const service = modules.get('teammate-run').service;
  const liveKey = `run:as-done-live:${SLOT_0800}`;
  const staleKey = `run:as-done-stale:${SLOT_0800}`;
  const liveRow = (await service.listWhere({ spaceId: SPACE, sourceKey: liveKey }))[0];
  await service.applyManaged(liveRow.id, { note: `approval-progress 2/2 ${Date.parse(MON_07)}` }, { actor: SYSTEM });
  const staleRow = (await service.listWhere({ spaceId: SPACE, sourceKey: staleKey }))[0];
  const staleAt = Date.parse(MON_07) - AGENT_APPROVAL_LEASE_MS - 1000;
  await service.applyManaged(staleRow.id, { note: `approval-progress 2/2 ${staleAt}` }, { actor: SYSTEM });
  let appliedCalls = 0;
  const applyAction = async () => { appliedCalls += 1; return { ok: true }; };
  // Live: the other approver applied everything and is about to finalize.
  await assert.rejects(
    () => ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: liveKey, applyAction }),
    (error) => error.code === 'AGENT_APPROVAL_IN_PROGRESS',
  );
  // Stale: everything was applied, only the final write is missing.
  const stale = await ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: staleKey, applyAction });
  assert.equal(stale.run.outcome, 'applied');
  assert.equal(appliedCalls, 0, 'no proposal is applied twice');
});

test('spentSince counts the execution month, not the slot month', async () => {
  const { spentSince } = await import('../packages/agents/src/agents.js');
  const runs = [
    { startedAt: '2026-01-31T08:00:00.000Z', decidedAt: '2026-02-01T08:01:00.000Z', costCents: 60 },
    { startedAt: '2026-01-15T08:00:00.000Z', decidedAt: '2026-01-15T08:00:00.000Z', costCents: 60 },
    // Rows written before decidedAt existed fall back to the slot instant.
    { startedAt: '2026-01-20T08:00:00.000Z', costCents: 60 },
  ];
  assert.equal(spentSince(runs, '2026-02-01T00:00:00.000Z'), 60);
  assert.equal(spentSince(runs, '2026-01-01T00:00:00.000Z'), 180);
});

test('backlogged slots executed in the new month spend the new month\u2019s cap', async () => {
  // The worker stood still across the month boundary: two daily slots due
  // 31 January run on 1 February against a 100c cap with 60c estimates.
  const FEB_01 = '2026-02-01T08:01:00.000Z';
  const { ops, modules } = compose(FEB_01);
  await makeAgent(ops, { sourceKey: 'ag-feb', spendingCapCents: 100 });
  for (const sourceKey of ['as-feb-a', 'as-feb-b']) {
    await ops.createAssignment({
      actor: USER,
      spaceId: SPACE,
      sourceKey,
      agentSourceKey: 'ag-feb',
      phrase: 'ogni giorno il report',
      plan: { cadence: 'daily', timeOfDay: '08:00' },
      costPerRunCents: 60,
    });
    const row = (await modules.get('teammate-assignment').service.listWhere({ spaceId: SPACE, sourceKey }))[0];
    await modules.get('teammate-assignment').service.applyManaged(
      row.id, { nextRunAt: '2026-01-31T08:00:00.000Z' }, { actor: SYSTEM },
    );
  }
  // January already spent 60c on a run executed in January.
  await modules.get('teammate-run').service.createManaged({
    sourceKey: 'run:as-feb-a:2026-01-15T08:00:00.000Z',
    spaceId: SPACE,
    agentSourceKey: 'ag-feb',
    assignmentSourceKey: 'as-feb-a',
    startedAt: '2026-01-15T08:00:00.000Z',
    decidedAt: '2026-01-15T08:00:00.000Z',
    actorType: 'system',
    actorId: 'agent-sweep',
    sourcePackage: 'agents',
    sourceAction: 'run-due',
    costCents: 60,
    outcome: 'artifact',
    artifact: JSON.stringify({ day: 15 }),
    artifactVersion: 1,
  }, { actor: SYSTEM });
  let executions = 0;
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: FEB_01,
    execute: async () => {
      executions += 1;
      return { kind: 'artifact', costCents: 60, artifact: { feb: true } };
    },
  });
  assert.equal(executions, 1, 'the second backlogged slot is capped, not executed');
  assert.deepEqual([summary.artifacts, summary.capped], [1, 1]);
  const rows = await modules.get('teammate-run').service.listWhere({ spaceId: SPACE, agentSourceKey: 'ag-feb' });
  const febSpend = rows
    .filter((row) => typeof row.decidedAt === 'string' && row.decidedAt >= '2026-02-01T00:00:00.000Z')
    .reduce((total, row) => total + row.costCents, 0);
  assert.equal(febSpend, 60, 'February holds one execution against the 100c cap');
  for (const row of rows.filter((entry) => entry.outcome === 'artifact' && entry.decidedAt >= '2026-02-01T00:00:00.000Z')) {
    assert.ok(!/Slot claimed/.test(row.note ?? ''), 'no claim note survives on a finished artifact row');
  }
});

/**
 * Async-only run storage: no `.sync` handle and no `mutationSync`, like the
 * PostgreSQL adapter. The agent operations must take the `mutationAsync`
 * branch of the conditional run write and still record the run.
 */
function asyncRunService(realManifest) {
  const rows = [];
  let seq = 0;
  const fieldOf = (column) => {
    if (column === 'id') return 'id';
    return realManifest.fields.find((field) => field.column === column)?.name ?? null;
  };
  const match = (row, where) => (where ?? []).every((predicate) => {
    const field = fieldOf(predicate.column);
    const current = field === null ? row[predicate.column] : row[field];
    if (predicate.op === 'is-null') return current === null || current === undefined;
    if (predicate.op !== 'eq') throw new Error(`stub run storage supports only eq/is-null (got ${predicate.op})`);
    return current === predicate.value;
  });
  const storage = {
    execute: async (statement) => {
      if (statement?.kind !== 'update' || statement.table !== realManifest.table) {
        throw new Error(`stub run storage supports only updates on ${realManifest.table}`);
      }
      const targets = rows.filter((row) => match(row, statement.where));
      for (const target of targets) {
        for (const { column, value } of statement.values ?? []) {
          const field = fieldOf(column);
          target[field ?? column] = value;
        }
      }
      return { affectedRows: targets.length };
    },
  };
  return {
    rows,
    manifest: realManifest,
    database: { storage },
    audit: { record: async () => {} },
    events: { emit: async () => {} },
    async mutationAsync(fn) {
      return fn({ execute: (statement) => storage.execute(statement) });
    },
    async createManaged(data) {
      if (rows.some((row) => row.sourceKey === data.sourceKey)) {
        throw Object.assign(new Error('UNIQUE constraint failed: teammate_run.sourceKey'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        });
      }
      seq += 1;
      const stored = { ...data, id: `stub-run-${seq}` };
      rows.push(stored);
      return { ...stored };
    },
    async applyManaged(id, patch) {
      const row = rows.find((entry) => entry.id === id);
      if (!row) throw new Error('Unknown stub run');
      Object.assign(row, patch);
      return { ...row };
    },
    async get(id) {
      const row = rows.find((entry) => entry.id === id);
      if (!row) throw new Error('Unknown stub run');
      return { ...row };
    },
    async listWhere(filters = {}) {
      return rows
        .filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value))
        .map((row) => ({ ...row }));
    },
  };
}

test('a stale claim taken over across the month boundary spends the new month', async () => {
  // A sweep claimed the 31 January slot at 23:50 UTC and crashed before
  // finalizing. The worker restarts on 1 February and takes over the stale
  // claim: the February execution must spend the February cap, not January's.
  const FEB_01 = '2026-02-01T08:01:00.000Z';
  const { ops, modules } = compose(FEB_01);
  await makeAgent(ops, { sourceKey: 'ag-stale-feb', spendingCapCents: 100 });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-stale-feb',
    agentSourceKey: 'ag-stale-feb',
    phrase: 'ogni giorno il report',
    plan: { cadence: 'daily', timeOfDay: '08:00' },
    costPerRunCents: 60,
  });
  const queued = (await modules.get('teammate-assignment').service.listWhere({ spaceId: SPACE, sourceKey: 'as-stale-feb' }))[0];
  await modules.get('teammate-assignment').service.applyManaged(
    queued.id, { nextRunAt: '2026-01-31T08:00:00.000Z' }, { actor: SYSTEM },
  );
  await modules.get('teammate-run').service.createManaged({
    sourceKey: 'run:as-stale-feb:2026-01-31T08:00:00.000Z',
    spaceId: SPACE,
    agentSourceKey: 'ag-stale-feb',
    assignmentSourceKey: 'as-stale-feb',
    startedAt: '2026-01-31T08:00:00.000Z',
    decidedAt: '2026-01-31T23:50:00.000Z',
    actorType: 'system',
    actorId: 'agent-sweep',
    sourcePackage: 'agents',
    sourceAction: 'run-due',
    costCents: 60,
    outcome: 'started',
    note: 'Slot claimed, execution not yet recorded.',
  }, { actor: SYSTEM });
  let executions = 0;
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: FEB_01,
    execute: async () => {
      executions += 1;
      return { kind: 'artifact', costCents: 60, artifact: { feb: true } };
    },
  });
  assert.equal(executions, 1);
  assert.equal(summary.artifacts, 1);
  const rows = await modules.get('teammate-run').service
    .listWhere({ spaceId: SPACE, sourceKey: 'run:as-stale-feb:2026-01-31T08:00:00.000Z' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'artifact');
  assert.equal(rows[0].decidedAt, FEB_01, 'the takeover executes now, so it spends the new month');
  const febSpend = (await modules.get('teammate-run').service.listWhere({ spaceId: SPACE, agentSourceKey: 'ag-stale-feb' }))
    .filter((row) => typeof row.decidedAt === 'string' && row.decidedAt >= '2026-02-01T00:00:00.000Z')
    .reduce((total, row) => total + row.costCents, 0);
  assert.equal(febSpend, 60);
});

test('conditional run writes hold on async (PostgreSQL-like) storage', async () => {
  const FEB_01 = '2026-02-01T08:01:00.000Z';
  const base = compose(FEB_01);
  const stub = asyncRunService(base.modules.get('teammate-run').service.manifest);
  const modules = new Map(base.modules);
  modules.set('teammate-run', { service: stub });
  const ops = createAgentOperations({ modules, now: () => FEB_01 });
  await makeAgent(ops, { sourceKey: 'ag-pg', spendingCapCents: 100 });
  await ops.createAssignment({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'as-pg',
    agentSourceKey: 'ag-pg',
    phrase: 'ogni giorno il report',
    plan: { cadence: 'daily', timeOfDay: '08:00' },
    costPerRunCents: 60,
  });
  const queued = (await base.modules.get('teammate-assignment').service.listWhere({ spaceId: SPACE, sourceKey: 'as-pg' }))[0];
  await base.modules.get('teammate-assignment').service.applyManaged(
    queued.id, { nextRunAt: '2026-01-31T08:00:00.000Z' }, { actor: SYSTEM },
  );
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: FEB_01,
    execute: async () => ({ kind: 'artifact', costCents: 60, artifact: { pg: true } }),
  });
  assert.equal(summary.artifacts, 1);
  const rows = await stub.listWhere({ spaceId: SPACE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'artifact');
  assert.equal(rows[0].decidedAt, FEB_01);
  assert.ok(!/Slot claimed/.test(rows[0].note ?? ''), 'no claim note survives on the async path either');
});

test('1f7cb20d3c30: create-agent refuses a second agent with the same @name in a space, and still replays its own key', async () => {
  const { ops } = compose();
  const first = await makeAgent(ops, { sourceKey: 'ag-a', name: 'Report Vendite' });
  const replay = await ops.createAgent({ actor: USER, spaceId: SPACE, sourceKey: 'ag-a', name: 'Report Vendite', role: 'r', instructions: 'i' });
  assert.equal(replay.duplicate, true, 'the same key replays before the name rule');
  assert.equal(replay.agent.sourceKey, first.sourceKey);
  await assert.rejects(
    () => ops.createAgent({ actor: USER, spaceId: SPACE, sourceKey: 'ag-b', name: ' report  vèndite', role: 'r', instructions: 'i' }),
    (error) => error.code === 'AGENT_NAME_TAKEN' && error.status === 409,
  );
  const other = await ops.createAgent({ actor: USER, spaceId: 'altro-spazio', sourceKey: 'ag-c', name: 'Report Vendite', role: 'r', instructions: 'i' });
  assert.equal(other.duplicate, false, 'another space may use the name');
});

test('1f7cb20d3c30: run-due leaves an agent the deployment cannot run waiting — no run, no failure, still due', async () => {
  const { ops, modules } = compose();
  await makeAgent(ops, { sourceKey: 'custom-agent:ws:k1', name: 'Auguri' });
  await makeAgent(ops, { sourceKey: 'ag-ok', name: 'Pronto' });
  for (const [sourceKey, agentSourceKey] of [['as-wait', 'custom-agent:ws:k1'], ['as-ok', 'ag-ok']]) {
    await ops.createAssignment({
      actor: USER, spaceId: SPACE, sourceKey, agentSourceKey,
      phrase: 'ogni giorno il report', plan: { cadence: 'daily', timeOfDay: '08:00' },
    });
  }
  const executed = [];
  const execute = async ({ agent }) => {
    executed.push(agent.sourceKey);
    return { kind: 'artifact', costCents: 0, artifact: { total: 0 } };
  };
  const runnable = (agent) => !agent.sourceKey.startsWith('custom-agent:');
  const summary = await ops.runDue({ actor: SYSTEM, at: MON_0801, execute, runnable });
  assert.equal(summary.waiting, 1, 'the engine-less agent waits');
  assert.equal(summary.failed, 0, 'never a failed run');
  assert.deepEqual(executed, ['ag-ok'], 'its assignment is never executed');
  const runs = await modules.get('teammate-run').service.listWhere({ spaceId: SPACE, agentSourceKey: 'custom-agent:ws:k1' });
  assert.equal(runs.length, 0, 'no run row is born');
  const [waiting] = await modules.get('teammate-assignment').service.listWhere({ spaceId: SPACE, sourceKey: 'as-wait' });
  assert.equal(waiting.status, 'active', 'the assignment is kept');
  assert.ok(Date.parse(waiting.nextRunAt) <= Date.parse(MON_0801), 'and stays due: it runs once an engine exists');
  const again = await ops.runDue({ actor: SYSTEM, at: MON_0801, execute });
  assert.equal(again.waiting, undefined, 'without the seam every agent is runnable and the summary shape is unchanged');
  assert.ok(executed.includes('custom-agent:ws:k1'));
});

test('1f7cb20d3c30 review #836 P2: two concurrent creates of one @name in a space — one agent, one AGENT_NAME_TAKEN', async () => {
  const { ops, modules } = compose();
  const create = (sourceKey) => ops.createAgent({ actor: USER, spaceId: SPACE, sourceKey, name: 'Auguri', role: 'r', instructions: 'i' });
  const outcomes = await Promise.allSettled([create('ag-x'), create('ag-y'), create('ag-z')]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one agent is created');
  for (const lost of outcomes.filter((o) => o.status === 'rejected')) {
    assert.equal(/** @type {any} */ (lost).reason.code, 'AGENT_NAME_TAKEN');
  }
  const rows = (await modules.get('teammate-agent').service.listWhere({ spaceId: SPACE })).filter((row) => row.name === 'Auguri');
  assert.equal(rows.length, 1, 'never two agents with the same @name');
});
