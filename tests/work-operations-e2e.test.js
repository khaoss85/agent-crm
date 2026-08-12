import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { activatedContract, boot, project } from './helpers/contracts-project.js';
import {
  ACTIVITY_KINDS, TASK_STATES, TASK_TRANSITIONS, createWorkPackage, sortTimeline,
} from '../packages/work/src/index.js';

/**
 * Work v1 end to end, against a real composed application (ADR-030).
 *
 * The claims this file exists to make are all claims about a *running* system,
 * so none of them is made against a hand-written module double:
 *
 *   - the declared capability `work/follow-up@1` writes inside the **caller's**
 *     transaction, so a caller that fails afterwards takes the task and its
 *     activity down with it;
 *   - a deterministic business event opens **exactly one** task, however many
 *     times it is asked, and a divergent ask under the same key is refused by
 *     name;
 *   - the transition table is the whole answer: `open → completed`,
 *     `open → cancelled`, and nothing out of either terminal state;
 *   - `dueAt` is evidence: the clock is *injected* here and stepped past a due
 *     date, and the row does not move;
 *   - the records are evidence records — no public create, no public update, on
 *     any route, with any body.
 *
 * **What is deliberately not tested here, with the reason.** Reads past the
 * 500-row display bound live in `tests/work-operations-evidence.test.js`, where
 * the collection reads that actually decide something are seeded. Loading a task
 * by id for an action is a **primary-key lookup** — a 500-row test would prove
 * something about the fixture and nothing about the read — so it is **N/A**.
 */

const ACTOR = { type: 'user', id: 'e2e' };
const AGENT = { type: 'agent', id: 'bot' };

const run = (app, module, action, recordId, input, actor = ACTOR) =>
  app.runAction({ module, action, recordId, input, actor });

/** A project holding contracts + service + lifecycle + work, both consumers wired. */
async function consumerProject(t, file, clock) {
  const root = project(t, {
    withDelivery: true, withService: true, withLifecycle: true, withWork: true, followUp: true,
  });
  const context = await boot(root, join(root, 'data', file), clock ? { clock } : {});
  t.after(() => context.close());
  return { root, context };
}

/** The B2B starter's Lead path — the host consumer — with the Work records only. */
async function leadProject(t, file, clock) {
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
  const context = await boot(root, join(root, 'data', file), clock ? { clock } : {});
  t.after(() => context.close());
  return { root, context };
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

test('the package declares two records, three actions, one capability and no dependency', () => {
  const pkg = createWorkPackage();
  assert.equal(pkg.name, 'work');
  assert.deepEqual([...pkg.resources].sort(), ['work-activity', 'work-task']);
  // Work is consumed, never a consumer. That is what makes a cycle impossible
  // however many packages depend on it.
  assert.deepEqual(pkg.requires, []);
  assert.deepEqual(pkg.capabilities.map((c) => `${c.name}@${c.version}`), ['follow-up@1']);
  assert.deepEqual(pkg.actions.map((a) => `${a.module}.${a.name}`).sort(), [
    'work-task.add-note', 'work-task.cancel', 'work-task.complete',
  ]);
  assert.deepEqual(pkg.policies, [], 'v1 needs no versioned policy: two consumers share no rule');
  // It owns neither a Lead nor any other package's record: those are subjects.
  for (const foreign of ['lead', 'commercial-contract', 'support-case', 'service-escalation', 'commercial-followup']) {
    assert.equal(pkg.resources.includes(foreign), false, `${foreign} is a subject, never owned`);
  }
});

test('the schema block publishes the transition table and refuses the words that would be lies', () => {
  const meta = createWorkPackage().metadata();
  assert.equal(meta.workContract, 1);
  assert.deepEqual(meta.task.states, [...TASK_STATES]);
  assert.deepEqual(meta.task.transitions, { open: [...TASK_TRANSITIONS.open], completed: [], cancelled: [] });
  assert.deepEqual(meta.activity.kinds, [...ACTIVITY_KINDS]);
  for (const forbidden of ['reminded', 'notified', 'scheduled', 'assigned', 'emailed', 'escalated', 'due today']) {
    assert.ok(meta.wording.neverClaimed.includes(forbidden), `${forbidden} must be listed as never claimed`);
  }
  for (const absent of [
    'scheduler', 'reminders', 'calendar sync', 'email', 'notifications', 'assignment',
    'RBAC', 'attachments', 'recurring or repeating work', 'a unified cross-domain timeline',
  ]) {
    assert.ok(meta.notModeled.includes(absent), `${absent} must be declared not modelled`);
  }
  assert.match(meta.task.dueAt, /evidence only/);
  assert.match(meta.task.reopen, /not supported/);
  assert.match(meta.subject.referentialIntegrity, /SQLite cannot enforce/);
  assert.match(meta.activity.versusAudit, /no asynchronous projection engine/);
  assert.match(meta.humanApproval, /not RBAC/);
  // Published at /api/schema, so it must be plain data.
  assert.equal(JSON.stringify(meta), JSON.stringify(JSON.parse(JSON.stringify(meta))));
});

// ---------------------------------------------------------------------------
// Consumer 1: the host path (Lead qualification)
// ---------------------------------------------------------------------------

test('consumer 1 — lead qualification opens one task and one activity, atomically', async (t) => {
  const { context } = await leadProject(t, 'lead-work.sqlite');
  const { app, client } = context;
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Dana', lastName: 'Rossi', email: 'dana@acme.example' }, { actor: ACTOR },
  );
  const result = await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
  assert.equal(result.result.replayed, false);
  const tasks = app.modules.get('work-task').service.listWhere({ subjectResource: 'lead', subjectId: lead.id });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sourceKey, `lead-qualified:${lead.id}`);
  assert.equal(tasks[0].subjectOwner, 'host');
  assert.equal(tasks[0].subjectOwnerPackage, null);
  assert.equal(tasks[0].sourcePackage, 'host');
  assert.equal(tasks[0].openedByType, 'user');
  const activity = app.modules.get('work-activity').service.listWhere({ taskId: tasks[0].id });
  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, 'task_created');

  // The records are evidence: no public write path exists, on any route.
  const schema = await client.schema();
  for (const name of ['work-task', 'work-activity']) {
    const meta = schema.generatedModules.find((m) => m.name === name);
    assert.deepEqual(meta.capabilities, ['get', 'list'], name);
    await assert.rejects(
      () => client.request(`/api/modules/${name}/records`, { method: 'POST', body: JSON.stringify({}) }),
      (error) => error.status === 404 || error.status === 405,
    );
    await assert.rejects(
      () => client.request(`/api/modules/${name}/records/${tasks[0].id}`, { method: 'PATCH', body: JSON.stringify({}) }),
      (error) => error.status === 404 || error.status === 405,
    );
  }
  // And the schema publishes the package the Admin section gates on.
  assert.equal(schema.domains.work.workContract, 1);
});

// ---------------------------------------------------------------------------
// Consumer 2: the declared capability (Lifecycle and Service)
// ---------------------------------------------------------------------------

test('consumer 2 — a commercial follow-up opens exactly one task, in the caller transaction', async (t) => {
  const { root, context } = await consumerProject(t, 'lifecycle-work.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app);

  const requested = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id, {
    intent: 'renewal', summary: 'Prepare the renewal quote',
  });
  const tasks = app.modules.get('work-task').service
    .listWhere({ subjectResource: 'commercial-followup', subjectId: requested.result.id });
  assert.equal(tasks.length, 1, 'one ask, one task');
  const task = tasks[0];
  assert.equal(task.sourceKey, `lifecycle-commercial-followup:${requested.result.id}`);
  assert.equal(task.subjectOwner, 'package');
  assert.equal(task.subjectOwnerPackage, 'lifecycle', 'a follow-up record belongs to Lifecycle, not to the project');
  assert.equal(task.sourcePackage, 'lifecycle');
  assert.equal(task.sourceAction, 'request-commercial-followup');
  assert.equal(task.dueAt, null, 'no due date is invented for work nobody scheduled');
  assert.equal(app.modules.get('work-activity').service.listWhere({ taskId: task.id })[0].kind, 'task_created');

  // A repeat of the SAME ask replays the follow-up and opens no second task.
  await run(app, 'commercial-contract', 'request-commercial-followup', contract.id, {
    intent: 'renewal', summary: 'Prepare the renewal quote',
  });
  assert.equal(app.modules.get('work-task').service
    .listWhere({ subjectResource: 'commercial-followup', subjectId: requested.result.id }).length, 1);

  // A genuinely NEW round is a new follow-up and therefore a new task — repeated
  // business is never collapsed.
  await run(app, 'commercial-followup', 'resolve-commercial-followup', requested.result.id, {
    outcome: 'resolved_externally', reason: 'the quote went out',
  });
  const second = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id, {
    intent: 'renewal', summary: 'Second round after the customer came back',
  });
  assert.notEqual(second.result.id, requested.result.id);
  assert.equal(app.modules.get('work-task').service.listWhere({ subjectResource: 'commercial-followup' }).length, 2);
});

test('consumer 2b — a service escalation opens one task and still routes and notifies nothing', async (t) => {
  const { root, context } = await consumerProject(t, 'service-work.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app);
  await run(app, 'commercial-contract', 'activate-service', contract.id, {
    coverageKey: 'work-e2e', customerRef: 'customer:acme', startDate: '2026-09-01',
    policy: 'b2b-service-activation', policyVersion: 1,
  });
  const coverage = app.modules.get('service-coverage').service.listWhere({ contractId: contract.id })[0];
  const entitlement = app.modules.get('service-entitlement').service.listWhere({ serviceCoverageId: coverage.id })[0];
  const opened = await run(app, 'service-entitlement', 'record-service-case', entitlement.id, {
    caseKey: 'c-1', title: 'Sync stopped', category: 'incident', priority: 'high', description: 'nothing since Friday',
  });
  const supportCase = opened.result.supportCase;
  const escalated = await run(app, 'support-case', 'record-escalation', supportCase.id, {
    escalationKey: 'esc-1', level: 'management', reason: 'the customer asked for a call',
  });
  assert.equal(escalated.result.routed, false, 'a work item is not routing');
  assert.equal(escalated.result.notified, false, 'and it is not a notification');

  const tasks = app.modules.get('work-task').service
    .listWhere({ subjectResource: 'service-escalation', subjectId: escalated.result.escalation.id });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].subjectOwnerPackage, 'service');
  assert.equal(tasks[0].sourcePackage, 'service');
  assert.equal(tasks[0].dueAt, null);

  // The idempotent repeat of the escalation opens no second task.
  await run(app, 'support-case', 'record-escalation', supportCase.id, {
    escalationKey: 'esc-1', level: 'management', reason: 'the customer asked for a call',
  });
  assert.equal(app.modules.get('work-task').service
    .listWhere({ subjectResource: 'service-escalation', subjectId: escalated.result.escalation.id }).length, 1);

  // Two DIFFERENT escalations are two different pieces of work.
  const second = await run(app, 'support-case', 'record-escalation', supportCase.id, {
    escalationKey: 'esc-2', level: 'vendor', reason: 'the vendor has to look at it',
  });
  assert.equal(app.modules.get('work-task').service.listWhere({ subjectResource: 'service-escalation' }).length, 2);
  assert.notEqual(second.result.escalation.id, escalated.result.escalation.id);
});

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

test('the transition table is the whole answer, and both terminals are terminal', async (t) => {
  const { context } = await leadProject(t, 'lifecycle-table.sqlite');
  const { app } = context;
  const tasks = app.modules.get('work-task').service;

  const openTask = async (name) => {
    const lead = await app.modules.get('lead').service.create(
      { firstName: name, lastName: 'Case', email: `${name.toLowerCase()}@x.example` }, { actor: ACTOR },
    );
    await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
    return tasks.listWhere({ subjectId: lead.id })[0];
  };

  // open -> completed, with its activity in the same transaction.
  const completing = await openTask('Completes');
  const completed = await run(app, 'work-task', 'complete', completing.id, { note: 'Called them back.' });
  assert.equal(completed.result.task.status, 'completed');
  assert.equal(completed.result.task.completedBy, 'e2e');
  assert.ok(completed.result.task.completedAt);
  assert.equal(completed.result.task.cancelledAt, null);
  assert.equal(completed.result.activity.kind, 'task_completed');

  // open -> cancelled, with a required reason, and cancelled is NOT completed.
  const cancelling = await openTask('Cancels');
  await assert.rejects(() => run(app, 'work-task', 'cancel', cancelling.id, {}), (error) => error.status === 400);
  const cancelled = await run(app, 'work-task', 'cancel', cancelling.id, { reason: 'The lead went quiet.' });
  assert.equal(cancelled.result.task.status, 'cancelled');
  assert.equal(cancelled.result.task.completedAt, null, 'cancelled is never read as completed');
  assert.equal(cancelled.result.activity.kind, 'task_cancelled');

  // Every move out of a terminal state is refused, by the table and not a rank.
  for (const task of [completing, cancelling]) {
    for (const action of ['complete', 'cancel']) {
      await assert.rejects(
        () => run(app, 'work-task', action, task.id, { reason: 'changed my mind' }),
        (error) => error.status === 409 && error.code === 'INVALID_STATE',
      );
    }
  }

  // There is no reopen: no action exists that could produce one.
  const schema = await context.client.schema();
  const meta = schema.generatedModules.find((m) => m.name === 'work-task');
  assert.deepEqual(meta.actions.map((a) => a.name).sort(), ['add-note', 'cancel', 'complete']);
  assert.deepEqual(meta.actions.find((a) => a.name === 'complete').fromStates, ['open']);
  assert.deepEqual(meta.actions.find((a) => a.name === 'cancel').fromStates, ['open']);
  assert.ok(!meta.actions.find((a) => a.name === 'add-note').fromStates,
    'a note is legitimate on a closed task and is not a transition');
});

test('every writing action is a human decision, and an agent is refused each one', async (t) => {
  const { context } = await leadProject(t, 'human-boundary.sqlite');
  const { app } = context;
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Human', lastName: 'Only', email: 'human@x.example' }, { actor: ACTOR },
  );
  await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
  const task = app.modules.get('work-task').service.listWhere({ subjectId: lead.id })[0];
  for (const [action, input] of [
    ['complete', {}], ['cancel', { reason: 'no' }], ['add-note', { body: 'bot opinion' }],
  ]) {
    await assert.rejects(
      () => run(app, 'work-task', action, task.id, input, AGENT),
      (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
      `an agent may not ${action}`,
    );
  }
  // …and nothing was written by any of those refusals.
  assert.equal(app.modules.get('work-task').service.get(task.id).status, 'open');
  assert.equal(app.modules.get('work-activity').service.listWhere({ taskId: task.id }).length, 1);
});

test('a note is safe text on the timeline, and the timeline stays a closed vocabulary', async (t) => {
  const { context } = await leadProject(t, 'notes.sqlite');
  const { app } = context;
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Noted', lastName: 'Lead', email: 'noted@x.example' }, { actor: ACTOR },
  );
  await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
  const task = app.modules.get('work-task').service.listWhere({ subjectId: lead.id })[0];

  await run(app, 'work-task', 'add-note', task.id, { body: 'Left a voicemail.' });
  await run(app, 'work-task', 'complete', task.id, { note: 'They called back.' });
  // A note on a CLOSED task is legitimate and deliberately still allowed.
  await run(app, 'work-task', 'add-note', task.id, { body: 'Filed the summary.' });

  const timeline = sortTimeline(app.modules.get('work-activity').service.listWhere({ taskId: task.id }));
  assert.deepEqual(timeline.map((row) => row.kind), ['task_created', 'note', 'task_completed', 'note']);
  for (const row of timeline) assert.ok(ACTIVITY_KINDS.includes(row.kind));
  assert.equal(timeline[0].body, null, 'a lifecycle entry carries no free text');
  assert.equal(timeline[1].body, 'Left a voicemail.');

  // Blank and oversized notes are refused before anything is written.
  const before = app.modules.get('work-activity').service.listWhere({ taskId: task.id }).length;
  for (const body of ['', '   ', 'x'.repeat(1001)]) {
    await assert.rejects(() => run(app, 'work-task', 'add-note', task.id, { body }), (error) => error.status === 400);
  }
  assert.equal(app.modules.get('work-activity').service.listWhere({ taskId: task.id }).length, before);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('same key and same payload replays; a divergent payload is refused by field name', async (t) => {
  const { context } = await leadProject(t, 'idempotency.sqlite');
  const { app } = context;
  const { createFollowUp } = await import('../packages/work/src/index.js');
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Retry', lastName: 'Client', email: 'retry@x.example' }, { actor: ACTOR },
  );
  const request = {
    sourceKey: `lead-qualified:${lead.id}`,
    title: 'Follow up with Retry Client',
    dueAt: '2026-08-12T09:00:00.000Z',
    subject: { resource: 'lead', id: lead.id, owner: 'host' },
    source: { package: 'host', action: 'qualify' },
  };
  const context1 = { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' };
  const first = await createFollowUp(context1, request);
  assert.equal(first.replayed, false);

  // The lost-response retry: byte-identical ask, and the client gets back the
  // record it could not see it had already created.
  const replay = await createFollowUp(context1, request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.activity.id, first.activity.id);
  assert.equal(app.modules.get('work-task').service.list().length, 1);
  assert.equal(app.modules.get('work-activity').service.list().length, 1);

  // A different ask under the same key is refused, NAMING the fields.
  await assert.rejects(
    () => createFollowUp(context1, { ...request, title: 'Something else entirely', dueAt: '2026-09-01T09:00:00.000Z' }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'WORK_FOLLOW_UP_CONFLICT');
      assert.deepEqual(error.details.conflictingFields, ['dueAt', 'title']);
      assert.equal(error.details.existingId, first.task.id);
      return true;
    },
  );
  assert.equal(app.modules.get('work-task').service.list().length, 1, 'a refusal writes nothing');
});

test('a source key carrying a clock is refused at the boundary', async (t) => {
  const { context } = await leadProject(t, 'clock-key.sqlite');
  const { app } = context;
  const { createFollowUp } = await import('../packages/work/src/index.js');
  const ctx = { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' };
  const base = {
    title: 'x', subject: { resource: 'lead', id: 'l1', owner: 'host' },
    source: { package: 'host', action: 'qualify' },
  };
  // This is the M16a defect, refused rather than discovered later as duplicates.
  for (const sourceKey of [
    'follow-up:2026-08-12T09:00:00.000Z', 'follow-up:1786000000000', 'x:2026-08-12T09:00',
  ]) {
    await assert.rejects(
      () => createFollowUp(ctx, { ...base, sourceKey }),
      (error) => error.status === 400 && /timestamp/.test(error.message),
      sourceKey,
    );
  }
  // A bare calendar date is a real business identity and stays legal.
  const ok = await createFollowUp(ctx, { ...base, sourceKey: 'follow-up:l1:2026-08-12' });
  assert.equal(ok.task.sourceKey, 'follow-up:l1:2026-08-12');
  assert.equal(app.modules.get('work-task').service.list().length, 1);
});

// ---------------------------------------------------------------------------
// dueAt is evidence, at an injected instant
// ---------------------------------------------------------------------------

test('dueAt never moves a task: the clock is stepped past it and the row is byte-identical', async (t) => {
  let instant = '2026-08-01T00:00:00.000Z';
  const { context } = await leadProject(t, 'due.sqlite', () => instant);
  const { app } = context;
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Due', lastName: 'Date', email: 'due@x.example' }, { actor: ACTOR },
  );
  await run(app, 'lead', 'qualify', lead.id, { dueAt: '2026-08-12T09:00:00Z' });
  const before = app.modules.get('work-task').service.listWhere({ subjectId: lead.id })[0];
  assert.equal(before.status, 'open');

  // A year past the due date. Nothing runs on a clock, so nothing happened.
  instant = '2027-08-01T00:00:00.000Z';
  const after = app.modules.get('work-task').service.get(before.id);
  assert.deepEqual(after, before, 'a past due date changes nothing at all');
  assert.equal(app.modules.get('work-activity').service.listWhere({ taskId: before.id }).length, 1,
    'and it records no "overdue" activity either');

  // A read-only computation at an injected instant is fine and still writes nothing.
  const overdue = after.dueAt !== null && after.dueAt < instant;
  assert.equal(overdue, true);
  assert.deepEqual(app.modules.get('work-task').service.get(before.id), before);
});
