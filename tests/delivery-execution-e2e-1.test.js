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
