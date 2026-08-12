import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * "The work package is optional" is a claim that has to be paid for.
 *
 * **Each phase runs in its own process.** Rewriting the composition file and
 * re-booting in-process proves nothing: Node caches a module by URL, so the
 * second boot silently reuses the first composition. That artifact is exactly
 * the one that would let this file pass while proving the opposite of what it
 * says. A composition change is a restart, and it is a restart here.
 *
 * What each phase must show:
 *
 *   1. **attached** — the package registers, the actions exist, a follow-up is
 *      created and the schema publishes it;
 *   2. **detached** — the application boots, the surface is gone, and **every
 *      row is still there**. A customer who removed a package did not ask
 *      anybody to delete their data, and the framework never drops a table;
 *   3. **reattached** — the surface comes back and the same rows are still the
 *      same rows;
 *   4. **absent from the start** — a project that never had the package boots
 *      identically and has no work surface at all.
 */

const COMPOSITION = 'packages/domains/generated/index.js';

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

function compose(root, withWork) {
  writeFileSync(join(root, COMPOSITION), withWork ? [
    '// @ts-check',
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n') : ['// @ts-check', 'export const generatedDomains = [];', ''].join('\n'));
}

/** Run one phase in a fresh process and return whatever it reported. */
function phase(root, dbPath, body, tag) {
  const script = join(root, `phase-${tag}.mjs`);
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    'const actor = { type: "user", id: "absence" };',
    'const out = {};',
    'try {',
    body,
    '} finally { app.close(); }',
    'console.log("__RESULT__" + JSON.stringify(out));',
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `phase ${tag} produced no result (exit ${run.status}):\nSTDOUT: ${run.stdout}\nSTDERR: ${run.stderr}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

function project(t, { withWorkTables = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-work-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  assert.equal(cli(root, ['module', 'create', join(starter, 'lead.module.json'), '--apply']).status, 0, 'lead');
  if (withWorkTables) {
    for (const manifest of ['work-task.module.json', 'work-activity.module.json']) {
      assert.equal(cli(root, ['module', 'create', join(root, 'packages/work/modules', manifest), '--apply']).status, 0, manifest);
    }
    writeFileSync(join(root, 'packages/actions/generated/index.js'), [
      '// @ts-check',
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      'export const generatedActions = [qualifyLead];',
      '',
    ].join('\n'));
  } else {
    writeFileSync(join(root, 'packages/actions/generated/index.js'),
      ['// @ts-check', 'export const generatedActions = [];', ''].join('\n'));
  }
  return root;
}

const SEED = `
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Detach', lastName: 'Me', email: 'detach@x.example' }, { actor });
  await app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-08-12T09:00:00Z' }, actor });
  out.leadId = lead.id;
  out.tasks = app.modules.get('work-task').service.list().length;
  out.activities = app.modules.get('work-activity').service.list().length;
  out.actions = app.actions.listForModule('work-task').map((a) => a.name).sort();
  out.hasWork = app.domains.has('work');
  out.rows = app.database.raw.prepare('SELECT id, source_key, status FROM work_tasks ORDER BY id').all();
`;

const READ_ONLY = `
  out.hasWork = app.domains.has('work');
  out.taskModule = app.modules.has ? app.modules.has('work-task') : Boolean(app.modules.get('work-task'));
  out.rows = app.database.raw.prepare('SELECT id, source_key, status FROM work_tasks ORDER BY id').all();
  out.activityRows = app.database.raw.prepare('SELECT id, kind FROM work_activities ORDER BY id').all();
  out.workActions = app.actions.listForModule('work-task').map((a) => a.name).sort();
`;

test('attach, detach and reattach: the surface goes and comes back, the rows never move', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'detach.sqlite');

  // 1. attached
  compose(root, true);
  const attached = phase(root, dbPath, SEED, 'attached');
  assert.equal(attached.hasWork, true);
  assert.equal(attached.tasks, 1);
  assert.equal(attached.activities, 1);
  assert.deepEqual(attached.actions, ['add-note', 'cancel', 'complete']);
  assert.equal(attached.rows.length, 1);

  // 2. detached — a fresh process against a composition that no longer names it
  compose(root, false);
  const detached = phase(root, dbPath, READ_ONLY, 'detached');
  assert.equal(detached.hasWork, false, 'the package is gone');
  assert.deepEqual(detached.workActions, [], 'and so are its actions');
  // The rows are exactly the rows. The framework never drops a table behind you.
  assert.deepEqual(detached.rows, attached.rows, 'detaching a package does not delete anybody\'s data');
  assert.equal(detached.activityRows.length, 1);

  // 3. reattached
  compose(root, true);
  const reattached = phase(root, dbPath, READ_ONLY, 'reattached');
  assert.equal(reattached.hasWork, true);
  assert.deepEqual(reattached.workActions, ['add-note', 'cancel', 'complete']);
  assert.deepEqual(reattached.rows, attached.rows, 'the same rows are still the same rows');
});

test('an application that never had the package boots identically and has no work surface', async (t) => {
  const root = project(t, { withWorkTables: false });
  compose(root, false);
  const out = phase(root, join(root, 'data', 'never.sqlite'), `
    out.hasWork = app.domains.has('work');
    out.tables = app.database.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row) => row.name).filter((name) => name === 'work_tasks' || name === 'work_activities');
    const lead = await app.modules.get('lead').service.create(
      { firstName: 'No', lastName: 'Work', email: 'nowork@x.example' }, { actor });
    out.leadStatus = lead.status;
    out.schemaHasWork = Boolean(app.domains.size > 0);
  `, 'never');
  assert.equal(out.hasWork, false);
  assert.deepEqual(out.tables, [], 'no work table exists at all');
  assert.equal(out.leadStatus, 'new', 'the rest of the CRM is unaffected');
  assert.equal(out.schemaHasWork, false);
});

test('a consumer that declares followUp without the work package is refused at startup, edge named', async (t) => {
  const root = project(t, { withWorkTables: false });
  // Lifecycle opting in, with no `work` in the composition. The registry must
  // refuse the whole application at boot — never at runtime, inside somebody's
  // transaction.
  writeFileSync(join(root, COMPOSITION), [
    '// @ts-check',
    "import { createLifecyclePackage } from '../../lifecycle/src/index.js';",
    "import { createContractsDomain } from '../../contracts/src/index.js';",
    'export const generatedDomains = [createContractsDomain({ policies: [] }), createLifecyclePackage({ followUp: true })];',
    '',
  ].join('\n'));
  const script = join(root, 'boot-unmet.mjs');
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    'try {',
    "  const app = createAccordoApp({ dbPath: ':memory:' });",
    '  app.close();',
    '  console.log("__RESULT__" + JSON.stringify({ booted: true }));',
    '} catch (error) {',
    '  console.log("__RESULT__" + JSON.stringify({ booted: false, message: String(error.message), code: error.code ?? null }));',
    '}',
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `no result: ${run.stdout}\n${run.stderr}`);
  const out = JSON.parse(line.slice('__RESULT__'.length));
  assert.equal(out.booted, false, 'an unmet declared dependency must stop the application');
  // The refusal names the package the declaration pointed at, at startup,
  // rather than a missing method inside somebody's transaction later.
  assert.match(out.message, /lifecycle/, 'the refusal names the consumer');
  assert.match(out.message, /work/, 'and the unmet provider');
});

// ---------------------------------------------------------------------------
// REVIEW-70 — the host path has no startup check, so its runtime refusal must
// be the one the package promises
// ---------------------------------------------------------------------------

test('the host Lead path without the work records names the edge instead of a bare 404', async (t) => {
  const { mkdtempSync, cpSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  const root = mkdtempSync(join(tmpdir(), 'accordo-work-hostless-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const applied = spawnSync(process.execPath, [
    '--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create',
    join(root, 'examples/starters/b2b-lead-qualification/lead.module.json'), '--apply', '--root', root,
  ], { encoding: 'utf8', cwd: root });
  assert.equal(applied.status, 0, applied.stderr);
  // The host consumer, with NEITHER work record applied and no work package.
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
    'export const generatedActions = [qualifyLead];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), 'export const generatedDomains = [];\n');

  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', 'hostless.sqlite') });
  t.after(() => app.close());
  const actor = { type: 'user', id: 'absence' };
  const lead = await app.modules.get('lead').service.create(
    { firstName: 'No', lastName: 'Work', email: 'no@work.example' }, { actor },
  );

  // `ModuleRegistry.get` THROWS for an unregistered name, so reading it
  // optionally let a bare `404 Module not found: work-task` escape instead of
  // the sentence naming what to run. The host path is the one consumer the
  // registry cannot refuse at startup, so this runtime refusal is all it gets.
  await assert.rejects(
    () => app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor }),
    (error) => {
      assert.equal(error.code, 'WORK_STORAGE_INVALID');
      assert.match(error.message, /crm module create/);
      return true;
    },
  );
  // And the whole action rolled back: the lead was never left half-qualified.
  assert.equal(app.modules.get('lead').service.get(lead.id).status, 'new');
});
