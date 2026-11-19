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
