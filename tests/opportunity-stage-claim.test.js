// @ts-check

// Focused tests for backlog:0b6d33de — the opportunity stage-race cure.
// `setStage` pins each request to the stage its caller saw
// (`expectedFromStage`) and commits through a conditional write fenced on
// the stage-generation token (`stage`, `stage_entered_at`), so a concurrent
// stage winner makes the loser report 409 instead of committing twice,
// while a pipeline-managed patch that never moves the lifecycle position
// preserves the fence and commits. Rows that never entered a pipeline carry
// no token yet and fence on (`stage`, `updated_at`) exactly once. The
// parallel-race layer itself stays covered by
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

test('setting the current stage without a pin is idempotent', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  await app.services.opportunities.setStage(opportunity.id, 'proposal', { actor });
  const same = await app.services.opportunities.setStage(opportunity.id, 'proposal', { actor });
  assert.equal(same.stage, 'proposal');
});

test('two intents converging on one target commit exactly once: one success, one 409', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  const winner = await app.services.opportunities.setStage(
    opportunity.id,
    'lost',
    { actor, expectedFromStage: 'qualification' },
  );
  assert.equal(winner.stage, 'lost');

  // The loser pins the same origin and wants the same target the winner just
  // committed: it committed nothing, so it must report 409, never success.
  await assert.rejects(
    app.services.opportunities.setStage(
      opportunity.id,
      'lost',
      { actor, expectedFromStage: 'qualification' },
    ),
    (error) => error?.code === 'CONFLICT' && error?.status === 409,
    'a stale pin converging on the committed target reports conflict',
  );
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'lost');
});

test('a stale intent does not commit after the stage cycled away and back (ABA)', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  const svc = app.services.opportunities;
  await svc.setStage(opportunity.id, 'proposal', { actor, expectedFromStage: 'qualification' });

  // Force the loser's affectedRows==0 branch deterministically. The sync
  // store cannot interleave inside one call, so the test reproduces the exact
  // race interleaving at the service seam: the first read inside setStage
  // returns the pre-race snapshot (what A saw before B and C committed),
  // while the row itself cycles proposal → negotiation → proposal through
  // two real committed writes (what B and C did). Each leg stamps
  // stage_entered_at, exactly as a production stage write through setStage
  // does (raw UPDATE stage exists only in tests); the stage value is back,
  // but the generation token moved on, so A's stale claim must match zero
  // rows and report 409 with the stage unchanged.
  const snapshot = svc.get(opportunity.id);
  assert.equal(snapshot.stage, 'proposal');
  const bump = (iso) => new Date(Date.parse(iso) + 1).toISOString();
  const execute = svc.database.storage.sync.execute.bind(svc.database.storage.sync);
  const cycle = () => {
    const first = bump(snapshot.updatedAt);
    const tokenBase = typeof snapshot.stageEnteredAt === 'string' ? snapshot.stageEnteredAt : snapshot.updatedAt;
    const firstToken = bump(tokenBase);
    execute({
      kind: 'update', table: 'opportunities', values: [
        { column: 'stage', value: 'negotiation' }, { column: 'updated_at', value: first },
        { column: 'stage_entered_at', value: firstToken },
      ], where: [{ column: 'id', op: 'eq', value: opportunity.id }],
    });
    execute({
      kind: 'update', table: 'opportunities', values: [
        { column: 'stage', value: 'proposal' }, { column: 'updated_at', value: bump(first) },
        { column: 'stage_entered_at', value: bump(firstToken) },
      ], where: [{ column: 'id', op: 'eq', value: opportunity.id }],
    });
  };
  const originalGet = svc.get.bind(svc);
  let reads = 0;
  svc.get = (id) => {
    reads += 1;
    if (reads === 1 && id === opportunity.id) {
      cycle();
      return snapshot;
    }
    return originalGet(id);
  };
  try {
    await assert.rejects(
      svc.setStage(opportunity.id, 'won', { actor, expectedFromStage: 'proposal' }),
      (error) => error?.code === 'CONFLICT' && error?.status === 409,
      'a stale intent after a round-trip reports conflict',
    );
  } finally {
    delete svc.get;
  }
  assert.ok(reads >= 2, 'the loser re-read the current stage for the 409 detail');
  const settled = originalGet(opportunity.id);
  assert.equal(settled.stage, 'proposal');
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

test('an envelope retry replays the first attempt intent instead of re-reading the winner stage', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());

  const load = requestOpportunityStageChangeWorkflow.steps[0];
  const services = { opportunities: app.services.opportunities };
  const input = { opportunityId: opportunity.id, targetStage: 'lost' };
  // One `sticky` object per engine run() call: the engine hands the same
  // object to every envelope attempt, so the second load below is the retry
  // of the first after its SERIALIZABLE transaction aborted.
  const sticky = {};
  const first = await load.execute({ input, services, sticky });
  assert.equal(first.originalStage, 'qualification');

  // The concurrent winner commits between the loser attempt 1 and its retry.
  await app.services.opportunities.setStage(opportunity.id, 'proposal', { actor });

  const retry = await load.execute({ input, services, sticky });
  assert.equal(
    retry.originalStage,
    'qualification',
    'the retry replays the first attempt intent, never the winner stage',
  );
  assert.equal(retry.opportunity.stage, 'proposal');

  // And the commit built on that replayed intent loses with 409: no re-base
  // onto the winner stage (proposal → lost), hence no second commit.
  await assert.rejects(
    app.services.opportunities.setStage(
      opportunity.id,
      'lost',
      { actor, expectedFromStage: retry.originalStage },
    ),
    (error) => error?.code === 'CONFLICT' && error?.status === 409,
    'the replayed stale intent reports conflict instead of committing twice',
  );
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'proposal');
});

test('a managed patch between the read and the claim does not fail a valid stage transition', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());
  const svc = app.services.opportunities;

  // The opportunity rides a pipeline: placement sets the stage-generation
  // token (`stage_entered_at`), and from then on the pipeline runtime bumps
  // the row `updated_at` on every managed patch.
  await svc.applyManaged(opportunity.id, {
    pipelineKey: 'b2b-sales',
    pipelineStage: 'discovery',
    stageEnteredAt: '2026-08-01T00:00:00.000Z',
  }, { actor });
  const placed = svc.get(opportunity.id);
  assert.equal(placed.stageEnteredAt, '2026-08-01T00:00:00.000Z');

  // The review interleaving: a managed patch that never moves the lifecycle
  // position (no `stage_entered_at` in the patch) lands between setStage's
  // internal read and its conditional claim. The fence is stage-owned, so
  // the claim still matches exactly one row and commits.
  const bump = (iso) => new Date(Date.parse(iso) + 1).toISOString();
  const execute = svc.database.storage.sync.execute.bind(svc.database.storage.sync);
  const originalGet = svc.get.bind(svc);
  let reads = 0;
  svc.get = (id) => {
    reads += 1;
    const snapshot = originalGet(id);
    if (reads === 1 && id === opportunity.id) {
      execute({
        kind: 'update', table: 'opportunities', values: [
          { column: 'pipeline_stage', value: 'demo' },
          { column: 'updated_at', value: bump(snapshot.updatedAt) },
        ], where: [{ column: 'id', op: 'eq', value: opportunity.id }],
      });
    }
    return snapshot;
  };
  try {
    const moved = await svc.setStage(opportunity.id, 'proposal', { actor });
    assert.equal(moved.stage, 'proposal');
  } finally {
    delete svc.get;
  }
  const settled = originalGet(opportunity.id);
  assert.equal(settled.stage, 'proposal');
  assert.equal(settled.pipelineStage, 'demo');
  assert.notEqual(
    settled.stageEnteredAt,
    placed.stageEnteredAt,
    'the stage write advances the generation token past what it read',
  );
});

test('a lost claim reports whether the stage moved or only the row was touched', async (t) => {
  const { app, actor, opportunity } = await fixture();
  t.after(() => app.close());
  const svc = app.services.opportunities;

  await svc.setStage(opportunity.id, 'proposal', { actor, expectedFromStage: 'qualification' });
  await assert.rejects(
    svc.setStage(opportunity.id, 'lost', { actor, expectedFromStage: 'qualification' }),
    (error) => error?.code === 'CONFLICT'
      && error?.status === 409
      && error?.details?.reason === 'stage_moved',
    'a loser that finds the stage moved reports stage_moved',
  );

  // Same stage, but the lifecycle position moved under the claim (a managed
  // patch carrying stage_entered_at, e.g. a pipeline move racing the stage
  // write): fail closed, but say the stage itself did not move, with a retry
  // hint — the same intent re-pinned still validates.
  const bump = (iso) => new Date(Date.parse(iso) + 1).toISOString();
  const execute = svc.database.storage.sync.execute.bind(svc.database.storage.sync);
  const originalGet = svc.get.bind(svc);
  let reads = 0;
  svc.get = (id) => {
    reads += 1;
    const snapshot = originalGet(id);
    if (reads === 1 && id === opportunity.id) {
      const tokenBase = typeof snapshot.stageEnteredAt === 'string'
        ? snapshot.stageEnteredAt
        : snapshot.updatedAt;
      execute({
        kind: 'update', table: 'opportunities', values: [
          { column: 'pipeline_stage', value: 'demo' },
          { column: 'updated_at', value: bump(snapshot.updatedAt) },
          { column: 'stage_entered_at', value: bump(tokenBase) },
        ], where: [{ column: 'id', op: 'eq', value: opportunity.id }],
      });
    }
    return snapshot;
  };
  try {
    await assert.rejects(
      svc.setStage(opportunity.id, 'lost', { actor, expectedFromStage: 'proposal' }),
      (error) => error?.code === 'CONFLICT'
        && error?.status === 409
        && error?.details?.reason === 'row_touched',
      'a loser that finds the stage unmoved reports row_touched',
    );
  } finally {
    delete svc.get;
  }
  assert.equal(originalGet(opportunity.id).stage, 'proposal');
});
