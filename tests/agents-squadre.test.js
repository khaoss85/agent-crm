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
import { createAgentOperations } from '../packages/agents/src/operations.js';
import { SQUAD_TEMPLATES } from '../packages/agents/src/squads.js';

/**
 * Agent squads (backlog:0d2d8f2e): a squad is created from a ready-made
 * template, from a free-text brief or from an explicit plan, with an
 * objective and a metric, member agents with roles, phases with an approval
 * mode, sources with a time, outputs and a monthly spending cap. The
 * per-squad overview reads backlog A, routines, backlog B and the advisor
 * metric from production rows. Real sqlite plus the real record services.
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SYSTEM = { type: 'system', id: 'agent-sweep' };
const SPACE = 'presti';
const MON_07 = '2026-11-02T07:00:00.000Z';
const MON_0801 = '2026-11-02T08:01:00.000Z';

const manifest = (name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', 'agents', 'modules', `${name}.module.json`), 'utf8'),
);

const MANIFESTS = ['teammate-agent', 'teammate-assignment', 'teammate-run', 'teammate-squad'];

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

test('the catalogue holds the five ready-made squad templates', () => {
  assert.deepEqual(
    SQUAD_TEMPLATES.map((entry) => entry.slug),
    ['lead-generation', 'social-posting', 'sales-outreach', 'discovery', 'contenuti'],
  );
  for (const entry of SQUAD_TEMPLATES) {
    assert.ok(entry.objective.length > 0);
    assert.ok(entry.metric.target > 0);
    assert.ok(entry.members.length >= 1 && entry.members.length <= 8);
    assert.ok(entry.phases.every((phase) => ['none', 'review', 'owner'].includes(phase.approval)));
  }
});

test('a template creates a squad with its agents and routines', async () => {
  const { modules, ops } = compose();
  const made = await ops.createSquad({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'sq-lead-1',
    templateSlug: 'lead-generation',
  });
  assert.equal(made.duplicate, false);
  assert.equal(made.squad.name, 'Acquisizione lead');
  assert.equal(made.squad.objective, 'Riempire la settimana di nuovi contatti da lavorare.');
  assert.equal(made.squad.metricName, 'Nuovi lead contattati');
  assert.equal(made.squad.templateSlug, 'lead-generation');
  assert.equal(made.members.length, 2);
  assert.ok(made.members.every((agent) => agent.name.startsWith('Acquisizione lead · ')));
  // The riaggancio member reuses the catalogue agent (MEM_ACC_REUSE).
  const riaggancio = made.members.find((agent) => agent.role === 'Ricontatta i clienti rimasti senza risposta');
  assert.ok(riaggancio);
  assert.equal(made.routines.length, 2);
  assert.ok(made.routines.every((assignment) => assignment.status === 'active'));
  const overview = await ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-lead-1' });
  assert.equal(overview.backlogA.length, 2, 'backlog A: the work to do');
  assert.equal(overview.routines.length, 2, 'both routines recur');
  assert.equal(overview.backlogB.length, 0);
  assert.equal(overview.metrics.target, 20);
  assert.equal(overview.metrics.actual, null, 'actual waits for the native advisor of the engine');
  assert.equal(overview.squad.phases.length, 3);
  const assigned = await modules.get('teammate-assignment').service.listWhere({ spaceId: SPACE });
  assert.equal(assigned.length, 2);
});

test('a retry replays the squad, its members and its routines', async () => {
  const { modules, ops } = compose();
  const first = await ops.createSquad({
    actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation',
  });
  assert.equal(first.duplicate, false);
  const again = await ops.createSquad({
    actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation',
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.squad.sourceKey, 'sq-lead-1');
  const agents = await modules.get('teammate-agent').service.listWhere({ spaceId: SPACE });
  assert.equal(agents.length, 2, 'no member is doubled');
  const assigned = await modules.get('teammate-assignment').service.listWhere({ spaceId: SPACE });
  assert.equal(assigned.length, 2, 'no routine is doubled');
});

test('a brief names its template; an unclear brief refuses', async () => {
  const { ops } = compose();
  const made = await ops.createSquad({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'sq-brief-1',
    brief: 'una squadra che segue i lead WhatsApp senza risposta',
  });
  assert.equal(made.squad.templateSlug, 'lead-generation');
  await assert.rejects(
    () => ops.createSquad({ actor: USER, spaceId: SPACE, sourceKey: 'sq-brief-2', brief: 'fai cose belle' }),
    (error) => error.code === 'SQUAD_BRIEF_UNCLEAR',
  );
  await assert.rejects(
    () => ops.createSquad({ actor: USER, spaceId: SPACE, sourceKey: 'sq-brief-3', templateSlug: 'inventata' }),
    (error) => error instanceof Error && /unknown squad template/.test(error.message),
  );
});

test('an explicit plan stores objective, phases, sources, outputs and cap', async () => {
  const { ops } = compose();
  const made = await ops.createSquad({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'sq-plan-1',
    name: 'Squadra serale',
    spendingCapCents: 5000,
    plan: {
      name: 'Squadra serale',
      objective: 'Chiudere le conversazioni aperte ogni sera.',
      metric: { name: 'Conversazioni chiuse', target: 15, unit: 'chiusure/settimana' },
      members: [
        { key: 'serale', name: 'Addetto serale', role: 'Chiude le conversazioni', instructions: 'Rilegge le conversazioni aperte e propone il messaggio di chiusura. Ogni messaggio aspetta il tuo ok.' },
      ],
      routines: [
        { memberKey: 'serale', phrase: 'ogni sera chiudi le conversazioni aperte', plan: { cadence: 'daily', timeOfDay: '18:00' } },
      ],
      phases: [{ name: 'Chiusura', approval: 'owner' }],
      sources: [{ channel: 'WhatsApp', timeOfDay: '18:00' }],
      outputs: ['Messaggi di chiusura pronti'],
    },
  });
  assert.equal(made.duplicate, false);
  assert.equal(made.squad.templateSlug, null);
  const overview = await ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-plan-1' });
  assert.equal(overview.squad.objective, 'Chiudere le conversazioni aperte ogni sera.');
  assert.deepEqual(overview.squad.phases, [{ name: 'Chiusura', approval: 'owner' }]);
  assert.deepEqual(overview.squad.sources, [{ channel: 'WhatsApp', timeOfDay: '18:00' }]);
  assert.deepEqual(overview.squad.outputs, ['Messaggi di chiusura pronti']);
  assert.equal(overview.metrics.capCents, 5000);
  assert.equal(overview.metrics.overCap, false);
  assert.equal(overview.routines.length, 1);
});

test('a plan with an unknown routine member or a bad phase refuses', async () => {
  const { ops } = compose();
  const base = {
    name: 'Squadra rotta',
    objective: 'Non si crea.',
    metric: { name: 'Cose', target: 1, unit: 'cose' },
    members: [{ key: 'uno', name: 'Uno', role: 'Fa', instructions: 'Fa cose senza farle da solo.' }],
    routines: [{ memberKey: 'fantasma', phrase: 'ogni giorno fai', plan: { cadence: 'daily', timeOfDay: '08:00' } }],
    phases: [{ name: 'Solo', approval: 'review' }],
  };
  await assert.rejects(
    () => ops.createSquad({ actor: USER, spaceId: SPACE, sourceKey: 'sq-bad-1', plan: base }),
    (error) => /not a squad member/.test(error.message),
  );
  await assert.rejects(
    () => ops.createSquad({
      actor: USER,
      spaceId: SPACE,
      sourceKey: 'sq-bad-2',
      plan: { ...base, routines: [], phases: [{ name: 'Solo', approval: 'sindaco' }] },
    }),
    (error) => /phase approval/.test(error.message),
  );
});

test('backlog B shows proposed runs waiting for the owner', async () => {
  const { ops } = compose();
  await ops.createSquad({
    actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation',
  });
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({
      kind: 'proposals',
      costCents: 12,
      proposals: [{ action: 'draft-first-message', payload: { to: 'lead-1' } }],
    }),
  });
  const waiting = await ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-lead-1' });
  assert.equal(waiting.backlogB.length, 1, 'the due routine proposed, the later one is still scheduled');
  assert.equal(waiting.backlogB[0].proposals, 1);
  assert.equal(waiting.metrics.runsByOutcome.proposed, 1);
  // The owner approves from the backlog B row through the existing approve-run.
  const applied = [];
  const { run } = await ops.approveRun({
    actor: USER,
    spaceId: SPACE,
    runSourceKey: waiting.backlogB[0].runSourceKey,
    applyAction: async ({ proposal }) => {
      applied.push(proposal.action);
      return { ok: true };
    },
  });
  assert.equal(run.outcome, 'applied');
  assert.deepEqual(applied, ['draft-first-message']);
  const after = await ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-lead-1' });
  assert.equal(after.backlogB.length, 0);
  assert.equal(after.metrics.runsByOutcome.applied, 1);
});

test('the squad cap is counted in the overview', async () => {
  const { ops } = compose();
  await ops.createSquad({
    actor: USER,
    spaceId: SPACE,
    sourceKey: 'sq-cap-1',
    spendingCapCents: 100,
    plan: {
      name: 'Squadra cara',
      objective: 'Spende oltre il tetto.',
      metric: { name: 'Cose', target: 1, unit: 'cose' },
      members: [{ key: 'uno', name: 'Uno', role: 'Fa', instructions: 'Fa cose senza farle da solo.' }],
      routines: [{ memberKey: 'uno', phrase: 'ogni giorno fai', plan: { cadence: 'daily', timeOfDay: '08:00' } }],
      phases: [{ name: 'Solo', approval: 'none' }],
    },
  });
  await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async () => ({ kind: 'artifact', costCents: 120, artifact: { done: true } }),
  });
  const overview = await ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-cap-1' });
  assert.equal(overview.metrics.spentCents, 120);
  assert.equal(overview.metrics.overCap, true);
});

test('an unknown squad refuses with SQUAD_UNKNOWN', async () => {
  const { ops } = compose();
  await assert.rejects(
    () => ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-fantasma' }),
    (error) => error.code === 'SQUAD_UNKNOWN',
  );
});

test('a second squad from the same template refuses with SQUAD_NAME_TAKEN before any write', async () => {
  const { modules, ops } = compose();
  await ops.createSquad({
    actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation',
  });
  await assert.rejects(
    () => ops.createSquad({
      actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-2', templateSlug: 'lead-generation',
    }),
    (error) => error.code === 'SQUAD_NAME_TAKEN',
  );
  const agents = await modules.get('teammate-agent').service.listWhere({ spaceId: SPACE });
  assert.equal(agents.length, 2, 'the refused squad leaves no orphan member');
  const renamed = await ops.createSquad({
    actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-2', templateSlug: 'lead-generation', name: 'Acquisizione lead bis',
  });
  assert.equal(renamed.duplicate, false);
  assert.ok(renamed.members.every((agent) => agent.name.startsWith('Acquisizione lead bis · ')));
});

test('a bad routine plan or a missing cost estimate refuses before any write', async () => {
  const { modules, ops } = compose();
  const base = {
    name: 'Squadra rotta',
    objective: 'Non si crea.',
    metric: { name: 'Cose', target: 1, unit: 'cose' },
    members: [{ key: 'uno', name: 'Uno', role: 'Fa', instructions: 'Fa cose senza farle da solo.' }],
    routines: [{ memberKey: 'uno', phrase: 'ogni settimana fai', plan: { cadence: 'weekly', timeOfDay: '08:00' } }],
    phases: [{ name: 'Solo', approval: 'review' }],
  };
  await assert.rejects(
    () => ops.createSquad({ actor: USER, spaceId: SPACE, sourceKey: 'sq-bad-plan', plan: base }),
    (error) => /weekday/.test(error.message),
  );
  const capped = {
    ...base,
    members: [{ key: 'uno', name: 'Uno', role: 'Fa', instructions: 'Fa cose senza farle da solo.', spendingCapCents: 500 }],
    routines: [{ memberKey: 'uno', phrase: 'ogni giorno fai', plan: { cadence: 'daily', timeOfDay: '08:00' } }],
  };
  await assert.rejects(
    () => ops.createSquad({ actor: USER, spaceId: SPACE, sourceKey: 'sq-bad-cost', plan: capped }),
    (error) => error.code === 'AGENT_COST_ESTIMATE_REQUIRED',
  );
  const agents = await modules.get('teammate-agent').service.listWhere({ spaceId: SPACE });
  assert.equal(agents.length, 0, 'refused plans leave no orphan member');
});

test('a retry with a changed spec refuses with SQUAD_SPEC_CHANGED', async () => {
  const { modules, ops } = compose();
  await ops.createSquad({
    actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation',
  });
  await assert.rejects(
    () => ops.createSquad({
      actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation', name: 'Altro nome',
    }),
    (error) => error.code === 'SQUAD_SPEC_CHANGED',
  );
  const agents = await modules.get('teammate-agent').service.listWhere({ spaceId: SPACE });
  assert.equal(agents.length, 2, 'the refused retry adds no member');
});

test('a squad row of the wrong shape answers SQUAD_ROW_CORRUPT, never TypeError', async () => {
  const { modules, ops } = compose();
  const made = await ops.createSquad({
    actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation',
  });
  await modules.get('teammate-squad').service.applyManaged(
    made.squad.id, { membersJson: '"x"' }, { actor: USER },
  );
  await assert.rejects(
    () => ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-lead-1' }),
    (error) => error.code === 'SQUAD_ROW_CORRUPT',
  );
  await modules.get('teammate-squad').service.applyManaged(
    made.squad.id, { membersJson: '[{"key":"x"}]', phasesJson: '{"a":1}' }, { actor: USER },
  );
  await assert.rejects(
    () => ops.readSquadOverview({ spaceId: SPACE, squadSourceKey: 'sq-lead-1' }),
    (error) => error.code === 'SQUAD_ROW_CORRUPT',
  );
});

test('an ownerId refuses instead of being silently dropped', async () => {
  const { ops } = compose();
  await assert.rejects(
    () => ops.createSquad({
      actor: USER, spaceId: SPACE, sourceKey: 'sq-lead-1', templateSlug: 'lead-generation', ownerId: 'presti-owner',
    }),
    (error) => error.code === 'VALIDATION_ERROR' && /ownerId/.test(error.message),
  );
});
