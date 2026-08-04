import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';

async function fixture() {
  const app = createAgentCrmApp({ dbPath: ':memory:', approvalThresholdCents: 5_000_000 });
  const actor = { type: 'user', id: 'daniele' };
  const company = await app.services.companies.create({ name: 'Acme' }, { actor });
  const contact = await app.services.contacts.create({
    companyId: company.id,
    firstName: 'Mario',
    lastName: 'Rossi',
    email: 'mario@example.com',
  }, { actor });
  return { app, actor, company, contact };
}

test('renewal below threshold moves directly to proposal', async (t) => {
  const { app, actor, company, contact } = await fixture();
  t.after(() => app.close());
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Standard renewal',
    type: 'renewal',
    valueCents: 4_999_999,
    owner: 'sales-1',
  }, { actor });

  const run = await app.workflows.run('request-opportunity-stage-change', {
    opportunityId: opportunity.id,
    targetStage: 'proposal',
  }, { actor });

  assert.equal(run.output.outcome, 'stage_changed');
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'proposal');
  assert.equal(app.services.approvals.list().length, 0);
  assert.deepEqual(
    app.workflows.getRun(run.runId).spans.map((span) => span.name),
    ['load-opportunity', 'evaluate-commercial-policy', 'apply-stage-policy'],
  );
});

test('renewal at threshold requires approval and records the human decision', async (t) => {
  const { app, actor, company, contact } = await fixture();
  t.after(() => app.close());
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Enterprise renewal',
    type: 'renewal',
    valueCents: 5_000_000,
    owner: 'sales-2',
  }, { actor });

  const requestRun = await app.workflows.run('request-opportunity-stage-change', {
    opportunityId: opportunity.id,
    targetStage: 'proposal',
  }, { actor: { type: 'agent', id: 'codex' } });

  assert.equal(requestRun.output.outcome, 'approval_required');
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'approval_pending');
  const approval = app.services.approvals.list({ status: 'pending' })[0];
  assert.equal(approval.opportunityId, opportunity.id);

  const decisionRun = await app.workflows.run('decide-opportunity-approval', {
    approvalId: approval.id,
    decision: 'approved',
  }, { actor: { type: 'user', id: 'manager-1' } });

  assert.equal(decisionRun.output.outcome, 'approved');
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'proposal');
  assert.equal(app.services.approvals.get(approval.id).decidedBy, 'manager-1');
  assert.ok(app.audit.list({ entityType: 'opportunity', entityId: opportunity.id }).length >= 3);
  assert.equal(app.notifications.list().length, 1);
});

test('new business does not use the renewal approval policy', async (t) => {
  const { app, actor, company } = await fixture();
  t.after(() => app.close());
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    name: 'Large new business',
    type: 'new_business',
    valueCents: 20_000_000,
    owner: 'sales-3',
  }, { actor });

  await app.workflows.run('request-opportunity-stage-change', {
    opportunityId: opportunity.id,
    targetStage: 'proposal',
  }, { actor });

  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'proposal');
  assert.equal(app.services.approvals.list().length, 0);
});


test('approval workflow rejects an agent pretending to make the human decision', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const { enterpriseRenewal } = await app.seedDemo();
  await app.workflows.run(
    'request-opportunity-stage-change',
    { opportunityId: enterpriseRenewal.id, targetStage: 'proposal' },
    { actor: { type: 'agent', id: 'sales-copilot' } },
  );
  const approval = app.services.approvals.list({ status: 'pending' })[0];

  await assert.rejects(
    app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: approval.id, decision: 'approved' },
      { actor: { type: 'agent', id: 'sales-copilot' } },
    ),
    /explicit human actor/,
  );

  assert.equal(app.services.approvals.get(approval.id).status, 'pending');
  assert.equal(app.services.opportunities.get(enterpriseRenewal.id).stage, 'approval_pending');
});
