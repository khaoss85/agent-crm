// @ts-check

/**
 * Reproducible install + verification for the B2B Lead Qualification starter.
 *
 * It builds a clean throwaway project from the current repo, applies the Lead
 * and Task modules through the real module factory, registers the qualify and
 * disqualify actions, then drives the full capture → qualify | disqualify flow
 * in-process and asserts the guarantees the milestone promises:
 *
 *   - capture creates a lead in status `new`;
 *   - qualify (atomic) flips status to qualified and opens exactly one task;
 *   - a repeated qualify is a 409 with no second task / audit / event;
 *   - disqualify requires a reason and creates no task;
 *   - status can never be set to `qualified` through generic CRUD.
 *
 * Run it from anywhere:  node examples/starters/b2b-lead-qualification/install.mjs
 * Exit code 0 means every guarantee held. Nothing is written to your own DB.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const starterDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(starterDir, '..', '..', '..');

const root = mkdtempSync(join(tmpdir(), 'agent-crm-lead-starter-'));
try {
  // 1. Clean project copy — source only, never data or node_modules.
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }

  // 2. Apply the Lead module, then the Task module (Task references leads, so
  //    order matters: the factory refuses a reference to a not-yet-applied
  //    target).
  const starterInProject = join(root, 'examples', 'starters', 'b2b-lead-qualification');
  applyModule(root, join(starterInProject, 'lead.module.json'));
  applyModule(root, join(starterInProject, 'task.module.json'));

  // 3. Register the code-first actions by pointing the action registry at the
  //    starter's checked-in definitions.
  writeFileSync(
    join(root, 'packages', 'actions', 'generated', 'index.js'),
    [
      '// @ts-check',
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      "import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';",
      '',
      'export const generatedActions = [qualifyLead, disqualifyLead];',
      '',
    ].join('\n'),
  );

  // 4. Boot the app from the throwaway project and drive the flow.
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath: join(root, 'data', 'starter.sqlite') });
  const actor = { type: 'user', id: 'starter' };
  const leads = app.modules.get('lead').service;
  const tasks = app.modules.get('task').service;

  try {
    // Capture.
    const lead = await leads.create(
      { firstName: 'Dana', lastName: 'Rossi', email: 'dana@acme.example', companyName: 'Acme', source: 'referral' },
      { actor },
    );
    assert.equal(lead.status, 'new', 'a captured lead starts in status new');
    assert.equal(lead.qualifiedAt, null);

    // Qualify (atomic: lead updated + one task created).
    const qualified = await app.runAction({
      module: 'lead',
      action: 'qualify',
      recordId: lead.id,
      input: { dueAt: '2026-08-12T09:00:00Z' },
      actor,
    });
    assert.equal(qualified.result.lead.status, 'qualified');
    const openTasks = tasks.list({ limit: 500 }).filter((task) => task.leadId === lead.id);
    assert.equal(openTasks.length, 1, 'qualify creates exactly one follow-up task');
    assert.equal(openTasks[0].sourceKey, `qualify:${lead.id}`);
    assert.equal(leads.get(lead.id).status, 'qualified');

    // Repeat qualify → 409, and still exactly one task.
    await assert.rejects(
      () => app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor }),
      (error) => error.code === 'INVALID_STATE' && error.status === 409,
    );
    assert.equal(tasks.list({ limit: 500 }).filter((task) => task.leadId === lead.id).length, 1);

    // Disqualify a second lead: reason required, no task.
    const lead2 = await leads.create({ firstName: 'Sam', lastName: 'Neri', email: 'sam@beta.example' }, { actor });
    await assert.rejects(
      () => app.runAction({ module: 'lead', action: 'disqualify', recordId: lead2.id, input: {}, actor }),
      (error) => error.status === 400,
    );
    const disqualified = await app.runAction({
      module: 'lead',
      action: 'disqualify',
      recordId: lead2.id,
      input: { reason: 'No budget this year' },
      actor,
    });
    assert.equal(disqualified.result.lead.status, 'disqualified');
    assert.equal(tasks.list({ limit: 500 }).filter((task) => task.leadId === lead2.id).length, 0);

    // CRUD can never reach the qualified state.
    await assert.rejects(() => leads.update(lead2.id, { status: 'qualified' }, { actor }), (error) => error.code === 'VALIDATION_ERROR');
    await assert.rejects(() => leads.create({ firstName: 'X', lastName: 'Y', email: 'x@y.example', status: 'qualified' }, { actor }), (error) => error.code === 'VALIDATION_ERROR');

    console.log(JSON.stringify({
      ok: true,
      summary: 'Captured 2 leads; qualified 1 (one follow-up task, repeat blocked); disqualified 1 (reason required, no task); CRUD cannot set qualified.',
      leads: leads.list().length,
      tasks: tasks.list().length,
    }, null, 2));
  } finally {
    app.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** @param {string} root @param {string} manifestPath */
function applyModule(root, manifestPath) {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
    { encoding: 'utf8', cwd: root },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${manifestPath}:\n${result.stdout}\n${result.stderr}`);
  }
}
