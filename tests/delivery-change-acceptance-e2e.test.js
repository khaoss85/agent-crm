import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DELIVERY_POLICY, activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Milestone 14b2 e2e: a running delivery project records what **changed** about
 * it, what it **produced**, and what a human says the customer said — over the
 * real HTTP/SDK path.
 *
 * The load-bearing claim is the one about what does *not* happen: no commercial
 * record moves, and nothing here is an authenticated customer, a legal
 * signature or authorization to bill.
 */

const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const WINDOW = { targetStartDate: '2026-09-20', targetEndDate: '2026-12-20' };
const PARTNER = { partnerRef: 'partner:abc', partnerName: 'ABC Consulting', reason: 'they run our migrations' };

/** An activated contract handed over, started, with its work in progress. */
async function running(t, file) {
  const root = project(t, { withDelivery: true });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { contract } = await activatedContract(root, context.app, { name: 'Change', offers: OFFERS });
  await context.client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
  });
  const app = context.app;
  const row = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
  const workPackages = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: row.id });
  const milestones = app.modules.get('delivery-milestone').service.listWhere({ deliveryProjectId: row.id });
  await context.client.module('delivery-project').action(row.id, 'start-delivery-project', {});
  for (const wp of workPackages) {
    await context.client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
  }
  return { root, context, contract, project: row, workPackages, milestones };
}

/** Every commercial row that must not move, as one comparable string. */
function commercialFingerprint(app) {
  const parts = [];
  for (const name of ['quote', 'quote-version', 'order', 'order-line', 'commercial-contract',
    'contract-version', 'contract-line', 'subscription', 'subscription-line', 'delivery-obligation']) {
    let rows;
    try { rows = app.modules.get(name).service.list({ limit: 500 }); } catch { continue; }
    parts.push(`${name}:${JSON.stringify(rows)}`);
  }
  return parts.join('\n');
}

test('a non-commercial replan is approved into an immutable plan revision', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'replan.sqlite');
  const { client, app } = context;

  const proposed = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'cr-1',
    changeType: 'non_commercial_replan',
    title: 'Move go-live two weeks later',
    reason: 'the customer moved their freeze window',
    requestedScope: 'unchanged scope; dates only',
    requestedStartDate: '2026-10-05',
    requestedEndDate: '2027-01-05',
    workPackageIds: [workPackages[0].id],
    milestoneIds: [milestones[0].id],
  });
  const change = proposed.result.changeRequest;
  assert.equal(change.status, 'proposed');
  assert.equal(change.proposedBy, 'e2e');
  assert.deepEqual(JSON.parse(change.workPackageRefs), [workPackages[0].id]);
  assert.equal(change.commercialDeltaCents, null, 'a replan carries no money');

  const decided = await client.module('delivery-change-request').action(change.id, 'decide-change-request', {
    decision: 'approve',
    reason: 'agreed with the customer on a call',
    revisedEndDate: '2027-01-05',
  });
  assert.equal(decided.result.changeRequest.status, 'approved');
  assert.equal(decided.result.commercialChange, null, 'a replan raises no commercial candidate');
  const revision = decided.result.planRevision;
  assert.equal(revision.version, 1);
  assert.equal(revision.revisedEndDate, '2027-01-05');
  assert.equal(revision.deliveryChangeRequestId, change.id);

  // The revision describes what is planned from here. It never rewrites the
  // M13 handover snapshot the project was created from.
  const project_ = app.modules.get('delivery-project').service.get(row.id);
  assert.equal(project_.targetEndDate, WINDOW.targetEndDate, 'the original planned window is untouched');
  assert.equal(app.modules.get('delivery-handover-run').service.listWhere({ deliveryProjectId: row.id }).length, 1);

  // Decided once. A second decision is refused by the declared state table.
  await assert.rejects(
    () => client.module('delivery-change-request').action(change.id, 'decide-change-request', {
      decision: 'reject', reason: 'changed my mind',
    }),
    (error) => error.status === 409,
    'a decided change is not re-decided',
  );
  assert.equal(app.modules.get('delivery-plan-revision').service.list().length, 1, 'and no second revision exists');
});

test('a commercial change stops at the boundary and moves no commercial record', async (t) => {
  const { context, project: row } = await running(t, 'commercial.sqlite');
  const { client, app } = context;
  const before = commercialFingerprint(app);

  const proposed = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'cr-money',
    changeType: 'commercial_change_required',
    title: 'Add a second migration wave',
    reason: 'the customer acquired another region mid-project',
    commercialDeltaCents: 1_250_000,
    currency: 'EUR',
  });
  const change = proposed.result.changeRequest;

  const decided = await client.module('delivery-change-request').action(change.id, 'decide-change-request', {
    decision: 'approve', reason: 'delivery agrees it is in scope to quote',
  });
  assert.equal(decided.result.changeRequest.status, 'pending_commercial_followup',
    'a state a human can see, not an implicit hop');
  assert.equal(decided.result.planRevision, null, 'a commercial change does not replan by itself');

  const candidate = decided.result.commercialChange;
  assert.equal(candidate.status, 'pending_commercial_followup');
  assert.equal(candidate.deliveryChangeRequestId, change.id);
  assert.equal(candidate.currency, 'EUR');

  // The whole point of the milestone.
  assert.equal(commercialFingerprint(app), before, 'no commercial record moved');
  assert.equal(app.modules.get('quote-version').service.list().length,
    JSON.parse(before.split('quote-version:')[1].split('\n')[0]).length, 'no quote version was created');

  // Nothing invented an amendment or an invoice, and no such record exists.
  for (const forbidden of ['contract-amendment', 'invoice', 'payment', 'billing-eligibility']) {
    assert.throws(() => app.modules.get(forbidden), /Module not found/, `${forbidden} does not exist in this framework`);
  }
});

test('a deliverable cannot outrun the work, and completion is not acceptance', async (t) => {
  const { context, workPackages, milestones } = await running(t, 'deliverable.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];

  const planned = await client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: 'd-1', label: 'Migrated record set', scopeSnapshot: 'all historical rows, verified',
    milestoneId: milestones[1].id,
  });
  const deliverable = planned.result.deliverable;
  assert.equal(deliverable.status, 'planned');

  // Server-authoritative: the work package is still in progress.
  await assert.rejects(
    () => client.module('delivery-deliverable').action(deliverable.id, 'complete-deliverable', {}),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_NOT_ALLOWED',
    'a deliverable cannot complete ahead of the work it belongs to',
  );

  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  const completed = await client.module('delivery-deliverable').action(deliverable.id, 'complete-deliverable', {
    completionEvidenceRef: 'run-2026-0042',
  });
  assert.equal(completed.result.deliverable.status, 'completed');
  assert.equal(completed.result.accepted, false, 'completing is not accepting — two facts, two authors');
  assert.equal(app.modules.get('delivery-acceptance-evidence').service.list().length, 0);

  // Evidence is evidence: no public write path exists at all.
  await assert.rejects(
    () => client.module('delivery-deliverable').create({ label: 'forged' }),
    (error) => Number.isInteger(error.status) && error.status >= 400,
  );
  await assert.rejects(
    () => client.module('delivery-change-request').update(deliverable.id, { status: 'approved' }),
    (error) => Number.isInteger(error.status) && error.status >= 400,
  );
  assert.equal(app.modules.get('delivery-deliverable').service.create, undefined, 'no public create');
  assert.equal(app.modules.get('delivery-acceptance-evidence').service.update, undefined, 'no public update');
});

test('acceptance is recorded evidence, and says exactly that', async (t) => {
  const { context, workPackages, milestones } = await running(t, 'acceptance.sqlite');
  const { client, app } = context;
  const milestone = milestones[1];

  // Nothing to accept yet.
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
      requestKey: 'a-0', customerRef: 'customer:acme',
    }),
    (error) => error.status === 409 && error.code === 'DELIVERY_NOTHING_TO_ACCEPT',
  );

  const wp = workPackages[0];
  const planned = await client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: 'd-1', label: 'Migrated record set', milestoneId: milestone.id,
  });

  // Incomplete work cannot be submitted for acceptance.
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
      requestKey: 'a-1', customerRef: 'customer:acme',
    }),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_NOT_ALLOWED',
  );

  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  await client.module('delivery-deliverable').action(planned.result.deliverable.id, 'complete-deliverable', {});

  const requested = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a-1', customerRef: 'customer:acme', customerContactRef: 'contact:jane',
    customerNameSnapshot: 'Acme GmbH',
  });
  const request = requested.result.acceptanceRequest;
  assert.equal(request.status, 'pending');
  assert.deepEqual(JSON.parse(request.deliverableRefs), [planned.result.deliverable.id]);

  // One open question at a time.
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
      requestKey: 'a-2', customerRef: 'customer:acme',
    }),
    (error) => error.status === 409 && error.code === 'DELIVERY_ACCEPTANCE_ALREADY_PENDING',
  );

  const recorded = await client.module('delivery-acceptance-request').action(request.id, 'record-acceptance', {
    outcome: 'accepted', assertedCustomerRef: 'customer:acme', assertedContactRef: 'contact:jane',
    note: 'confirmed on the go-live call',
  });
  const evidence = recorded.result.acceptanceEvidence;
  assert.equal(evidence.outcome, 'accepted');
  assert.equal(evidence.recordedBy, 'e2e', 'a USER actor recorded it — not the customer');
  assert.equal(recorded.result.acceptanceRequest.status, 'accepted');

  // Recorded acceptance authorizes nothing.
  for (const forbidden of ['invoice', 'payment', 'billing-eligibility', 'service-activation']) {
    assert.throws(() => app.modules.get(forbidden), /Module not found/, `${forbidden} does not exist`);
  }
  const schema = await client.schema();
  const meta = schema.domains.delivery.changeAcceptance;
  assert.match(meta.acceptanceMeaning, /not an authenticated customer action/);
  assert.match(meta.acceptanceMeaning, /not authorization to bill/);
  assert.match(meta.commercialBoundary, /No Quote, Order, Contract/);
  assert.equal(JSON.stringify(meta).includes('function'), false, 'function-free, like every published contract here');
});

test('a rejection is recorded and preserves execution history', async (t) => {
  const { context, workPackages, milestones } = await running(t, 'rejection.sqlite');
  const { client, app } = context;
  const milestone = milestones[1];
  const wp = workPackages[0];

  const planned = await client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: 'd-1', label: 'Migrated record set', milestoneId: milestone.id,
  });
  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  await client.module('delivery-deliverable').action(planned.result.deliverable.id, 'complete-deliverable', {});
  const requested = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a-1', customerRef: 'customer:acme',
  });

  const recorded = await client.module('delivery-acceptance-request').action(
    requested.result.acceptanceRequest.id, 'record-acceptance', {
      outcome: 'rejected', assertedCustomerRef: 'customer:acme', note: 'two fields missing from the export',
    },
  );
  assert.equal(recorded.result.acceptanceEvidence.outcome, 'rejected');
  assert.equal(recorded.result.acceptanceRequest.status, 'rejected');

  // The chosen semantics, asserted rather than assumed: a rejection does not
  // destructively reopen completed work. Rewriting M14a execution evidence
  // would stop M14b1 economics snapshots reproducing.
  assert.equal(app.modules.get('delivery-work-package').service.get(wp.id).status, 'completed',
    'the work package stays completed');
  assert.equal(app.modules.get('delivery-deliverable').service.get(planned.result.deliverable.id).status, 'completed',
    'and so does the deliverable');
  const schema = await client.schema();
  assert.match(schema.domains.delivery.changeAcceptance.rejectionSemantics, /never destructively reopened/);
});

test('every write is a human decision, and an agent is refused', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'human.sqlite');
  const { agentClient, app } = context;
  const wp = workPackages[0];

  const refusals = [
    ['delivery-project', row.id, 'propose-change-request', { changeKey: 'x', changeType: 'non_commercial_replan', title: 't', reason: 'r' }],
    ['delivery-work-package', wp.id, 'plan-deliverable', { deliverableKey: 'x', label: 'l' }],
    ['delivery-milestone', milestones[0].id, 'request-acceptance', { requestKey: 'x', customerRef: 'c' }],
  ];
  for (const [module, id, action, input] of refusals) {
    await assert.rejects(
      () => agentClient.module(module).action(id, action, input),
      (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
      action,
    );
  }
  assert.equal(app.modules.get('delivery-change-request').service.list().length, 0, 'the refusals wrote nothing');
  assert.equal(app.modules.get('delivery-deliverable').service.list().length, 0);
  assert.equal(app.modules.get('delivery-acceptance-request').service.list().length, 0);
});

test('the same key records once, and a divergent retry is refused', async (t) => {
  const { context, project: row } = await running(t, 'idempotent.sqlite');
  const { client, app } = context;
  const input = {
    changeKey: 'cr-1', changeType: 'non_commercial_replan',
    title: 'Move go-live', reason: 'the customer moved their freeze window',
  };

  const first = await client.module('delivery-project').action(row.id, 'propose-change-request', input);
  const second = await client.module('delivery-project').action(row.id, 'propose-change-request', input);
  assert.equal(second.result.created, false, 'a repeat is answered, not duplicated');
  assert.equal(second.result.changeRequest.id, first.result.changeRequest.id);
  assert.equal(app.modules.get('delivery-change-request').service.list().length, 1);

  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'propose-change-request', {
      ...input, title: 'Something else entirely', reason: 'a different reason',
    }),
    (error) => error.status === 409 && error.code === 'DELIVERY_EVIDENCE_CONFLICT'
      && error.details.fields.join(',') === 'reason,title',
    'the divergent fields are named',
  );
  assert.equal(app.modules.get('delivery-change-request').service.list().length, 1, 'and the refusal wrote nothing');
});

test('a change request cannot reference another project\'s work', async (t) => {
  const { context, project: row } = await running(t, 'scoping.sqlite');
  const { client } = context;
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'propose-change-request', {
      changeKey: 'cr-x', changeType: 'non_commercial_replan', title: 't', reason: 'r',
      workPackageIds: ['some-other-projects-work-package'],
    }),
    (error) => error.status === 400 && /does not belong to this delivery project/.test(error.message),
  );
});

test('hostile input stays inert data across every field', async (t) => {
  const { context, project: row } = await running(t, 'hostile.sqlite');
  const { client, app } = context;
  const hostile = '__proto__ <img src=x onerror=alert(1)> \'"`; DROP TABLE delivery_change_requests; --';

  const proposed = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'cr-hostile', changeType: 'non_commercial_replan',
    title: hostile, reason: hostile, requestedScope: hostile,
  });
  const stored = app.modules.get('delivery-change-request').service.get(proposed.result.changeRequest.id);
  assert.equal(stored.title, hostile, 'stored verbatim as inert text');
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');
  assert.ok(app.modules.get('delivery-change-request').service.list().length >= 1, 'the table still exists');

  // Control characters and oversized strings are refused rather than stored.
  for (const [field, value] of [['title', 'a b'], ['reason', 'x'.repeat(3000)]]) {
    await assert.rejects(
      () => client.module('delivery-project').action(row.id, 'propose-change-request', {
        changeKey: `cr-${field}`, changeType: 'non_commercial_replan',
        title: 'ok', reason: 'ok', [field]: value,
      }),
      (error) => error.status === 400,
      field,
    );
  }
});
