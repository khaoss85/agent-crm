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
