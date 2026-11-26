import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DELIVERY_POLICY, activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Milestone 14a execution, surface half (voce fb0d1a3517b1): split out of
 * `tests/delivery-execution-e2e.test.js` so each file stays under the
 * per-file ceiling (`MEASURE_FILE_MAX_SEC`, 600 s) even with the server
 * loaded. Same 12 cases, same assertions — only the file layout changed.
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
