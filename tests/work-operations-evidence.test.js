import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { activatedContract, boot, project } from './helpers/contracts-project.js';
import { createFollowUp } from '../packages/work/src/index.js';

/**
 * Work v1 — the evidence a milestone is finished by, not the happy path
 * (ADR-030, `docs/QUALITY_GATES.md` §2).
 *
 * Every write in this package is attacked here: a fault injected after each
 * significant row and after the audit write, two connections racing one business
 * identity, hostile strings through every field, and the one claim a capability
 * that writes in somebody else's transaction has to earn — that the **caller's**
 * transaction rolls back as a whole when anything in it fails.
 *
 * **Exact reads, and the ones that are N/A with a reason.**
 *
 * | read | verdict |
 * |---|---|
 * | `sourceKey` uniqueness on creation | proven past 500 rows below |
 * | the subject timeline | proven past 500 rows below |
 * | the second consumer's per-subject uniqueness | proven past 500 rows below |
 * | loading a task by id for an action | **N/A** — a primary-key lookup. Seeding 500 rows in front of an indexed unique read tests the fixture, not the read |
 * | an open-task limit | **N/A** — Work v1 has no open-task limit. Inventing one so that a collection read existed would be inventing a rule to test |
 */

const ACTOR = { type: 'user', id: 'evidence' };
const run = (app, module, action, recordId, input, actor = ACTOR) =>
  app.runAction({ module, action, recordId, input, actor });

/** The Lead path: fastest real caller of the one follow-up creator. */
async function leadProject(t, file, options = {}) {
  const root = project(t, { withDomain: false, withWorkTables: true });
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
    'export const generatedActions = [qualifyLead];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n'));
  const applied = spawnSync(process.execPath, [
    '--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
    join(root, 'examples/starters/b2b-lead-qualification/lead.module.json'), '--apply', '--root', root,
  ], { encoding: 'utf8', cwd: root });
  assert.equal(applied.status, 0, applied.stderr);
  const context = await boot(root, join(root, 'data', file), options);
  t.after(() => context.close());
  return { root, context };
}

const newLead = (app, name) => app.modules.get('lead').service.create(
  { firstName: name, lastName: 'Case', email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@x.example` },
  { actor: ACTOR },
);

/** Row counts for every table Work or the caller could have touched. */
function counts(app) {
  return {
    tasks: app.modules.get('work-task').service.list({ limit: 1000 }).length,
    activities: app.modules.get('work-activity').service.list({ limit: 1000 }).length,
    taskAudits: app.audit.list({ entityType: 'work-task' }).length,
    activityAudits: app.audit.list({ entityType: 'work-activity' }).length,
  };
}

// ---------------------------------------------------------------------------
// Fault injection, after every significant write
// ---------------------------------------------------------------------------

test('a fault after the task row, after the activity row, or at the audit write rolls everything back', async (t) => {
  const { context } = await leadProject(t, 'faults.sqlite');
  const { app } = context;
  const tasks = app.modules.get('work-task').service;
  const activities = app.modules.get('work-activity').service;
  const realTaskCreate = tasks.createManaged.bind(tasks);
  const realActivityCreate = activities.createManaged.bind(activities);
  const realAudit = app.audit.record?.bind(app.audit) ?? null;

  const injections = [
    ['after the task row is written', () => {
      tasks.createManaged = async (...args) => {
        const created = await realTaskCreate(...args);
        throw Object.assign(new Error('injected: after the task write'), { created });
      };
      return () => { tasks.createManaged = realTaskCreate; };
    }],
    ['after the activity row is written', () => {
      activities.createManaged = async (...args) => {
        await realActivityCreate(...args);
        throw new Error('injected: after the activity write');
      };
      return () => { activities.createManaged = realActivityCreate; };
    }],
    ['at the audit write', () => {
      let armed = true;
      app.audit.record = (...args) => {
        if (armed && String(args[0]?.entityType ?? args[0]) === 'work-task') {
          armed = false;
          throw new Error('injected: at the audit write');
        }
        return realAudit(...args);
      };
      return () => { app.audit.record = realAudit; };
    }],
  ];

  for (const [what, arm] of injections) {
    if (what === 'at the audit write' && !realAudit) continue;
    const before = counts(app);
    const lead = await newLead(app, 'Fault');
    const disarm = arm();
    await assert.rejects(
      () => run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' }),
      /injected/,
      what,
    );
    disarm();
    // Nothing partial survives, and the CALLER's own write is gone with it.
    assert.deepEqual(counts(app), before, `${what}: no orphan row and no fake success audit`);
    assert.equal(app.modules.get('lead').service.get(lead.id).status, 'new',
      `${what}: the caller's transaction rolled back as a whole`);
    // The failed run still records an honest trace, written outside the
    // business transaction so the rollback cannot take it with it.
    const failed = app.database.raw
      .prepare("SELECT status FROM workflow_runs WHERE workflow_name = 'lead.qualify' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(failed.status, 'failed', `${what}: an honest failed trace`);

    // …and the retry produces exactly one complete result.
    const retried = await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
    assert.equal(retried.ok, true);
    const after = counts(app);
    assert.equal(after.tasks, before.tasks + 1, `${what}: exactly one task after the retry`);
    assert.equal(after.activities, before.activities + 1, `${what}: exactly one activity after the retry`);
  }
});

test('a package consumer that fails after the follow-up takes the whole transaction down', async (t) => {
  const root = project(t, { withService: true, withLifecycle: true, withWork: true, followUp: true });
  const context = await boot(root, join(root, 'data', 'caller-rollback.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { contract } = await activatedContract(root, app);

  // The failure is injected into the CALLER's own last write, after the
  // capability has already created the task and its activity. This is the claim
  // a capability that writes in somebody else's transaction has to earn.
  const followups = app.modules.get('commercial-followup').service;
  const realCreate = followups.createManaged.bind(followups);
  const tasksBefore = app.modules.get('work-task').service.list({ limit: 1000 }).length;
  const activitiesBefore = app.modules.get('work-activity').service.list({ limit: 1000 }).length;

  // The follow-up row is written first and the task second, so failing the task
  // write proves the caller's row goes with it.
  const tasks = app.modules.get('work-task').service;
  const realTaskCreate = tasks.createManaged.bind(tasks);
  tasks.createManaged = async () => { throw new Error('injected: the follow-up task could not be opened'); };
  await assert.rejects(
    () => run(app, 'commercial-contract', 'request-commercial-followup', contract.id, {
      intent: 'renewal', summary: 'Prepare the renewal quote',
    }),
    /injected/,
  );
  tasks.createManaged = realTaskCreate;
  followups.createManaged = realCreate;

  assert.equal(followups.listWhere({ contractId: contract.id }).length, 0,
    'no commercial-followup survives a failed follow-up task');
  assert.equal(app.modules.get('work-task').service.list({ limit: 1000 }).length, tasksBefore);
  assert.equal(app.modules.get('work-activity').service.list({ limit: 1000 }).length, activitiesBefore);
  assert.equal(app.audit.list({ entityType: 'commercial-followup' }).length, 0, 'no fake success audit');

  // The retry then produces exactly one complete result: one ask, one task, one
  // activity, and no duplicate of anything.
  const retried = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id, {
    intent: 'renewal', summary: 'Prepare the renewal quote',
  });
  assert.equal(followups.listWhere({ contractId: contract.id }).length, 1);
  assert.equal(app.modules.get('work-task').service
    .listWhere({ subjectResource: 'commercial-followup', subjectId: retried.result.id }).length, 1);
});

// ---------------------------------------------------------------------------
// Two connections, one business identity
// ---------------------------------------------------------------------------

test('two connections racing one source key: one winner, the loser replays, no raw SQLite text', async (t) => {
  const { root } = await leadProject(t, 'race-setup.sqlite');
  const dbPath = join(root, 'data', 'race.sqlite');
  const { createAccordoApp } = await import(`${join(root, 'packages/app/src/index.js')}`.replace(/^/, 'file://'));
  const appA = createAccordoApp({ dbPath, busyTimeoutMs: 400 });
  const appB = createAccordoApp({ dbPath, busyTimeoutMs: 400 });
  t.after(() => { appA.close(); appB.close(); });

  const lead = await newLead(appA, 'Racer');
  const results = await Promise.allSettled([
    appA.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor: ACTOR }),
    appB.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor: ACTOR }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one winner');
  const loser = results.find((r) => r.status === 'rejected').reason;
  assert.equal(loser.status, 409, `loser: ${loser.code} ${loser.message}`);
  assert.ok(['INVALID_STATE', 'CONFLICT', 'WORK_FOLLOW_UP_CONFLICT'].includes(loser.code), loser.code);
  assert.doesNotMatch(String(loser.message), /SQLITE_|UNIQUE constraint failed|database is locked$/,
    'a driver string never reaches a client');

  assert.equal(appA.modules.get('work-task').service.listWhere({ subjectId: lead.id }).length, 1);
  assert.equal(appA.modules.get('work-activity').service.listWhere({ subjectId: lead.id }).length, 1,
    'one task, one activity — never a half pair across two connections');
  assert.equal(appA.audit.list({ entityType: 'work-task' }).length, 1);

  // The loser's retry of the SAME business identity, straight at the creator,
  // resolves to the winner's row rather than to a second one.
  const replay = await createFollowUp(
    { modules: appB.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' },
    {
      sourceKey: `lead-qualified:${lead.id}`,
      title: appA.modules.get('work-task').service.listWhere({ subjectId: lead.id })[0].title,
      dueAt: '2026-08-12T09:00:00.000Z',
      subject: { resource: 'lead', id: lead.id, owner: 'host' },
      source: { package: 'host', action: 'qualify' },
    },
  );
  assert.equal(replay.replayed, true);
  assert.equal(appB.modules.get('work-task').service.listWhere({ subjectId: lead.id }).length, 1);
});

// ---------------------------------------------------------------------------
// Exact reads, past the display bound
// ---------------------------------------------------------------------------

test('the correctness reads are exact past 500 rows: source key, subject timeline, consumer uniqueness', async (t) => {
  const { context } = await leadProject(t, 'exact.sqlite');
  const { app } = context;
  const tasks = app.modules.get('work-task').service;
  const activities = app.modules.get('work-activity').service;

  // 600 tasks and 600 activities on one crowded subject, so the row that
  // decides the answer is far outside any page an unbounded list would return.
  const subjectId = 'crowded-subject';
  for (let index = 0; index < 600; index += 1) {
    await tasks.createManaged({
      sourceKey: `seed:${index}`, title: `Seed ${index}`, status: 'open',
      subjectResource: 'lead', subjectId, subjectOwner: 'host',
      sourcePackage: 'host', sourceAction: 'qualify',
    }, { actor: ACTOR });
    await activities.createManaged({
      sourceKey: `seed-activity:${index}`, kind: 'note', subjectResource: 'lead', subjectId,
      body: `Seed note ${index}`, occurredAt: '2026-08-01T00:00:00.000Z',
      actorType: 'user', actorId: 'seed', sourcePackage: 'host', sourceAction: 'add-note',
    }, { actor: ACTOR });
  }

  // The uniqueness read finds the FIRST seeded row, 600 rows back, which no
  // display bound in this framework would ever show.
  assert.equal(tasks.listWhere({ sourceKey: 'seed:0' }).length, 1);
  assert.equal(tasks.list({ limit: 100 }).length, 100, 'the display bound is real');
  assert.equal(tasks.list({ limit: 100 }).some((row) => row.sourceKey === 'seed:0'), false,
    'the display bound genuinely does not reach it — the exact read is doing the work');
  assert.equal(tasks.list({ limit: 500 }).some((row) => row.sourceKey === 'seed:0'), false,
    'nor does a 500-row page');
  assert.equal(tasks.countWhere({ subjectResource: 'lead', subjectId }), 600);
  assert.equal(activities.countWhere({ subjectResource: 'lead', subjectId }), 600);
  assert.equal(activities.listWhere({ subjectResource: 'lead', subjectId }).length, 600,
    'the subject timeline is complete, not the first page of it');

  // Creating a follow-up under a key buried 600 rows deep replays it rather
  // than opening a second one.
  const replay = await createFollowUp(
    { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' },
    {
      sourceKey: 'seed:0', title: 'Seed 0', dueAt: null,
      subject: { resource: 'lead', id: subjectId, owner: 'host' },
      source: { package: 'host', action: 'qualify' },
    },
  );
  assert.equal(replay.replayed, true);
  assert.equal(tasks.countWhere({ sourceKey: 'seed:0' }), 1);
  assert.equal(tasks.countWhere({ subjectResource: 'lead', subjectId }), 600, 'no 601st row');

  // …and a divergent payload behind that same buried key is still a named 409.
  await assert.rejects(
    () => createFollowUp(
      { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' },
      {
        sourceKey: 'seed:0', title: 'Something else', dueAt: null,
        subject: { resource: 'lead', id: subjectId, owner: 'host' },
        source: { package: 'host', action: 'qualify' },
      },
    ),
    (error) => error.code === 'WORK_FOLLOW_UP_CONFLICT' && error.details.conflictingFields.includes('title'),
  );
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

const HOSTILE = [
  '__proto__', 'constructor', 'prototype',
  '<script>alert(1)</script>', '"; DROP TABLE work_tasks; --', "' OR '1'='1",
  '`${process.env}`', 'line\nbreak', 'null byte', 'sep arator',
  '‮evil', 'x'.repeat(5000),
];

test('hostile input stays inert data or is refused, across every field', async (t) => {
  const { context } = await leadProject(t, 'hostile.sqlite');
  const { app } = context;
  const ctx = { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' };
  const base = {
    sourceKey: 'hostile:1', title: 'ok',
    subject: { resource: 'lead', id: 'l1', owner: 'host' },
    source: { package: 'host', action: 'qualify' },
  };

  let index = 0;
  for (const value of HOSTILE) {
    index += 1;
    // A SOURCE KEY, RESOURCE, PACKAGE or ACTION is a canonical identity with a
    // grammar. A value outside that grammar is refused with a field-tied 400;
    // one inside it — `constructor` and `prototype` are ordinary identifiers —
    // is stored as inert data and pollutes nothing. Both are acceptable; being
    // *interpreted* is not, and that is what is asserted.
    for (const [label, request] of [
      ['sourceKey', { ...base, sourceKey: value }],
      ['resource', { ...base, sourceKey: `k${index}`, subject: { ...base.subject, resource: value } }],
      ['sourcePackage', { ...base, sourceKey: `p${index}`, source: { package: value, action: 'qualify' } }],
      ['sourceAction', { ...base, sourceKey: `a${index}`, source: { package: 'host', action: value } }],
    ]) {
      try {
        await createFollowUp(ctx, request);
      } catch (error) {
        assert.equal(error.status, 400, `${label} ${value}: refused, never accepted half-way`);
      }
      assert.equal({}.polluted, undefined, `${label} ${value}: no prototype was polluted`);
      assert.equal(Object.prototype.toString.call({}), '[object Object]');
    }
    // A hostile TITLE, LABEL or SUBJECT ID is free-ish text: either stored as
    // inert data, or refused for a stated bound. Never interpreted.
    const request = {
      ...base, sourceKey: `t${index}`, title: value,
      subject: { resource: 'lead', id: `id${index}`, owner: 'host', label: value },
    };
    try {
      const created = await createFollowUp(ctx, request);
      assert.equal(created.task.title, value.trim(), 'stored verbatim as data');
      assert.equal(Object.prototype.hasOwnProperty.call({}, value), false, 'no prototype was polluted');
      assert.equal({}.polluted, undefined);
    } catch (error) {
      assert.equal(error.status, 400, `${value}: refused, never accepted half-way`);
    }
  }
  // Nothing above created a table, dropped one, or moved the row count off the
  // number of accepted requests.
  const tables = app.database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work\\_%' ESCAPE '\\' ORDER BY name").all()
    .map((row) => row.name);
  assert.deepEqual(tables, ['work_activities', 'work_tasks'], 'no table was created or dropped by any of it');
  assert.equal({}.polluted, undefined);
});

test('an undeclared package consumer is still refused, and the declaration is what decides', async (t) => {
  const root = project(t, { withLifecycle: true, withWork: true, followUp: true });
  const context = await boot(root, join(root, 'data', 'declaration.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  // The capability opens for the consumer that declared it…
  const opened = app.domains.capability({
    consumer: 'lifecycle', capability: 'follow-up', version: 1,
    context: { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' },
  });
  assert.deepEqual(Object.keys(opened).sort(), ['createFollowUp', 'findBySourceKey']);
  assert.equal(Object.isFrozen(opened), true, 'no mutable service object escapes the seam');

  // …and for nobody else. A package that did not declare it is refused even
  // though the capability plainly exists in this composition.
  assert.throws(
    () => app.domains.capability({
      consumer: 'contracts', capability: 'follow-up', version: 1, context: { modules: app.modules },
    }),
    (error) => error.code === 'CAPABILITY_NOT_DECLARED',
  );
  // A version nobody offers is a 404, not a silent fallback to v1.
  assert.throws(
    () => app.domains.capability({
      consumer: 'lifecycle', capability: 'follow-up', version: 2, context: { modules: app.modules },
    }),
    (error) => error.status === 404 || error.code === 'CAPABILITY_NOT_DECLARED',
  );
});
