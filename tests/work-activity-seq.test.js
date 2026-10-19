import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { boot, project } from './helpers/contracts-project.js';
import { sortTimeline } from '../packages/work/src/index.js';
import { recordActivity } from '../packages/work/src/follow-up.js';

/**
 * One task, one `seq` writer at a time (#223 follow-up).
 *
 * `recordActivity` assigns `seq` as one more than the highest `seq` stored
 * for the task — a read-then-write. Two writers interleaved on one process
 * both read the same maximum and both commit with it, storing the same `seq`
 * twice while `sortTimeline` claims the order is the write order. The package
 * now serializes assignments per task (a process-local FIFO chain: the
 * appointments per-member booking chain, keyed by task), so the waiter
 * re-reads after the winner's insert and takes the next `seq`.
 *
 * The first test below races twenty writers on one task at one frozen
 * instant against the real service and the real store: every write ties on
 * `occurredAt` and `createdAt`, so only distinct, contiguous `seq` values put
 * the timeline right. The second proves tasks do not contend with each other.
 * The third is the same race in its smallest form — ten same-tick
 * `recordActivity` calls with no awaits between them — the interleaving that
 * stored the same `seq` twice before the fix (reproduced as 1, 1).
 */

const ACTOR = { type: 'user', id: 'activity-seq' };
// One instant for every write: with a frozen clock every stamp ties, so only
// the stored sequence can order the timeline.
const FROZEN = '2026-10-17T10:00:00.000Z';

const run = (app, module, action, recordId, input, actor = ACTOR) =>
  app.runAction({ module, action, recordId, input, actor });

/** The B2B starter's Lead path with the Work records, on a frozen clock. */
async function frozenProject(t, file) {
  const root = project(t, { withDomain: false, withWorkTables: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
    "import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';",
    'export const generatedActions = [qualifyLead, disqualifyLead];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n'));
  const { spawnSync } = await import('node:child_process');
  const applied = spawnSync(process.execPath, [
    '--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
    join(root, 'examples/starters/b2b-lead-qualification/lead.module.json'), '--apply', '--root', root,
  ], { encoding: 'utf8', cwd: root });
  assert.equal(applied.status, 0, applied.stderr);
  const context = await boot(root, join(root, 'data', file), { clock: () => FROZEN });
  t.after(() => context.close());
  return { root, context };
}

async function openTask(app, index) {
  const lead = await app.modules.get('lead').service.create(
    { firstName: `Race${index}`, lastName: 'Ms', email: `seq-race-${index}@x.example` }, { actor: ACTOR },
  );
  await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
  return app.modules.get('work-task').service.listWhere({ subjectId: lead.id })[0];
}

test('parallel notes on one task take distinct seqs in commit order', async (t) => {
  const { context } = await frozenProject(t, 'activity-seq-race.sqlite');
  const { app } = context;
  // A real task, so `task_created` holds seq 1 before the race starts.
  const task = await openTask(app, 0);
  const activities = app.modules.get('work-activity').service;
  const note = (n) => ({
    sourceKey: null,
    kind: 'note',
    subject: { resource: 'lead', id: 'race-lead' },
    taskId: task.id,
    body: `parallel note ${n}`,
    occurredAt: FROZEN,
    source: { package: 'host', action: 'add-note' },
  });

  // Twenty racing writers, no await between the calls. Actions on one
  // connection cannot overlap by platform design (the action envelope refuses
  // a nested outer transaction), so the race lives one level down, where
  // every writer in this repository actually meets: `recordActivity` on the
  // real service and the real store.
  const COUNT = 20;
  const rows = await Promise.all(Array.from({ length: COUNT }, (_, n) =>
    recordActivity({ activities, actor: ACTOR }, note(n))));

  // `task_created` took 1, so twenty racing notes must hold exactly 2..21:
  // distinct (no two share one) and contiguous (no gap claims a lost write).
  assert.deepEqual(rows.map((row) => row.seq).sort((a, b) => a - b),
    Array.from({ length: COUNT }, (_, n) => n + 2));

  const timeline = sortTimeline(activities.listWhere({ taskId: task.id }));
  assert.deepEqual(timeline.map((row) => row.seq),
    Array.from({ length: COUNT + 1 }, (_, n) => n + 1),
    'at one frozen instant only the stored write order can put the timeline right');
});

test('racing tasks do not contend: each keeps its own sequence', async (t) => {
  const { context } = await frozenProject(t, 'activity-seq-tasks.sqlite');
  const { app } = context;
  const first = await openTask(app, 1);
  const second = await openTask(app, 2);
  const activities = app.modules.get('work-activity').service;
  const note = (taskId, n) => ({
    sourceKey: null,
    kind: 'note',
    subject: { resource: 'lead', id: 'race-lead' },
    taskId,
    body: `task note ${n}`,
    occurredAt: FROZEN,
    source: { package: 'host', action: 'add-note' },
  });

  const COUNT = 5;
  await Promise.all([
    ...Array.from({ length: COUNT }, (_, n) =>
      recordActivity({ activities, actor: ACTOR }, note(first.id, n))),
    ...Array.from({ length: COUNT }, (_, n) =>
      recordActivity({ activities, actor: ACTOR }, note(second.id, n))),
  ]);

  for (const task of [first, second]) {
    const seqs = activities.listWhere({ taskId: task.id })
      .map((row) => row.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: COUNT + 1 }, (_, n) => n + 1));
  }
});

test('same-tick recordActivity calls serialize: no two rows share a seq', async (t) => {
  const { context } = await frozenProject(t, 'activity-seq-unit.sqlite');
  const { app } = context;
  const activities = app.modules.get('work-activity').service;
  const entry = (n) => ({
    sourceKey: null,
    kind: 'note',
    subject: { resource: 'lead', id: 'unit-lead' },
    taskId: 'unit-task',
    body: `unit note ${n}`,
    occurredAt: FROZEN,
    source: { package: 'host', action: 'add-note' },
  });
  // No await between the calls: both attach in the same tick, which is the
  // interleaving that used to store the same seq twice (reproduced as 1, 1).
  const rows = await Promise.all(Array.from({ length: 10 }, (_, n) =>
    recordActivity({ activities, actor: ACTOR }, entry(n))));
  assert.deepEqual(rows.map((row) => row.seq).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
