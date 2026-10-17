import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { boot, project } from './helpers/contracts-project.js';
import { sortTimeline } from '../packages/work/src/index.js';

/**
 * Same-millisecond timeline order (agent-crm #213 CI flake).
 *
 * `occurredAt` and the row `createdAt` both have millisecond precision, so two
 * writes in the same millisecond tied on both and the tie fell through to the
 * random row id: a note written after a close sometimes sorted before it. The
 * write path now stores `seq` — the position in the task's append sequence —
 * and `sortTimeline` breaks same-instant ties with it.
 *
 * The first test below is the flake's precondition made permanent: every write
 * happens at one frozen instant, and the full note → close → note-after-close
 * timeline must come out in write order 100 times in a row. The rest pin the
 * comparator itself: chronology still wins, `seq` is numeric, legacy rows
 * without `seq` keep the old fallback, and `seq` never orders across tasks.
 */

const ACTOR = { type: 'user', id: 'timeline-order' };
// One instant for every write: with a frozen clock every occurredAt ties, so
// only the stored write order can put the timeline right.
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

test('entries written in the same millisecond come out in write order, 100 timelines in a row', async (t) => {
  const { context } = await frozenProject(t, 'timeline-order.sqlite');
  const { app } = context;
  for (let i = 0; i < 100; i++) {
    const lead = await app.modules.get('lead').service.create(
      { firstName: `Same${i}`, lastName: 'Ms', email: `same-ms-${i}@x.example` }, { actor: ACTOR },
    );
    await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
    const task = app.modules.get('work-task').service.listWhere({ subjectId: lead.id })[0];
    await run(app, 'work-task', 'add-note', task.id, { body: `note ${i} before close` });
    await run(app, 'work-task', 'complete', task.id, { note: `done ${i}` });
    await run(app, 'work-task', 'add-note', task.id, { body: `note ${i} after close` });

    const timeline = sortTimeline(app.modules.get('work-activity').service.listWhere({ taskId: task.id }));
    assert.ok(timeline.every((row) => row.occurredAt === FROZEN),
      `iteration ${i}: the frozen clock must hold, or this proves nothing`);
    assert.deepEqual(timeline.map((row) => row.kind),
      ['task_created', 'note', 'task_completed', 'note'], `iteration ${i}: write order`);
    assert.deepEqual(timeline.map((row) => row.seq), [1, 2, 3, 4],
      `iteration ${i}: seq is the append position`);
    assert.equal(timeline[3].body, `note ${i} after close`,
      `iteration ${i}: the note written after the close sorts after it`);
  }
});

test('write order beats a misleading id: a later row sorts later even with the smaller id', () => {
  const rows = [
    { id: 'zzz-written-first', taskId: 't', seq: 1, occurredAt: FROZEN, createdAt: FROZEN },
    { id: 'aaa-written-second', taskId: 't', seq: 2, occurredAt: FROZEN, createdAt: FROZEN },
  ];
  assert.deepEqual(sortTimeline(rows).map((row) => row.id), ['zzz-written-first', 'aaa-written-second']);
  assert.deepEqual(sortTimeline([...rows].reverse()).map((row) => row.id),
    ['zzz-written-first', 'aaa-written-second'], 'input order must not matter');
});

test('chronology still wins over write order', () => {
  const rows = [
    { id: 'later', taskId: 't', seq: 1, occurredAt: '2026-10-17T10:00:00.000Z', createdAt: FROZEN },
    { id: 'earlier', taskId: 't', seq: 2, occurredAt: '2026-10-17T09:00:00.000Z', createdAt: FROZEN },
  ];
  assert.deepEqual(sortTimeline(rows).map((row) => row.id), ['earlier', 'later']);
});

test('seq is numeric, not lexical: seq 10 sorts after seq 9', () => {
  const rows = [
    { id: 'tenth', taskId: 't', seq: 10, occurredAt: FROZEN, createdAt: FROZEN },
    { id: 'ninth', taskId: 't', seq: 9, occurredAt: FROZEN, createdAt: FROZEN },
  ];
  assert.deepEqual(sortTimeline(rows).map((row) => row.id), ['ninth', 'tenth']);
});

test('rows written before seq existed fall back to created stamp then id', () => {
  const rows = [
    { id: 'b', taskId: 't', occurredAt: FROZEN, createdAt: '2026-10-17T10:00:00.000Z' },
    { id: 'a', taskId: 't', occurredAt: FROZEN, createdAt: '2026-10-17T10:00:00.000Z' },
  ];
  assert.deepEqual(sortTimeline(rows).map((row) => row.id), ['a', 'b']);
});

test('seq never orders across tasks: different tasks at the same instant keep the old fallback', () => {
  const rows = [
    { id: 'b', taskId: 'task-two', seq: 1, occurredAt: FROZEN, createdAt: FROZEN },
    { id: 'a', taskId: 'task-one', seq: 9, occurredAt: FROZEN, createdAt: FROZEN },
  ];
  assert.deepEqual(sortTimeline(rows).map((row) => row.id), ['a', 'b'],
    'sequences of different tasks are not comparable, so the id decides deterministically');
});
