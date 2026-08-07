import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DELIVERY_POLICY, activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Milestone 14a e2e: a planned delivery project is **executed** — started, its
 * work packages and milestones moved through an explicit transition table by a
 * human, over the real HTTP/SDK path.
 *
 * It records execution. Nothing here bills, invoices, recognizes revenue,
 * grants a partner anything, or claims a customer accepted anything.
 */

const DELIVERY_OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const WINDOW = { targetStartDate: '2026-09-20', targetEndDate: '2026-12-20' };
const PARTNER = { partnerRef: 'partner:abc-consulting', partnerName: 'ABC Consulting', reason: 'they run our migrations' };

const setup = async (t, file) => {
  const root = project(t, { withDelivery: true });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return { root, context };
};

/** An activated contract handed over to delivery, ready to execute. */
async function handedOver(t, file) {
  const { root, context } = await setup(t, file);
  const { contract } = await activatedContract(root, context.app, { name: 'Execution', offers: DELIVERY_OFFERS });
  await context.client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
  });
  const app = context.app;
  const projectRow = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
  const workPackages = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: projectRow.id });
  const milestones = app.modules.get('delivery-milestone').service.listWhere({ deliveryProjectId: projectRow.id });
  return { root, context, contract, project: projectRow, workPackages, milestones };
}

test('a handed-over project starts, works and completes through the transition table', async (t) => {
  const { context, project: row, workPackages, milestones } = await handedOver(t, 'execute.sqlite');
  const { client, app } = context;

  assert.equal(row.status, 'pending_kickoff', 'M13 leaves it planned');

  await client.module('delivery-project').action(row.id, 'start-delivery-project', { note: 'kickoff held' });
  const started = app.modules.get('delivery-project').service.get(row.id);
  assert.equal(started.status, 'in_progress');
  assert.ok(started.startedAt, 'the start is stamped from the injected clock');
  assert.equal(started.executionNote, 'kickoff held');

  const first = workPackages[0];
  await client.module('delivery-work-package').action(first.id, 'start-work-package', {});
  assert.equal(app.modules.get('delivery-work-package').service.get(first.id).status, 'in_progress');
  await client.module('delivery-work-package').action(first.id, 'complete-work-package', {});
  const done = app.modules.get('delivery-work-package').service.get(first.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.completedAt);

  const milestone = milestones[0];
  await client.module('delivery-milestone').action(milestone.id, 'start-milestone', {});
  await client.module('delivery-milestone').action(milestone.id, 'complete-milestone', {});
  assert.equal(app.modules.get('delivery-milestone').service.get(milestone.id).status, 'completed');
});

test('the transition table is the whole answer, and it refuses everything else', async (t) => {
  const { context, project: row, workPackages } = await handedOver(t, 'transitions.sqlite');
  const { client } = context;
  const wp = workPackages[0];

  // A work package cannot start before its project does.
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'start-work-package', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_NOT_ALLOWED',
    'starting work on a project nobody kicked off',
  );

  await client.module('delivery-project').action(row.id, 'start-delivery-project', {});

  // Completing work that never started skips a state.
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'complete-work-package', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_TRANSITION_NOT_ALLOWED',
  );
  // Starting the project twice is not idempotent — it is a refusal, because the
  // second caller believed something that is no longer true.
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'start-delivery-project', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_TRANSITION_NOT_ALLOWED',
  );

  await client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  // Completed work does not reopen in this milestone.
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'start-work-package', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_TRANSITION_NOT_ALLOWED',
    'no reopen',
  );
});

test('a stale expected state is refused rather than silently overwriting a decision', async (t) => {
  const { context, project: row } = await handedOver(t, 'stale.sqlite');
  const { client } = context;

  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'start-delivery-project', { expectedState: 'in_progress' }),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_CONFLICT',
    'the caller believed a state the record was never in',
  );
  // The honest expectation is accepted.
  await client.module('delivery-project').action(row.id, 'start-delivery-project', { expectedState: 'pending_kickoff' });

  // A second caller holding the old view is refused, not allowed to re-decide.
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'start-delivery-project', { expectedState: 'pending_kickoff' }),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_CONFLICT',
  );
});

test('execution is a human decision, and an agent is refused', async (t) => {
  const { context, project: row } = await handedOver(t, 'human.sqlite');
  await assert.rejects(
    () => context.agentClient.module('delivery-project').action(row.id, 'start-delivery-project', {}),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  assert.equal(
    context.app.modules.get('delivery-project').service.get(row.id).status, 'pending_kickoff',
    'the refusal changed nothing',
  );
});

test('execution state is managed: CRUD cannot set it, and hostile notes stay inert', async (t) => {
  const { context, project: row } = await handedOver(t, 'managed.sqlite');
  const { client, app } = context;

  // Every field is `writable: "managed"`, so the module publishes no update
  // capability at all: the refusal is the route not existing, not a validation
  // message. Either way the guarantee is that the state did not move.
  await assert.rejects(
    () => client.module('delivery-project').update(row.id, { status: 'in_progress' }),
    (error) => Number.isInteger(error.status) && error.status >= 400,
    'a managed lifecycle field is never publicly writable',
  );
  assert.equal(app.modules.get('delivery-project').service.get(row.id).status, 'pending_kickoff');

  const nasty = '<img src=x onerror=alert(1)>${7*7}`;-- \' or 1=1';
  await client.module('delivery-project').action(row.id, 'start-delivery-project', { note: nasty });
  assert.equal(app.modules.get('delivery-project').service.get(row.id).executionNote, nasty, 'stored verbatim as text');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('the execution surface is published truthfully, with no forbidden vocabulary', async (t) => {
  const { context } = await handedOver(t, 'schema.sqlite');
  const schema = await context.client.schema();
  const execution = schema.domains.delivery.execution;

  assert.equal(execution.executionContract, 1);
  assert.deepEqual(execution.transitions['delivery-project'], { pending_kickoff: ['in_progress'], in_progress: ['completed'] });
  assert.match(execution.humanApproval, /human-actor boundary, not Delivery Manager role/);
  assert.match(execution.concurrency, /expectedState/);
  for (const absent of ['billing', 'invoicing', 'payment', 'revenue recognition', 'partner access']) {
    assert.ok(execution.notModeled.includes(absent), `${absent} is stated as not modeled`);
  }
  const serialized = JSON.stringify(schema.domains.delivery);
  assert.equal(serialized.includes('function'), false, 'the schema block is function-free');
  for (const forbidden of ['invoice.created', 'revenue.recognized', 'partner.paid', 'customer.identity.verified', 'service.activated']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} appears nowhere`);
  }
});


test('every declared state is reachable, and every declared transition has an action', async (t) => {
  const { context } = await handedOver(t, 'reachable.sqlite');
  const execution = (await context.client.schema()).domains.delivery.execution;
  const initial = { 'delivery-project': 'pending_kickoff', 'delivery-work-package': 'planned', 'delivery-milestone': 'planned' };

  for (const [kind, table] of Object.entries(execution.transitions)) {
    // Exactly which edges the shipped actions walk, straight from the package.
    const walked = new Set(Object.values(execution.producedStates[kind])
      .flatMap((step) => step.from.map((from) => `${from} -> ${step.to}`)));
    const declared = new Set([initial[kind], ...Object.keys(table), ...Object.values(table).flat()]);
    const reached = new Set(Object.values(execution.producedStates[kind]).map((step) => step.to));

    for (const state of declared) {
      assert.ok(
        state === initial[kind] || reached.has(state),
        `${kind}: no shipped action moves a record to "${state}" — a declared state nothing reaches is a capability claim without a capability`,
      );
    }
    const edges = Object.entries(table).flatMap(([from, targets]) => targets.map((to) => `${from} -> ${to}`));
    for (const edge of edges) {
      assert.ok(walked.has(edge), `${kind}: the table promises ${edge}, and no action walks it`);
    }
    for (const edge of walked) {
      assert.ok(edges.includes(edge), `${kind}: an action walks ${edge}, which the table does not allow`);
    }
  }
});

test('a work package blocks with stated evidence, resumes, and holds its project open meanwhile', async (t) => {
  const { context, project: row, workPackages, milestones } = await handedOver(t, 'blocked.sqlite');
  const { client, app } = context;
  const packages = app.modules.get('delivery-work-package').service;
  const wp = workPackages[0];

  await client.module('delivery-project').action(row.id, 'start-delivery-project', {});

  // Resuming something that was never blocked would land in the same state as
  // starting it, so the transition table alone does not refuse it — the action
  // says which states it applies to, and this is not one of them.
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'resume-work-package', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_NOT_ALLOWED',
  );
  assert.equal(packages.get(wp.id).status, 'planned', 'and it did not move');

  await client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
  assert.ok(packages.get(wp.id).startedAt, 'starting stamps the start; resuming must not have skipped it');

  // A block with no stated reason is not evidence, so it is refused.
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'block-work-package', {}),
    (error) => error.status === 400 && /reason/.test(error.message),
  );

  await client.module('delivery-work-package').action(wp.id, 'block-work-package', { reason: 'customer VPN access not granted' });
  const blocked = packages.get(wp.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockedReason, 'customer VPN access not granted');
  assert.equal(blocked.blockedBy, 'e2e', 'who blocked it is recorded — the calling user actor, not a role');
  assert.ok(blocked.blockedAt, 'and when, from the injected clock');

  // Blocked work is not completed, so the project cannot close over it.
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'complete-delivery-project', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_HIERARCHY_INCOMPLETE',
  );

  await client.module('delivery-work-package').action(wp.id, 'resume-work-package', { note: 'access granted' });
  const resumed = packages.get(wp.id);
  assert.equal(resumed.status, 'in_progress');
  assert.deepEqual(
    [resumed.blockedReason, resumed.blockedAt, resumed.blockedBy], [null, null, null],
    'the record describes the block it is under now, and it is under none',
  );
  // The block that was cleared is still evidence — in the audit log, where
  // history belongs.
  const audited = app.audit.list({ entityType: 'delivery-work-package' })
    .some((event) => JSON.stringify(event.data ?? {}).includes('customer VPN access not granted'));
  assert.ok(audited, 'the cleared block survives in the audit log');
  assert.ok(milestones.length > 0, 'the fixture has milestones to close');
});

test('a delivery project closes only when every work package and milestone is completed', async (t) => {
  const { context, project: row, workPackages, milestones } = await handedOver(t, 'close.sqlite');
  const { client, app } = context;

  await client.module('delivery-project').action(row.id, 'start-delivery-project', {});

  // Nothing finished yet.
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'complete-delivery-project', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_HIERARCHY_INCOMPLETE',
  );

  for (const wp of workPackages) {
    await client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
    await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  }
  // Work done, milestones not: still open, and the refusal names what is left.
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'complete-delivery-project', {}),
    (error) => error.code === 'DELIVERY_HIERARCHY_INCOMPLETE' && /milestone/.test(error.message),
  );

  for (const milestone of milestones) {
    await client.module('delivery-milestone').action(milestone.id, 'start-milestone', {});
    await client.module('delivery-milestone').action(milestone.id, 'complete-milestone', {});
  }
  await client.module('delivery-project').action(row.id, 'complete-delivery-project', { note: 'all delivered' });
  const closed = app.modules.get('delivery-project').service.get(row.id);
  assert.equal(closed.status, 'completed');
  assert.ok(closed.completedAt);

  // A closed project is closed: nothing may be worked on under it any more.
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestones[0].id, 'start-milestone', {}),
    (error) => error.status === 409,
  );
});

test('a milestone cannot move while its project is not running', async (t) => {
  const { context, project: row, milestones } = await handedOver(t, 'milestone-guard.sqlite');
  const { client, app } = context;

  await assert.rejects(
    () => client.module('delivery-milestone').action(milestones[0].id, 'start-milestone', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_NOT_ALLOWED',
    'a milestone of a project nobody kicked off',
  );
  assert.equal(app.modules.get('delivery-milestone').service.get(milestones[0].id).status, 'planned');

  await client.module('delivery-project').action(row.id, 'start-delivery-project', {});
  await client.module('delivery-milestone').action(milestones[0].id, 'start-milestone', {});
  assert.equal(app.modules.get('delivery-milestone').service.get(milestones[0].id).status, 'in_progress');
});

test('operator free text is actually bounded, in length and in content', async (t) => {
  const { context, project: row, workPackages } = await handedOver(t, 'bounds.sqlite');
  const { client, app } = context;
  const limit = (await context.client.schema()).domains.delivery.execution.textLimits.note;
  assert.equal(limit, 500);

  // The published bound is enforced, not merely published: it used to be passed
  // to a validator that takes no options and ignored it entirely, so a 50 KB
  // note was stored verbatim.
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'start-delivery-project', { note: 'x'.repeat(limit + 1) }),
    (error) => error.status === 400 && /at most 500 characters/.test(error.message),
  );
  await client.module('delivery-project').action(row.id, 'start-delivery-project', { note: 'x'.repeat(limit) });
  assert.equal(app.modules.get('delivery-project').service.get(row.id).executionNote.length, limit);

  const wp = workPackages[0];
  await client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
  // NUL, DEL, and the two Unicode line terminators. Built from code points so
  // this test file stays text a reviewer can read and git can diff.
  for (const code of [0x0000, 0x001f, 0x007f, 0x2028, 0x2029]) {
    await assert.rejects(
      () => client.module('delivery-work-package').action(wp.id, 'block-work-package', { reason: `a${String.fromCodePoint(code)}b` }),
      (error) => error.status === 400 && /control characters/.test(error.message),
      `U+${code.toString(16).padStart(4, '0')} is refused`,
    );
  }
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'block-work-package', { reason: 'y'.repeat(limit + 1) }),
    (error) => error.status === 400 && /at most 500 characters/.test(error.message),
  );
  // Tab, newline and carriage return are ordinary text an operator types.
  const typed = ['line one', 'line', 'two'].join(String.fromCodePoint(0x0a));
  await client.module('delivery-work-package').action(wp.id, 'block-work-package', { reason: typed });
  assert.equal(app.modules.get('delivery-work-package').service.get(wp.id).blockedReason, typed);
});


test('the record descriptions the schema publishes do not deny what the package does', async (t) => {
  const { context } = await handedOver(t, 'truthful.sqlite');
  const schema = await context.client.schema();

  // The manifest description is the primary human- and agent-readable sentence
  // about a record: /api/schema publishes it verbatim, the Admin renders it as
  // the page lede directly above the action buttons, and the factory bakes it
  // into every generated project. A description that denies the actions shipped
  // three keys away is a falsehood in a published contract — and it was one,
  // because M13's wording survived the revision-2 bump.
  const executed = new Set(
    schema.domains.delivery.actions
      .filter((name) => !name.startsWith('commercial-contract.'))
      .map((name) => name.split('.')[0]),
  );
  assert.ok(executed.size >= 3, 'the execution actions span the three record kinds');

  const denials = /\bnever (executes|progresses)|does not execute|no progress\b|nothing (starts|progresses|completes)/i;
  for (const module of executed) {
    const description = schema.modules.find((entry) => entry.name === module)?.description ?? '';
    assert.ok(description, `${module} publishes a description`);
    assert.equal(
      denials.test(description), false,
      `${module}: the published description denies execution while the package ships actions that execute it — "${description}"`,
    );
  }

  // What is still true must still be said: none of these records claims a
  // capability the milestone does not have.
  for (const module of executed) {
    const description = schema.modules.find((entry) => entry.name === module).description;
    assert.equal(
      /\b(invoice|invoicing|bills it|revenue|accepted by the customer)\b/i.test(description.replace(/never [^.;]*/gi, '')),
      false,
      `${module}: the description claims something M14a does not do`,
    );
  }
});
