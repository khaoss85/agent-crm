import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Build a clean throwaway project, apply the Lead then Task modules through the
 * real CLI/factory, and register the starter's qualify/disqualify actions.
 */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-lead-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  assert.equal(cli(root, ['module', 'create', join(starter, 'lead.module.json'), '--apply']).status, 0, 'apply lead');
  assert.equal(cli(root, ['module', 'create', join(starter, 'task.module.json'), '--apply']).status, 0, 'apply task');
  writeFileSync(
    join(root, 'packages/actions/generated/index.js'),
    [
      '// @ts-check',
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      "import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';",
      'export const generatedActions = [qualifyLead, disqualifyLead];',
      '',
    ].join('\n'),
  );
  return root;
}

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), ...args, '--root', root], {
    encoding: 'utf8',
    cwd: root,
  });
}

test('lead qualification end to end: qualify, disqualify, atomicity, idempotency, CRUD-bypass, restart', async (t) => {
  const root = project(t);

  // The generated Lead service enforces the managed-field policy in code, not
  // just in the Admin: managed fields are refused by create/update and only
  // reachable through applyManaged.
  const leadService = readFileSync(join(root, 'packages/modules/lead/src/lead-service.js'), 'utf8');
  assert.match(leadService, /#rejectManagedInput/);
  assert.match(leadService, /async applyManaged\(/);
  assert.match(leadService, /is managed by a workflow action and cannot be set directly/);

  const dbPath = join(root, 'data', 'lead.sqlite');
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);

  async function boot() {
    const app = createAgentCrmApp({ dbPath });
    const server = createHttpServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = new AgentCrmClient({ baseUrl, actor: { type: 'user', id: 'e2e' } });
    return { app, client, close: () => new Promise((r) => server.close(r)).then(() => app.close()) };
  }

  let instance = await boot();
  let app = instance.app;
  const client = instance.client;
  const leads = client.module('lead');
  const tasks = client.module('task');

  // Schema advertises the actions and the managed-field write policy.
  const schema = await client.schema();
  const leadMeta = schema.generatedModules.find((m) => m.name === 'lead');
  assert.equal(schema.generatedResourceContract, 1);
  assert.deepEqual(leadMeta.actions.map((a) => a.name).sort(), ['disqualify', 'qualify']);
  const qualifyMeta = leadMeta.actions.find((a) => a.name === 'qualify');
  assert.deepEqual(qualifyMeta.fromStates, ['new']);
  assert.equal(qualifyMeta.stateField, 'status');
  assert.deepEqual(qualifyMeta.input, [{ name: 'dueAt', type: 'timestamp', required: true }]);
  assert.equal(leadMeta.fields.find((f) => f.name === 'status').writable, 'managed');
  assert.equal(leadMeta.fields.find((f) => f.name === 'firstName').writable, 'public');

  // Events become visible only after commit; count dispatches to prove it.
  const events = [];
  for (const name of ['lead.updated', 'task.created']) app.events.subscribe(name, () => events.push(name));

  // Capture.
  const lead = await leads.create({ firstName: 'Dana', lastName: 'Rossi', email: 'dana@acme.example', source: 'referral' });
  assert.equal(lead.status, 'new');
  assert.equal(lead.qualifiedAt, null);

  // Qualify: atomic status change + exactly one task.
  const qualified = await leads.action(lead.id, 'qualify', { dueAt: '2026-08-12T09:00:00Z' });
  assert.equal(qualified.ok, true);
  assert.equal(qualified.result.lead.status, 'qualified');
  assert.ok(qualified.runId, 'a workflow run id is returned');
  const fresh = await leads.get(lead.id);
  assert.equal(fresh.status, 'qualified');
  assert.ok(fresh.qualifiedAt);
  assert.equal(fresh.disqualificationReason, null);
  const leadTasks = (await tasks.list()).items.filter((task) => task.leadId === lead.id);
  assert.equal(leadTasks.length, 1);
  assert.equal(leadTasks[0].sourceKey, `qualify:${lead.id}`);
  assert.equal(leadTasks[0].status, 'open');
  assert.deepEqual(events, ['lead.updated', 'task.created'], 'both events dispatched, after the commit');

  // The action wrote a workflow trace.
  const traces = await client.request('/api/traces?workflowName=lead.qualify');
  assert.equal(traces.items.length, 1);
  assert.equal(traces.items[0].status, 'completed');

  // Repeat qualify → 409 INVALID_STATE, no second task, no extra events.
  events.length = 0;
  await assert.rejects(
    () => leads.action(lead.id, 'qualify', { dueAt: '2026-09-01T09:00:00Z' }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );
  assert.equal((await tasks.list()).items.filter((task) => task.leadId === lead.id).length, 1);
  assert.deepEqual(events, [], 'a rejected action dispatches no events');

  // Bad input → 400 before any state change.
  await assert.rejects(() => leads.action(lead.id, 'qualify', {}), (error) => error.status === 400);
  // Unknown action → 404.
  await assert.rejects(() => leads.action(lead.id, 'ghost', {}), (error) => error.status === 404);

  // Atomicity: force the task insert to fail (duplicate sourceKey) on a fresh
  // lead and prove the status change rolls back with it.
  const atomicLead = await leads.create({ firstName: 'Rollback', lastName: 'Test', email: 'rollback@acme.example' });
  await tasks.create({ title: 'squat', leadId: atomicLead.id, sourceKey: `qualify:${atomicLead.id}` });
  events.length = 0;
  const auditBefore = app.audit.list({ entityType: 'lead' }).length;
  const failedBefore = (await client.request('/api/traces?workflowName=lead.qualify&status=failed')).items.length;
  await assert.rejects(
    () => leads.action(atomicLead.id, 'qualify', { dueAt: '2026-08-20T09:00:00Z' }),
    (error) => error.status === 409,
  );
  const afterFailure = await leads.get(atomicLead.id);
  assert.equal(afterFailure.status, 'new', 'lead status rolled back after the task insert failed');
  assert.equal(afterFailure.qualifiedAt, null);
  assert.equal((await tasks.list()).items.filter((task) => task.leadId === atomicLead.id).length, 1, 'no second task committed');
  assert.deepEqual(events, [], 'no events leak from a rolled-back action');
  assert.equal(app.audit.list({ entityType: 'lead' }).length, auditBefore, 'no lead audit from a rolled-back action');
  // But a failed action still records a trace — written outside the business
  // transaction, so the rollback does not take the trace with it.
  const failedAfter = (await client.request('/api/traces?workflowName=lead.qualify&status=failed')).items.length;
  assert.equal(failedAfter, failedBefore + 1, 'the rolled-back action still recorded exactly one failed trace');

  // Disqualify: reason required, no task.
  const lead2 = await leads.create({ firstName: 'Sam', lastName: 'Neri', email: 'sam@beta.example' });
  await assert.rejects(() => leads.action(lead2.id, 'disqualify', {}), (error) => error.status === 400);
  await assert.rejects(() => leads.action(lead2.id, 'disqualify', { reason: '   ' }), (error) => error.status === 400);
  const disq = await leads.action(lead2.id, 'disqualify', { reason: 'No budget this year' });
  assert.equal(disq.result.lead.status, 'disqualified');
  const fresh2 = await leads.get(lead2.id);
  assert.equal(fresh2.disqualificationReason, 'No budget this year');
  assert.equal(fresh2.qualifiedAt, null);
  assert.equal((await tasks.list()).items.filter((task) => task.leadId === lead2.id).length, 0);
  // Disqualify is only valid from `new`.
  await assert.rejects(() => leads.action(lead2.id, 'disqualify', { reason: 'again' }), (error) => error.status === 409);

  // CRUD can never reach a managed state.
  await assert.rejects(() => leads.update(lead2.id, { status: 'qualified' }), (error) => error.status === 400 && error.code === 'VALIDATION_ERROR');
  await assert.rejects(
    () => leads.create({ firstName: 'X', lastName: 'Y', email: 'x@y.example', status: 'qualified' }),
    (error) => error.status === 400,
  );

  await instance.close();

  // Restart: the qualified lead and its task persist.
  instance = await boot();
  t.after(() => instance.close());
  const survived = await instance.client.module('lead').get(lead.id);
  assert.equal(survived.status, 'qualified');
  assert.equal((await instance.client.module('task').list()).items.filter((task) => task.leadId === lead.id).length, 1);
});

test('concurrent qualify: exactly one success, one 409, exactly one task', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'concurrent.sqlite');
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);

  const app = createAgentCrmApp({ dbPath });
  const server = createHttpServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)).then(() => app.close()));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AgentCrmClient({ baseUrl, actor: { type: 'user', id: 'race' } });
  const leads = client.module('lead');

  const lead = await leads.create({ firstName: 'Race', lastName: 'Condition', email: 'race@acme.example' });

  const results = await Promise.allSettled([
    leads.action(lead.id, 'qualify', { dueAt: '2026-08-12T09:00:00Z' }),
    leads.action(lead.id, 'qualify', { dueAt: '2026-08-12T09:00:00Z' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one qualify succeeds');
  assert.equal(rejected.length, 1, 'exactly one qualify fails');
  assert.equal(rejected[0].reason.status, 409, 'the loser is a 409');
  const leadTasks = (await client.module('task').list()).items.filter((task) => task.leadId === lead.id);
  assert.equal(leadTasks.length, 1, 'exactly one follow-up task exists');
});
