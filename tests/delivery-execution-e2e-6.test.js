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
