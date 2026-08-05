import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Opportunity pipelines end to end (Milestone 8): conversion into the default
 * stage, server-authoritative transitions, terminal outcomes, optimistic
 * concurrency, bypass matrix, schema metadata, restart. One throwaway project
 * (starter modules + pipeline + move-stage) for the whole file.
 */

let projectRoot;
let createAgentCrmApp;
let createHttpServer;
let AgentCrmClient;
const actor = { type: 'user', id: 'pipeline-e2e' };

test.before(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agent-crm-pipeline-'));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(projectRoot, entry), { recursive: true });
  }
  const starter = join(projectRoot, 'examples/starters/b2b-lead-qualification');
  for (const manifest of ['lead.module.json', 'task.module.json']) {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', join(projectRoot, 'packages/cli/bin/agent-crm.js'), 'module', 'create', join(starter, manifest), '--apply', '--root', projectRoot],
      { encoding: 'utf8', cwd: projectRoot },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(
    join(projectRoot, 'packages/actions/generated/index.js'),
    [
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      "import { convertLead } from '../../../examples/starters/b2b-lead-qualification/actions/convert.js';",
      "import { buildMoveStageAction } from '../../core/src/pipeline-actions.js';",
      "export const generatedActions = [qualifyLead, convertLead, buildMoveStageAction({ module: 'opportunity' })];",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(projectRoot, 'packages/pipelines/generated/index.js'),
    [
      "import { b2bSalesPipeline } from '../../../examples/starters/b2b-lead-qualification/pipeline.js';",
      'export const generatedPipelines = [b2bSalesPipeline];',
      '',
    ].join('\n'),
  );
  ({ createAgentCrmApp } = await import(pathToFileURL(join(projectRoot, 'packages/app/src/index.js')).href));
  ({ createHttpServer } = await import(pathToFileURL(join(projectRoot, 'apps/server/src/index.js')).href));
  ({ AgentCrmClient } = await import(pathToFileURL(join(projectRoot, 'packages/sdk/src/index.js')).href));
});

test.after(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

async function boot(t, dbPath = ':memory:') {
  const app = createAgentCrmApp({ dbPath });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentCrmClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, actor });
  const close = async () => { await new Promise((resolve) => server.close(resolve)); app.close(); };
  if (t) t.after(close);
  return { app, client, close };
}

/** Capture → qualify → convert; returns the converted opportunity. */
async function convertedOpportunity(app, overrides = {}) {
  const leads = app.modules.get('lead').service;
  const lead = await leads.create({
    firstName: 'Pipe',
    lastName: 'Line',
    email: `pipe-${Math.random().toString(36).slice(2)}@x.example`,
    companyName: overrides.companyName ?? `Co ${Math.random().toString(36).slice(2)}`,
  }, { actor });
  await app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor });
  const converted = await app.runAction({
    module: 'lead', action: 'convert', recordId: lead.id,
    input: { opportunityName: overrides.name ?? 'Pipeline deal', valueCents: overrides.valueCents ?? 100_000, ...(overrides.currency ? { currency: overrides.currency } : {}) },
    actor,
  });
  return app.services.opportunities.get(converted.result.opportunity.id);
}

test('conversion enters the default stage; schema advertises the pipeline; moves flow to won', async (t) => {
  const dbPath = join(projectRoot, 'data', `board-${process.pid}.sqlite`);
  let { app, client, close } = await boot(null, dbPath);

  // Schema metadata: deterministic, ordered, additive.
  const schema = await client.schema();
  assert.equal(schema.pipelineContract, 1);
  assert.equal(schema.pipelines.length, 1);
  const pipeline = schema.pipelines[0];
  assert.equal(pipeline.name, 'b2b-sales');
  assert.equal(pipeline.module, 'opportunity');
  assert.equal(pipeline.defaultStage, 'discovery');
  assert.deepEqual(pipeline.stages.map((stage) => stage.key), ['discovery', 'demo', 'proposal', 'negotiation', 'won', 'lost']);
  assert.deepEqual(pipeline.stages.map((stage) => stage.type), ['open', 'open', 'open', 'open', 'won', 'lost']);
  // Core-module actions are advertised separately from generated modules.
  assert.ok(schema.coreModuleActions.opportunity.some((action) => action.name === 'move-stage'));

  // Conversion → default stage, atomically.
  const opportunity = await convertedOpportunity(app, { name: 'Board deal', valueCents: 5_000_000 });
  assert.equal(opportunity.pipelineKey, 'b2b-sales');
  assert.equal(opportunity.pipelineStage, 'discovery');
  assert.ok(opportunity.stageEnteredAt);
  assert.equal(opportunity.closedAt, null);

  const events = [];
  app.events.subscribe('opportunity.updated', () => events.push('opportunity.updated'));
  const opportunities = client.module('opportunity');

  // Move through three open stages via the generic SDK action surface.
  for (const [from, to] of [['discovery', 'demo'], ['demo', 'proposal'], ['proposal', 'negotiation']]) {
    const moved = await opportunities.action(opportunity.id, 'move-stage', { toStage: to, fromStage: from });
    assert.equal(moved.result.record.pipelineStage, to);
    assert.equal(moved.result.from, from);
  }
  // Exactly one audit + one event per transition.
  assert.equal(events.length, 3);
  const auditActions = app.audit.list({ entityType: 'opportunity', entityId: opportunity.id }).map((a) => a.action);
  assert.equal(auditActions.filter((a) => a === 'opportunity.updated').length, 4, '3 moves + 1 pipeline entry at conversion');

  // Win it: closedAt set, terminal thereafter.
  const won = await opportunities.action(opportunity.id, 'move-stage', { toStage: 'won', fromStage: 'negotiation' });
  assert.ok(won.result.record.closedAt);
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'discovery' }),
    (error) => error.status === 409 && error.code === 'TERMINAL_STAGE',
  );

  // Trace: transitions are inspectable, completed runs carry the span.
  const runs = await client.request('/api/traces?workflowName=opportunity.move-stage&status=completed');
  assert.equal(runs.items.length, 4);

  // Restart: pipeline state persists.
  await close();
  ({ app, client } = await boot(t, dbPath));
  const survived = await client.request(`/api/opportunities`).then((r) => r.items.find((o) => o.id === opportunity.id));
  assert.equal(survived.pipelineStage, 'won');
  assert.ok(survived.closedAt);
});

test('transition rules: stale, same-stage, unknown, lost-reason, wrong pipeline state', async (t) => {
  const { app, client } = await boot(t);
  const opportunity = await convertedOpportunity(app);
  const opportunities = client.module('opportunity');

  // Stale optimistic check.
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'demo', fromStage: 'proposal' }),
    (error) => error.status === 409 && error.code === 'STALE_STAGE',
  );
  // Same-stage move is a visible 409, not a silent no-op.
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'discovery' }),
    (error) => error.status === 409 && error.code === 'SAME_STAGE',
  );
  // Unknown target stage → field-tied 400 naming the allowed keys.
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'sorcery' }),
    (error) => error.status === 400 && error.details?.field === 'toStage',
  );
  // Lost requires a reason; blank is missing.
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'lost' }),
    (error) => error.status === 400 && error.details?.field === 'reason',
  );
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'lost', reason: '   ' }),
    (error) => error.status === 400,
  );
  const lost = await opportunities.action(opportunity.id, 'move-stage', { toStage: 'lost', reason: 'Budget cut' });
  assert.equal(lost.result.record.closeReason, 'Budget cut');
  assert.ok(lost.result.record.closedAt);
  // Lost is terminal too.
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'demo' }),
    (error) => error.code === 'TERMINAL_STAGE',
  );

  // An opportunity with NO pipeline state (created directly, not converted)
  // cannot be moved: stable 409, never an invented stage.
  const company = await app.services.companies.create({ name: 'Direct Co' }, { actor });
  const direct = await app.services.opportunities.create(
    { companyId: company.id, name: 'Direct', valueCents: 1, owner: 'x' }, { actor },
  );
  assert.equal(app.services.opportunities.get(direct.id).pipelineKey, null, 'directly created opportunities carry no pipeline state');
  await assert.rejects(
    () => opportunities.action(direct.id, 'move-stage', { toStage: 'demo' }),
    (error) => error.status === 409 && error.code === 'NO_PIPELINE',
  );

  // Corrupted stage (out-of-band write) refuses safely.
  app.database.raw.prepare("UPDATE opportunities SET pipeline_stage = 'ghost' WHERE id = ?").run(opportunity.id);
  await assert.rejects(
    () => opportunities.action(opportunity.id, 'move-stage', { toStage: 'demo' }),
    (error) => error.status === 409 && error.code === 'PIPELINE_STATE_CORRUPT',
  );
});

test('pipeline fields are server-managed: CRUD and HTTP cannot write them', async (t) => {
  const { app, client } = await boot(t);
  const company = await app.services.companies.create({ name: 'Bypass Co' }, { actor });

  // Service-level create rejects each managed field, alone or mixed.
  for (const patch of [
    { pipelineKey: 'b2b-sales' },
    { pipelineStage: 'won' },
    { stageEnteredAt: '2026-01-01T00:00:00.000Z' },
    { closedAt: '2026-01-01T00:00:00.000Z' },
    { closeReason: 'forged' },
  ]) {
    await assert.rejects(
      () => app.services.opportunities.create({ companyId: company.id, name: 'X', valueCents: 1, owner: 'x', ...patch }, { actor }),
      (error) => error.code === 'VALIDATION_ERROR' && error.details?.field === Object.keys(patch)[0],
      `expected rejection for ${Object.keys(patch)[0]}`,
    );
  }
  // Raw HTTP POST /api/opportunities is the same boundary.
  await assert.rejects(
    () => client.request('/api/opportunities', {
      method: 'POST',
      body: { companyId: company.id, name: 'X', valueCents: 1, owner: 'x', pipelineStage: 'won' },
    }),
    (error) => error.status === 400,
  );
  // The core opportunity module is NOT exposed through generic CRUD records
  // routes (actions only).
  await assert.rejects(() => client.module('opportunity').get('anything'), (error) => error.status === 404);
  await assert.rejects(() => client.module('opportunity').create({ name: 'x' }), (error) => error.status === 404);
  // Unknown action on the core module → 404; unknown module stays 404.
  const opportunity = await convertedOpportunity(app);
  await assert.rejects(() => client.module('opportunity').action(opportunity.id, 'ghost'), (error) => error.status === 404);
  await assert.rejects(() => client.module('ghost').action('x', 'move-stage'), (error) => error.status === 404);
});

test('concurrent conflicting moves: one winner, stable 409 loser, exactly one transition', async (t) => {
  const { app, client } = await boot(t);
  const opportunity = await convertedOpportunity(app);
  const opportunities = client.module('opportunity');
  const events = [];
  app.events.subscribe('opportunity.updated', () => events.push(1));

  const results = await Promise.allSettled([
    opportunities.action(opportunity.id, 'move-stage', { toStage: 'demo', fromStage: 'discovery' }),
    opportunities.action(opportunity.id, 'move-stage', { toStage: 'proposal', fromStage: 'discovery' }),
  ]);
  const winners = results.filter((r) => r.status === 'fulfilled');
  const losers = results.filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one move wins');
  assert.equal(losers[0].reason.status, 409);
  assert.equal(losers[0].reason.code, 'STALE_STAGE');
  const finalStage = app.services.opportunities.get(opportunity.id).pipelineStage;
  assert.ok(['demo', 'proposal'].includes(finalStage), `winner's stage stands (${finalStage})`);
  assert.equal(events.length, 1, 'exactly one transition event');
});

test('two independent connections: winner + retryable 409, no raw SQLite error, restart persists', async (t) => {
  const dbPath = join(projectRoot, 'data', `race-${process.pid}.sqlite`);
  const appA = createAgentCrmApp({ dbPath, busyTimeoutMs: 200 });
  const appB = createAgentCrmApp({ dbPath, busyTimeoutMs: 200 });
  t.after(() => { appA.close(); appB.close(); });
  const opportunity = await convertedOpportunity(appA);

  const move = (app, toStage) => app.runAction({
    module: 'opportunity', action: 'move-stage', recordId: opportunity.id,
    input: { toStage, fromStage: 'discovery' }, actor,
  });
  const results = await Promise.allSettled([move(appA, 'demo'), move(appB, 'proposal')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const loss = results.find((r) => r.status === 'rejected').reason;
  assert.equal(loss.status, 409, `${loss.code}: ${loss.message}`);
  assert.ok(['STALE_STAGE', 'CONFLICT'].includes(loss.code), loss.code);
  assert.ok(!/SQLITE|database is locked/i.test(loss.message) || /busy with a concurrent write/.test(loss.message));

  // A retry with a fresh fromStage read succeeds exactly once more.
  const current = appA.services.opportunities.get(opportunity.id).pipelineStage;
  const retried = await appB.runAction({
    module: 'opportunity', action: 'move-stage', recordId: opportunity.id,
    input: { toStage: 'negotiation', fromStage: current }, actor,
  });
  assert.equal(retried.result.record.pipelineStage, 'negotiation');

  const appC = createAgentCrmApp({ dbPath });
  t.after(() => appC.close());
  assert.equal(appC.services.opportunities.get(opportunity.id).pipelineStage, 'negotiation');
});

test('legacy stage machine and pipeline state coexist without cross-talk', async (t) => {
  const { app, client } = await boot(t);
  // A pipeline opportunity: moving pipeline stage never touches legacy stage.
  const piped = await convertedOpportunity(app);
  const legacyBefore = piped.stage;
  await client.module('opportunity').action(piped.id, 'move-stage', { toStage: 'demo', fromStage: 'discovery' });
  const afterMove = app.services.opportunities.get(piped.id);
  assert.equal(afterMove.stage, legacyBefore, 'legacy stage untouched by pipeline moves');
  assert.equal(afterMove.pipelineStage, 'demo');

  // A legacy (M0) opportunity: the renewal workflow moves the LEGACY stage
  // and never writes pipeline state.
  const seeded = await app.seedDemo();
  const run = await app.workflows.run(
    'request-opportunity-stage-change',
    { opportunityId: seeded.standardRenewal.id, targetStage: 'proposal' },
    { actor },
  );
  assert.equal(run.status, 'completed');
  const legacy = app.services.opportunities.get(seeded.standardRenewal.id);
  assert.equal(legacy.stage, 'proposal', 'legacy workflow still owns the legacy column');
  assert.equal(legacy.pipelineKey, null, 'legacy workflow never writes pipeline state');
  assert.equal(legacy.pipelineStage, null);
  // Legacy stage never places a record on the board or allows a pipeline move.
  await assert.rejects(
    () => client.module('opportunity').action(legacy.id, 'move-stage', { toStage: 'demo' }),
    (error) => error.status === 409 && error.code === 'NO_PIPELINE',
  );
});

test('conversion + pipeline entry are one transaction: entry failure rolls back everything', async (t) => {
  const { app, client } = await boot(t);
  const leads = app.modules.get('lead').service;
  const lead = await leads.create(
    { firstName: 'Roll', lastName: 'Back', email: 'rb@x.example', companyName: 'Rollback Co' }, { actor },
  );
  await app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor });

  const service = app.services.opportunities;
  const realApply = service.applyManaged.bind(service);
  service.applyManaged = () => { throw new Error('injected pipeline-entry failure'); };
  const events = [];
  app.events.subscribe('*', ({ event }) => events.push(event));
  await assert.rejects(
    () => client.module('lead').action(lead.id, 'convert', { opportunityName: 'Doomed', valueCents: 1 }),
    /injected pipeline-entry failure/,
  );
  service.applyManaged = realApply;
  assert.equal(app.services.opportunities.list().length, 0, 'opportunity rolled back with the failed entry');
  assert.equal(app.services.companies.list().length, 0, 'company rolled back');
  assert.equal(leads.get(lead.id).status, 'qualified', 'lead unconverted');
  assert.deepEqual(events, [], 'no events escaped');
  assert.equal(app.audit.list({ entityType: 'opportunity' }).length, 0, 'no partial audit');
});

test('definition drift: renamed/removed stage keys refuse safely; defaults affect only new conversions', async (t) => {
  const { app, client } = await boot(t);
  const opportunity = await convertedOpportunity(app);
  // Simulate a definition rename by corrupting the stored key the way drift
  // would look at runtime (the definition itself is immutable per boot).
  app.database.raw.prepare("UPDATE opportunities SET pipeline_stage = 'renamed-away' WHERE id = ?").run(opportunity.id);
  await assert.rejects(
    () => client.module('opportunity').action(opportunity.id, 'move-stage', { toStage: 'demo' }),
    (error) => error.status === 409 && error.code === 'PIPELINE_STATE_CORRUPT',
    'a record on a stage key outside the definition is never silently remapped',
  );
  assert.equal(app.services.opportunities.get(opportunity.id).pipelineStage, 'renamed-away', 'stored key untouched');

  // A fresh conversion still lands on the CURRENT declared default — drift in
  // old records never changes new-record behavior.
  const fresh = await convertedOpportunity(app, { companyName: 'Fresh Co' });
  assert.equal(fresh.pipelineStage, 'discovery');
});

test('an open-target move clears corrupt terminal fields (coherence enforced)', async (t) => {
  const { app, client } = await boot(t);
  const opportunity = await convertedOpportunity(app);
  // Out-of-band corruption: closedAt on an open-stage record.
  app.database.raw.prepare("UPDATE opportunities SET closed_at = '2026-01-01T00:00:00.000Z', close_reason = 'ghost' WHERE id = ?").run(opportunity.id);
  const moved = await client.module('opportunity').action(opportunity.id, 'move-stage', { toStage: 'demo', fromStage: 'discovery' });
  assert.equal(moved.result.record.pipelineStage, 'demo');
  assert.equal(moved.result.record.closedAt, null, 'open stages never retain terminal-only closedAt');
  assert.equal(moved.result.record.closeReason, null, 'open stages never retain a close reason');
  // A reason supplied on a WON move is deliberately ignored, never stored.
  await client.module('opportunity').action(opportunity.id, 'move-stage', { toStage: 'won', reason: 'should be ignored' });
  const wonRecord = app.services.opportunities.get(opportunity.id);
  assert.equal(wonRecord.closeReason, null, 'won never carries a lost reason');
  assert.ok(wonRecord.closedAt);
});

test('a pipeline targeting a generated module is rejected at startup (no dead pipelines)', async (t) => {
  const altRoot = mkdtempSync(join(tmpdir(), 'agent-crm-deadpipe-'));
  t.after(() => rmSync(altRoot, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(projectRoot, entry), join(altRoot, entry), { recursive: true });
  }
  // The generated task module exists in this project — but it has no pipeline
  // state storage, so a pipeline for it could never hold a record.
  writeFileSync(
    join(altRoot, 'packages/pipelines/generated/index.js'),
    [
      'export const generatedPipelines = [{',
      "  pipelineContract: 1, name: 'task-flow', module: 'task', defaultStage: 'todo',",
      "  stages: [{ key: 'todo', order: 1, type: 'open', probability: 10 }, { key: 'done', order: 2, type: 'won', probability: 100 }],",
      '}];',
      '',
    ].join('\n'),
  );
  const { createAgentCrmApp: createAlt } = await import(pathToFileURL(join(altRoot, 'packages/app/src/index.js')).href);
  assert.throws(
    () => createAlt({ dbPath: ':memory:' }),
    /not staged-eligible|stores pipeline state/,
    'startup fails closed instead of booting a permanently unusable pipeline',
  );
});

test('a pipeline with no terminal stages is legal: moves are open→open only', async (t) => {
  const altRoot = mkdtempSync(join(tmpdir(), 'agent-crm-openonly-'));
  t.after(() => rmSync(altRoot, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(altRoot, entry), { recursive: true });
  }
  writeFileSync(
    join(altRoot, 'packages/actions/generated/index.js'),
    [
      "import { buildMoveStageAction } from '../../core/src/pipeline-actions.js';",
      "export const generatedActions = [buildMoveStageAction({ module: 'opportunity' })];",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(altRoot, 'packages/pipelines/generated/index.js'),
    [
      'export const generatedPipelines = [{',
      "  pipelineContract: 1, name: 'endless', module: 'opportunity', defaultStage: 'a',",
      "  stages: [{ key: 'a', order: 1, type: 'open', probability: 10 }, { key: 'b', order: 2, type: 'open', probability: 50 }],",
      '}];',
      '',
    ].join('\n'),
  );
  const { createAgentCrmApp: createAlt } = await import(pathToFileURL(join(altRoot, 'packages/app/src/index.js')).href);
  const app = createAlt({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Endless Co' }, { actor });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Endless', valueCents: 1, owner: 'x' }, { actor },
  );
  await app.services.opportunities.applyManaged(
    opportunity.id, { pipelineKey: 'endless', pipelineStage: 'a', stageEnteredAt: '2026-08-05T00:00:00.000Z' }, { actor },
  );
  const moved = await app.runAction({
    module: 'opportunity', action: 'move-stage', recordId: opportunity.id, input: { toStage: 'b' }, actor,
  });
  assert.equal(moved.result.record.pipelineStage, 'b');
  assert.equal(moved.result.record.closedAt, null, 'no terminal stage can ever set closedAt');
  // Moving to a nonexistent terminal key is a plain unknown-stage 400.
  await assert.rejects(
    () => app.runAction({ module: 'opportunity', action: 'move-stage', recordId: opportunity.id, input: { toStage: 'won' }, actor }),
    (error) => error.status === 400 && error.details?.field === 'toStage',
  );
});

test('a second pipeline shape proves the contract is not hardcoded to one stage list', async (t) => {
  // A different project with a DIFFERENT pipeline (three stages, other keys)
  // on the same module: same runtime, same action, no code changes.
  const altRoot = mkdtempSync(join(tmpdir(), 'agent-crm-altpipe-'));
  t.after(() => rmSync(altRoot, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(altRoot, entry), { recursive: true });
  }
  writeFileSync(
    join(altRoot, 'packages/actions/generated/index.js'),
    [
      "import { buildMoveStageAction } from '../../core/src/pipeline-actions.js';",
      "export const generatedActions = [buildMoveStageAction({ module: 'opportunity' })];",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(altRoot, 'packages/pipelines/generated/index.js'),
    [
      'export const generatedPipelines = [{',
      '  pipelineContract: 1,',
      "  name: 'quick-close',",
      "  label: 'Quick Close',",
      "  module: 'opportunity',",
      "  defaultStage: 'contact',",
      '  stages: [',
      "    { key: 'contact', label: 'Contact', order: 1, type: 'open', probability: 20 },",
      "    { key: 'handshake', label: 'Handshake', order: 2, type: 'open', probability: 70 },",
      "    { key: 'closed', label: 'Closed', order: 3, type: 'won', probability: 100 },",
      '  ],',
      '}];',
      '',
    ].join('\n'),
  );
  const { createAgentCrmApp: createAlt } = await import(pathToFileURL(join(altRoot, 'packages/app/src/index.js')).href);
  const app = createAlt({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Alt Co' }, { actor });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'Alt deal', valueCents: 42, owner: 'x' }, { actor },
  );
  // No conversion path here: enter the pipeline through the adapter capability
  // the same way convert does, then walk the alternative stages.
  const adapterEnter = await app.runAction({
    module: 'opportunity', action: 'move-stage', recordId: opportunity.id,
    input: { toStage: 'handshake' }, actor,
  }).catch((error) => error);
  assert.equal(adapterEnter.code, 'NO_PIPELINE', 'not on the board until entered');
  await app.services.opportunities.applyManaged(
    opportunity.id,
    { pipelineKey: 'quick-close', pipelineStage: 'contact', stageEnteredAt: '2026-08-05T00:00:00.000Z' },
    { actor },
  );
  const moved = await app.runAction({
    module: 'opportunity', action: 'move-stage', recordId: opportunity.id,
    input: { toStage: 'handshake', fromStage: 'contact' }, actor,
  });
  assert.equal(moved.result.record.pipelineStage, 'handshake');
  const closedResult = await app.runAction({
    module: 'opportunity', action: 'move-stage', recordId: opportunity.id,
    input: { toStage: 'closed' }, actor,
  });
  assert.ok(closedResult.result.record.closedAt, 'alternative won stage closes');
});
