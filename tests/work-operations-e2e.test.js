import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const { root, context } = await leadProject(t, 'lead-work.sqlite');
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
  const { root, context } = await leadProject(t, 'lifecycle-table.sqlite');
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
  const { root, context } = await leadProject(t, 'human-boundary.sqlite');
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
  const { root, context } = await leadProject(t, 'notes.sqlite');
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
  const { root, context } = await leadProject(t, 'idempotency.sqlite');
  const { app } = context;
  // Imported from the throwaway project, not from this checkout: the witness
  // that proves the caller's transaction is minted by the database that
  // application composed, and recognized only by the core instance it was
  // minted in (Spine v2 M2D). Driving a composed app with a second copy of
  // Work is a mixed composition no deployment can produce, and it now fails
  // closed. The two sources are byte-identical — `project()` copies this one.
  const { createFollowUp } = await import(pathToFileURL(join(root, 'packages/work/src/index.js')).href);
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
  // REVIEW-70: this call used to be made with no transaction open at all, which
  // is precisely what the package must refuse — see the transaction test below.
  // Every direct call here now runs inside one, exactly as a consumer's action
  // does.
  const context1 = { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' };
  const tx = (fn) => app.database.transactionAsync(fn);
  const first = await tx(() => createFollowUp(context1, request));
  assert.equal(first.replayed, false);

  // The lost-response retry: byte-identical ask, and the client gets back the
  // record it could not see it had already created — the task AND its creation
  // activity, not just the task.
  const replay = await tx(() => createFollowUp(context1, request));
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.activity.id, first.activity.id);
  assert.equal(replay.activity.kind, 'task_created');
  assert.equal(app.modules.get('work-task').service.list().length, 1);
  assert.equal(app.modules.get('work-activity').service.list().length, 1);

  // A different ask under the same key is refused, NAMING the fields.
  await assert.rejects(
    () => tx(() => createFollowUp(context1, { ...request, title: 'Something else entirely', dueAt: '2026-09-01T09:00:00.000Z' })),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'WORK_FOLLOW_UP_CONFLICT');
      assert.deepEqual(error.details.conflictingFields, ['dueAt', 'title']);
      assert.equal(error.details.existingId, first.task.id);
      return true;
    },
  );
  assert.equal(app.modules.get('work-task').service.list().length, 1, 'a refusal writes nothing');

  // REVIEW-70 regression. The comparison used to read FOUR fields — title,
  // dueAt and the subject's resource and id — so a replay could carry a
  // different subject owner, a different owning package, a different source
  // package or a different source action and still be answered "already done",
  // handing the caller a row that says something else. Every semantic field is
  // compared, and each one is named on its own.
  for (const [field, divergent] of [
    ['subjectOwner', { subject: { resource: 'lead', id: lead.id, owner: 'package', ownerPackage: 'lifecycle' } }],
    ['subjectId', { subject: { resource: 'lead', id: 'some-other-lead', owner: 'host' } }],
    ['subjectResource', { subject: { resource: 'company', id: lead.id, owner: 'host' } }],
    ['sourceAction', { source: { package: 'host', action: 'convert' } }],
  ]) {
    await assert.rejects(
      () => tx(() => createFollowUp(context1, { ...request, ...divergent })),
      (error) => {
        assert.equal(error.code, 'WORK_FOLLOW_UP_CONFLICT', field);
        assert.ok(error.details.conflictingFields.includes(field),
          `${field} must be named: got ${JSON.stringify(error.details.conflictingFields)}`);
        return true;
      },
      field,
    );
  }

  // The ONE documented non-authoritative field: a display label taken at
  // creation. A caller whose only difference is a renamed subject is describing
  // the same work, so it replays — and the stored snapshot is not rewritten.
  const relabelled = await tx(() => createFollowUp(context1, {
    ...request, subject: { ...request.subject, label: 'Retry Client SpA (renamed)' },
  }));
  assert.equal(relabelled.replayed, true);
  assert.equal(relabelled.task.id, first.task.id);
  assert.equal(relabelled.task.subjectLabel, first.task.subjectLabel, 'a snapshot is never refreshed');
  assert.equal(app.modules.get('work-task').service.list().length, 1);
});

// ---------------------------------------------------------------------------
// REVIEW-70: the transactional context is verified, not assumed
// ---------------------------------------------------------------------------

test('a follow-up outside the caller transaction is refused, so no half pair can exist', async (t) => {
  const { root, context } = await leadProject(t, 'no-transaction.sqlite');
  const { app } = context;
  // Imported from the throwaway project, not from this checkout: the witness
  // that proves the caller's transaction is minted by the database that
  // application composed, and recognized only by the core instance it was
  // minted in (Spine v2 M2D). Driving a composed app with a second copy of
  // Work is a mixed composition no deployment can produce, and it now fails
  // closed. The two sources are byte-identical — `project()` copies this one.
  const { createFollowUp } = await import(pathToFileURL(join(root, 'packages/work/src/index.js')).href);
  const ctx = { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' };
  const request = {
    sourceKey: 'orphan:1', title: 'Follow up', dueAt: null,
    subject: { resource: 'lead', id: 'l1', owner: 'host' },
    source: { package: 'host', action: 'qualify' },
  };

  // Called with no transaction open, each managed write commits on its own
  // savepoint: a fault between them left a committed task with no activity —
  // the half pair this package says it never produces. It is refused before the
  // first write instead.
  assert.equal(app.database.raw.isTransaction, false);
  await assert.rejects(
    () => createFollowUp(ctx, request),
    (error) => error.code === 'WORK_TRANSACTION_REQUIRED' && error.status === 500,
  );
  assert.equal(app.modules.get('work-task').service.list().length, 0, 'the refusal writes nothing');

  // Inside a transaction it works, and a fault after the task write takes the
  // task down with it rather than leaving it behind.
  const activities = app.modules.get('work-activity').service;
  const realCreate = activities.createManaged.bind(activities);
  activities.createManaged = async () => { throw new Error('injected fault after the task write'); };
  await assert.rejects(
    () => app.database.transactionAsync(() => createFollowUp(ctx, { ...request, sourceKey: 'orphan:2' })),
    /injected fault/,
  );
  activities.createManaged = realCreate;
  assert.equal(app.modules.get('work-task').service.list().length, 0, 'no task survives its missing activity');
  assert.equal(activities.list().length, 0);
});

// ---------------------------------------------------------------------------
// REVIEW-70: the source key is the caller's business identity, not a regex
// ---------------------------------------------------------------------------

test('a real business identity is accepted whatever digits it contains, and bad syntax is refused', async (t) => {
  const { root, context } = await leadProject(t, 'source-key.sqlite');
  const { app } = context;
  // Imported from the throwaway project, not from this checkout: the witness
  // that proves the caller's transaction is minted by the database that
  // application composed, and recognized only by the core instance it was
  // minted in (Spine v2 M2D). Driving a composed app with a second copy of
  // Work is a mixed composition no deployment can produce, and it now fails
  // closed. The two sources are byte-identical — `project()` copies this one.
  const { createFollowUp } = await import(pathToFileURL(join(root, 'packages/work/src/index.js')).href);
  const ctx = { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' };
  const base = {
    title: 'x', subject: { resource: 'lead', id: 'l1', owner: 'host' },
    source: { package: 'host', action: 'qualify' },
  };
  const tx = (fn) => app.database.transactionAsync(fn);

  // These were ALL refused by the first cut's clock regex, and every one of
  // them is a stable business identity that never moves between two retries.
  // A generic capability cannot tell a clock from a customer number, so it does
  // not try: this is the false-positive set the regex cost us.
  const legitimate = [
    'customer:1234567890123',        // a 13-digit external customer number
    'stripe-evt:1712345678901',      // a provider event id
    'order:9876543210987654',        // a 16-digit order number
    'phone:3933312345678',           // an E.164-ish identity
    'meeting:2027-01-31T14:00',      // a business event whose scheduled instant IS its identity
    'renewal-decision:c1:2027-01-31', // a date-only business round
  ];
  for (const sourceKey of legitimate) {
    const created = await tx(() => createFollowUp(ctx, { ...base, sourceKey }));
    assert.equal(created.task.sourceKey, sourceKey, sourceKey);
    // And it is genuinely stable: the identical ask replays rather than opening
    // a second task, which is the property the regex was standing in for.
    const again = await tx(() => createFollowUp(ctx, { ...base, sourceKey }));
    assert.equal(again.replayed, true, sourceKey);
    assert.equal(again.task.id, created.task.id, sourceKey);
  }
  assert.equal(app.modules.get('work-task').service.list().length, legitimate.length);

  // Structural syntax is still the boundary, and it is the whole boundary.
  for (const sourceKey of ['', '   ', ':leading-colon', 'has space', 'ctrlchar', 'x'.repeat(201)]) {
    await assert.rejects(
      () => tx(() => createFollowUp(ctx, { ...base, sourceKey })),
      (error) => error.status === 400,
      JSON.stringify(sourceKey),
    );
  }
});

// ---------------------------------------------------------------------------
// REVIEW-70: dueAt must name a day that existed
// ---------------------------------------------------------------------------

test('an impossible due date is refused rather than rolled over to a plausible one', async (t) => {
  const { root, context } = await leadProject(t, 'due-at.sqlite');
  const { app } = context;
  // Imported from the throwaway project, not from this checkout: the witness
  // that proves the caller's transaction is minted by the database that
  // application composed, and recognized only by the core instance it was
  // minted in (Spine v2 M2D). Driving a composed app with a second copy of
  // Work is a mixed composition no deployment can produce, and it now fails
  // closed. The two sources are byte-identical — `project()` copies this one.
  const { createFollowUp } = await import(pathToFileURL(join(root, 'packages/work/src/index.js')).href);
  const ctx = { modules: app.modules, actor: ACTOR, now: () => '2026-08-01T00:00:00.000Z' };
  const base = {
    sourceKey: 'due:1', title: 'x', subject: { resource: 'lead', id: 'l1', owner: 'host' },
    source: { package: 'host', action: 'qualify' },
  };
  const tx = (fn) => app.database.transactionAsync(fn);

  // `Date.parse` rolls these to 2027-03-02 and 2027-05-01. Storing a date the
  // caller never chose, as evidence, with nothing on the row saying it was
  // invented, is the ADR-028 defect — refused here (ADR-030 addendum 1).
  for (const dueAt of ['2027-02-30', '2027-02-30T10:00:00.000Z', '2027-04-31', '2025-02-29']) {
    await assert.rejects(
      () => tx(() => createFollowUp(ctx, { ...base, dueAt })),
      (error) => error.status === 400 && /real calendar date/.test(error.message),
      dueAt,
    );
  }
  assert.equal(app.modules.get('work-task').service.list().length, 0);

  // Real days, in every ISO form, are stored canonically as before.
  const real = [
    ['2027-02-28', '2027-02-28T00:00:00.000Z'],
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['2027-03-01T09:30:00+02:00', '2027-03-01T07:30:00.000Z'],
  ];
  for (const [index, [dueAt, stored]] of real.entries()) {
    const created = await tx(() => createFollowUp(ctx, { ...base, sourceKey: `due:real:${index}`, dueAt }));
    assert.equal(created.task.dueAt, stored, dueAt);
  }
});

// ---------------------------------------------------------------------------
// dueAt is evidence, at an injected instant
// ---------------------------------------------------------------------------

test('dueAt never moves a task: the clock is stepped past it and the row is byte-identical', async (t) => {
  let instant = '2026-08-01T00:00:00.000Z';
  const { root, context } = await leadProject(t, 'due.sqlite', () => instant);
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
