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
