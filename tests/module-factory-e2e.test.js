import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function createProjectCopy(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  return root;
}

function runCli(root, args) {
  return spawnSync(
    process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root },
  );
}

test('end-to-end: manifest → plan → apply → runnable Partner module', async (t) => {
  const root = createProjectCopy(t);
  const manifest = join(root, 'examples/modules/partner.module.json');

  // 1. Validate.
  const validate = runCli(root, ['module', 'validate', manifest]);
  assert.equal(validate.status, 0, validate.stderr);

  // 2. Deterministic plan: two runs report identical file hashes.
  const planA = runCli(root, ['module', 'plan', manifest]);
  const planB = runCli(root, ['module', 'plan', manifest, '--json']);
  assert.equal(planA.status, 0, planA.stderr);
  const filesA = JSON.parse(planA.stdout).files.map((f) => [f.path, f.contentSha256]);
  const filesB = JSON.parse(planB.stdout).files.map((f) => [f.path, f.contentSha256]);
  assert.deepEqual(filesA, filesB);

  // 3. Dry-run create equals the plan and writes nothing.
  const dryRun = runCli(root, ['module', 'create', manifest]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunOutput = JSON.parse(dryRun.stdout);
  assert.equal(dryRunOutput.mode, 'dry-run');
  assert.deepEqual(dryRunOutput.files.map((f) => [f.path, f.contentSha256]), filesA);
  assert.equal(existsSync(join(root, 'packages/modules/partner')), false);

  // 4. Explicit apply writes the module; re-apply is refused.
  const apply = runCli(root, ['module', 'create', manifest, '--apply']);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).mode, 'applied');
  const reapply = runCli(root, ['module', 'create', manifest, '--apply']);
  assert.equal(reapply.status, 1);
  assert.match(reapply.stderr, /refusing to overwrite/i);

  // 5-11. Boot the temp copy's app: migration, registration, CRUD, audit, events.
  const { createAgentCrmApp } = await import(
    pathToFileURL(join(root, 'packages/app/src/index.js')).href
  );
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());

  assert.ok(app.modules.list().some((module) => module.name === 'partner'), 'partner not registered');
  const domainEvents = [];
  app.events.subscribe('partner.created', () => domainEvents.push('partner.created'));
  app.events.subscribe('partner.updated', () => domainEvents.push('partner.updated'));

  const actor = { type: 'human', id: 'e2e' };
  const service = app.modules.get('partner').service;
  const created = await service.create({ name: 'Acme Partners', tier: 'gold' }, { actor });
  assert.equal(service.get(created.id).tier, 'gold');
  assert.equal(service.list().length, 1);
  const updated = await service.update(created.id, { tier: 'platinum', territory: 'EMEA' }, { actor });
  assert.equal(updated.tier, 'platinum');
  assert.equal(updated.territory, 'EMEA');

  assert.deepEqual(domainEvents, ['partner.created', 'partner.updated']);
  const auditActions = app.audit.list({ entityType: 'partner' }).map((event) => event.action).sort();
  assert.deepEqual(auditActions, ['partner.created', 'partner.updated']);

  // Manifest-derived validation holds at runtime.
  await assert.rejects(() => service.create({ name: 'X', tier: 'diamond' }, { actor }), /tier/);
  await assert.rejects(() => service.create({}, { actor }), /name/);

  // 12. The generated test passes inside the temp project.
  const generatedTest = spawnSync(
    process.execPath,
    ['--no-warnings', '--test', join(root, 'tests/partner-module.test.js')],
    { encoding: 'utf8', cwd: root },
  );
  assert.equal(generatedTest.status, 0, generatedTest.stdout + generatedTest.stderr);

  // Regeneration in a second clean copy is byte-identical.
  const root2 = createProjectCopy(t);
  const apply2 = runCli(root2, ['module', 'create', join(root2, 'examples/modules/partner.module.json'), '--apply']);
  assert.equal(apply2.status, 0, apply2.stderr);
  for (const [path] of filesA) {
    assert.equal(
      readFileSync(join(root2, path), 'utf8'),
      readFileSync(join(root, path), 'utf8'),
      `${path} differs between independent generations`,
    );
  }
});
