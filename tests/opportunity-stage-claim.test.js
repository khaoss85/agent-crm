// @ts-check

// Focused tests for backlog:0b6d33de — the opportunity stage-race cure.
// `setStage` pins each request to the stage its caller saw
// (`expectedFromStage`) and commits through a conditional write gated on
// that stage, so a concurrent winner makes the loser report 409 instead of
// committing twice. The parallel-race layer itself stays covered by
// `two terminal stage changes on one opportunity commit at most once` in
// tests/spine-v2-m4c-http-sdk-admin-cli.test.js (PostgreSQL); these tests
// pin the deterministic contract on the portable store.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { requestOpportunityStageChangeWorkflow } from '../packages/workflows/src/request-opportunity-stage-change.js';

async function fixture() {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const actor = { type: 'user', id: 'stage-claim' };
  const company = await app.services.companies.create({ name: 'Stage Co' }, { actor });
  const contact = await app.services.contacts.create({
    companyId: company.id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@stage.test',
  }, { actor });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Deal',
    valueCents: 1000,
    owner: 'ada',
  }, { actor });
  assert.equal(opportunity.stage, 'qualification');
  return { app, actor, opportunity };
}

test('a stale stage pin loses with 409 and the stage does not move', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  const winner = await app.services.opportunities.setStage(
    opportunity.id,
    'proposal',
    { actor, expectedFromStage: 'qualification' },
  );
  assert.equal(winner.stage, 'proposal');

  await assert.rejects(
    app.services.opportunities.setStage(
      opportunity.id,
      'lost',
      { actor, expectedFromStage: 'qualification' },
    ),
    (error) => error?.code === 'CONFLICT' && error?.status === 409,
    'the loser of a stage race reports conflict',
  );
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'proposal');
});

test('a fresh intent without a pin still commits exactly once', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  const moved = await app.services.opportunities.setStage(opportunity.id, 'proposal', { actor });
  assert.equal(moved.stage, 'proposal');
  const chained = await app.services.opportunities.setStage(opportunity.id, 'lost', { actor });
  assert.equal(chained.stage, 'lost');
});

test('setting the current stage is idempotent, even with a stale pin', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  await app.services.opportunities.setStage(opportunity.id, 'proposal', { actor });
  const same = await app.services.opportunities.setStage(
    opportunity.id,
    'proposal',
    { actor, expectedFromStage: 'qualification' },
  );
  assert.equal(same.stage, 'proposal');
});

test('the stage-change workflow pins its load-time stage on the commit', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  assert.deepEqual(
    requestOpportunityStageChangeWorkflow.steps.map((step) => step.name),
    ['load-opportunity', 'evaluate-commercial-policy', 'apply-stage-policy'],
  );
  const run = await app.workflows.run('request-opportunity-stage-change', {
    opportunityId: opportunity.id,
    targetStage: 'proposal',
  }, { actor });
  assert.equal(run.output.outcome, 'stage_changed');
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'proposal');
});
