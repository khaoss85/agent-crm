import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Transaction, event-buffer, concurrency and failure-mode semantics of the
 * action runtime, driven through a real generated project. One throwaway
 * project is built for the whole file; each test boots its own app/database.
 */

let projectRoot;
let createAgentCrmApp;
const actor = { type: 'user', id: 'semantics' };

test.before(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agent-crm-semantics-'));
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
  // The starter's two actions, plus a second, non-Lead action that proves the
  // registry/runtime/HTTP path is generic: task.complete uses a different
  // module, no input, and only PUBLIC service methods (no managed fields).
  writeFileSync(
    join(projectRoot, 'packages/actions/generated/index.js'),
    [
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      "import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';",
      'export const completeTask = {',
      "  module: 'task',",
      "  name: 'complete',",
      "  label: 'Complete task',",
      '  actionContract: 1,',
      "  stateField: 'status',",
      "  fromStates: ['open'],",
      '  async execute({ record, actor, modules }) {',
      "    return modules.get('task').service.update(record.id, { status: 'done' }, { actor });",
      '  },',
      '};',
      'export const generatedActions = [qualifyLead, disqualifyLead, completeTask];',
      '',
    ].join('\n'),
  );
  ({ createAgentCrmApp } = await import(pathToFileURL(join(projectRoot, 'packages/app/src/index.js')).href));
});

test.after(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

async function capture(app) {
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Sem', lastName: 'Antics', email: `sem-${Math.random().toString(36).slice(2)}@x.example` },
    { actor },
  );
  return lead;
}

test('a post-commit subscriber failure is NOT a business failure: success + failed dispatch span', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const lead = await capture(app);
  const delivered = [];
  app.events.subscribe('lead.updated', () => delivered.push('lead.updated'));
  app.events.subscribe('task.created', () => { throw new Error('subscriber exploded'); });

  const result = await app.runAction({
    module: 'lead', action: 'qualify', recordId: lead.id,
    input: { dueAt: '2026-08-12T09:00:00Z' }, actor,
  });

  // The action is a success: the caller must never be told to retry/compensate
  // a committed write because a subscriber failed.
  assert.equal(result.ok, true);
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'qualified');
  assert.equal(app.modules.get('task').service.list().length, 1);
  // Events before the failing one were delivered; the failure is observable in
  // the trace as a failed events.dispatch span on a COMPLETED run.
  assert.deepEqual(delivered, ['lead.updated']);
  const run = app.database.raw.prepare("SELECT id, status FROM workflow_runs WHERE workflow_name = 'lead.qualify'").get();
  assert.equal(run.status, 'completed');
  const spans = app.database.raw.prepare('SELECT name, status, error FROM trace_spans WHERE run_id = ?').all(run.id);
  const dispatchSpan = spans.find((span) => span.name === 'events.dispatch');
  assert.ok(dispatchSpan, 'the dispatch failure is recorded as a span');
  assert.equal(dispatchSpan.status, 'failed');
  assert.match(dispatchSpan.error, /subscriber exploded/);
  // The bus still works afterwards (no stuck buffer): a plain emit dispatches.
  let after = false;
  app.events.subscribe('probe', () => { after = true; });
  await app.events.emit('probe', {});
  assert.equal(after, true);
});

test('two independent connections, concurrent qualify: one success, one clean 409, one task', async (t) => {
  const dbPath = join(projectRoot, 'data', `race-${process.pid}.sqlite`);
  // Short busy timeout: with synchronous SQLite on one JS thread, the loser
  // holds the thread while waiting, so a small timeout keeps the test fast.
  const appA = createAgentCrmApp({ dbPath, busyTimeoutMs: 200 });
  const appB = createAgentCrmApp({ dbPath, busyTimeoutMs: 200 });
  t.after(() => { appA.close(); appB.close(); });
  const lead = await capture(appA);

  const results = await Promise.allSettled([
    appA.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor }),
    appB.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor }),
  ]);
  const winners = results.filter((r) => r.status === 'fulfilled');
  const losers = results.filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one qualify succeeds');
  assert.equal(losers.length, 1, 'exactly one qualify fails');
  // The loser gets a STABLE 409 — either the state guard (it re-read after the
  // winner committed) or the busy-writer conflict — never a raw SQLITE_BUSY.
  const loss = losers[0].reason;
  assert.equal(loss.status, 409, `loser status: ${loss.status} (${loss.code}: ${loss.message})`);
  assert.ok(['INVALID_STATE', 'CONFLICT'].includes(loss.code), loss.code);
  assert.ok(!/SQLITE|database is locked/i.test(loss.message) || /busy with a concurrent write/.test(loss.message));

  // Exactly one transition, one task, one set of success audits.
  assert.equal(appA.modules.get('lead').service.get(lead.id).status, 'qualified');
  const tasks = appA.modules.get('task').service.list().filter((task) => task.leadId === lead.id);
  assert.equal(tasks.length, 1);
  const leadAudits = appA.audit.list({ entityType: 'lead', entityId: lead.id }).map((a) => a.action);
  assert.deepEqual(leadAudits.sort(), ['lead.created', 'lead.updated']);
  assert.equal(appA.audit.list({ entityType: 'task' }).length, 1);

  // A retry after the winner does not duplicate anything.
  await assert.rejects(
    () => appB.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );
  assert.equal(appA.modules.get('task').service.list().filter((task) => task.leadId === lead.id).length, 1);

  // Restart (fresh connection): one task persisted.
  const appC = createAgentCrmApp({ dbPath });
  t.after(() => appC.close());
  assert.equal(appC.modules.get('task').service.list().filter((task) => task.leadId === lead.id).length, 1);
});

test('COMMIT failure is a business failure: no partial state, no events, failed trace', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const lead = await capture(app);
  const events = [];
  app.events.subscribe('*', ({ event }) => events.push(event));

  // Inject a failure at the outer COMMIT — after every business write worked.
  const realExec = app.database.raw.exec.bind(app.database.raw);
  let armed = true;
  app.database.raw.exec = (sql) => {
    if (armed && /^COMMIT;$/.test(sql)) {
      armed = false;
      throw new Error('injected commit failure');
    }
    return realExec(sql);
  };
  t.after(() => { app.database.raw.exec = realExec; });

  await assert.rejects(
    () => app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor }),
    /injected commit failure/,
  );
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'new', 'status rolled back');
  assert.equal(app.modules.get('task').service.list().length, 0, 'no task committed');
  assert.deepEqual(events, [], 'no events escaped');
  assert.equal(app.audit.list({ entityType: 'lead', entityId: lead.id }).map((a) => a.action).filter((a) => a === 'lead.updated').length, 0);
  const run = app.database.raw.prepare("SELECT status FROM workflow_runs WHERE workflow_name = 'lead.qualify'").get();
  assert.equal(run.status, 'failed', 'the failed run still recorded a trace');
});

test('corrupted historical state fails safely: actions reject, nothing compounds', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const lead = await capture(app);
  // Corrupt the row behind the service's back (enum CHECK still allows it —
  // simulate a state written by an older, different lifecycle).
  app.database.raw.prepare("UPDATE leads SET status = 'qualified', qualified_at = NULL WHERE id = ?").run(lead.id);

  const auditBefore = app.audit.list({ entityType: 'lead' }).length;
  await assert.rejects(
    () => app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );
  await assert.rejects(
    () => app.runAction({ module: 'lead', action: 'disqualify', recordId: lead.id, input: { reason: 'nope' }, actor }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );
  assert.equal(app.audit.list({ entityType: 'lead' }).length, auditBefore, 'no audit from rejected actions');
  assert.equal(app.modules.get('task').service.list().length, 0);
});

test('an action invoking another action fails closed with a clear error', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const lead = await capture(app);
  // Force nesting through the runtime itself: an execute that calls runAction.
  app.actions.register({
    module: 'lead',
    name: 'nest',
    actionContract: 1,
    async execute({ record }) {
      return app.runAction({ module: 'lead', action: 'qualify', recordId: record.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor });
    },
  });
  await assert.rejects(
    () => app.runAction({ module: 'lead', action: 'nest', recordId: lead.id, input: {}, actor }),
    (error) => /Nested buffered event scopes are not supported/.test(error.message),
  );
  // Everything rolled back; the lead is untouched and still qualifiable.
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'new');
  assert.equal(app.modules.get('task').service.list().length, 0);
  const after = await app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor });
  assert.equal(after.ok, true);
});

test('the action framework is generic: a non-Lead, no-input action runs through the same path', async (t) => {
  const { createHttpServer } = await import(pathToFileURL(join(projectRoot, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(projectRoot, 'packages/sdk/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); app.close(); });
  const client = new AgentCrmClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, actor });

  const lead = await client.module('lead').create({ firstName: 'G', lastName: 'F', email: 'gf@x.example' });
  await client.module('lead').action(lead.id, 'qualify', { dueAt: '2026-08-12T09:00:00Z' });
  const task = (await client.module('task').list()).items[0];
  assert.equal(task.status, 'open');

  // Schema advertises the task action; the SDK runs it with no input.
  const schema = await client.schema();
  const taskMeta = schema.generatedModules.find((m) => m.name === 'task');
  assert.deepEqual(taskMeta.actions.map((a) => a.name), ['complete']);
  const done = await client.module('task').action(task.id, 'complete');
  assert.equal(done.ok, true);
  assert.equal((await client.module('task').get(task.id)).status, 'done');
  // fromStates is enforced for the second fixture too.
  await assert.rejects(
    () => client.module('task').action(task.id, 'complete'),
    (error) => error.status === 409 && error.code === 'INVALID_STATE',
  );
});
