import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const supplierManifest = {
  manifestVersion: 1,
  name: 'supplier',
  description: 'Suppliers with a unique code.',
  fields: [
    { name: 'name', type: 'string', required: true },
    { name: 'code', type: 'string', required: true, unique: true },
    { name: 'active', type: 'boolean' },
    { name: 'seats', type: 'integer' },
  ],
};

function createProjectCopy(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, 'examples/modules/supplier.module.json'), `${JSON.stringify(supplierManifest, null, 2)}\n`);
  return root;
}

function runCli(root, args) {
  return spawnSync(
    process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root },
  );
}

test('end-to-end: manifests → plan → apply → runnable Partner and Supplier modules', async (t) => {
  const root = createProjectCopy(t);
  const partnerPath = join(root, 'examples/modules/partner.module.json');
  const supplierPath = join(root, 'examples/modules/supplier.module.json');

  // 1. Validation, including a manifest path containing spaces.
  assert.equal(runCli(root, ['module', 'validate', partnerPath]).status, 0);
  mkdirSync(join(root, 'with space'), { recursive: true });
  const spacedPath = join(root, 'with space', 'partner.module.json');
  cpSync(partnerPath, spacedPath);
  const spaced = runCli(root, ['module', 'plan', spacedPath]);
  assert.equal(spaced.status, 0, spaced.stderr);
  assert.equal(JSON.parse(spaced.stdout).module, 'partner');

  // 2. Deterministic plan: two runs report identical file hashes.
  const planA = runCli(root, ['module', 'plan', partnerPath]);
  const planB = runCli(root, ['module', 'plan', partnerPath, '--json']);
  assert.equal(planA.status, 0, planA.stderr);
  const filesA = JSON.parse(planA.stdout).files.map((f) => [f.path, f.contentSha256]);
  const filesB = JSON.parse(planB.stdout).files.map((f) => [f.path, f.contentSha256]);
  assert.deepEqual(filesA, filesB);

  // 3. Dry-run equals the plan and writes nothing; explicit --dry-run beats --apply.
  const dryRun = runCli(root, ['module', 'create', partnerPath]);
  assert.equal(JSON.parse(dryRun.stdout).mode, 'dry-run');
  assert.deepEqual(JSON.parse(dryRun.stdout).files.map((f) => [f.path, f.contentSha256]), filesA);
  const dryRunWins = runCli(root, ['module', 'create', partnerPath, '--apply', '--dry-run']);
  assert.equal(JSON.parse(dryRunWins.stdout).mode, 'dry-run');
  assert.equal(existsSync(join(root, 'packages/modules/partner')), false);

  // 4. Explicit apply for both modules; re-apply refused; no manual registry or migration edits anywhere.
  assert.equal(runCli(root, ['module', 'create', partnerPath, '--apply']).status, 0);
  assert.equal(runCli(root, ['module', 'create', supplierPath, '--apply']).status, 0);
  const reapply = runCli(root, ['module', 'create', partnerPath, '--apply']);
  assert.equal(reapply.status, 1);
  assert.match(reapply.stderr, /refusing to overwrite/i);
  const registry = readFileSync(join(root, 'packages/modules/generated/index.js'), 'utf8');
  assert.match(registry, /name: 'partner'[\s\S]*name: 'supplier'/);

  // 5-13. Boot the temp copy's app once: migrations, registration, CRUD.
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());

  const moduleNames = app.modules.list().map((module) => module.name);
  assert.ok(moduleNames.includes('partner') && moduleNames.includes('supplier'), `got: ${moduleNames}`);

  const emitted = [];
  for (const event of ['partner.created', 'partner.updated', 'supplier.created', 'supplier.updated']) {
    app.events.subscribe(event, () => emitted.push(event));
  }
  const actor = { type: 'human', id: 'e2e' };

  const partners = app.modules.get('partner').service;
  const created = await partners.create({ name: 'Acme Partners', tier: 'gold' }, { actor });
  assert.equal(partners.get(created.id).tier, 'gold');
  assert.equal(partners.list().length, 1);
  assert.equal(partners.list({ limit: 'nonsense' }).length, 1);
  const updated = await partners.update(created.id, { tier: 'platinum', territory: 'EMEA' }, { actor });
  assert.equal(updated.tier, 'platinum');
  assert.equal(updated.territory, 'EMEA');

  const suppliers = app.modules.get('supplier').service;
  const supplier = await suppliers.create({ name: 'Bolts SpA', code: 'BOLT', active: true, seats: 5 }, { actor });
  assert.equal(suppliers.get(supplier.id).active, true);

  // 14-15. Audit records and domain events for successful mutations.
  assert.deepEqual(emitted, ['partner.created', 'partner.updated', 'supplier.created']);
  const partnerAudit = app.audit.list({ entityType: 'partner' }).map((event) => event.action).sort();
  assert.deepEqual(partnerAudit, ['partner.created', 'partner.updated']);

  // Failed mutations produce neither audit records nor domain events.
  const auditCountBefore = app.audit.list({ entityType: 'supplier' }).length;
  const emittedBefore = emitted.length;
  await assert.rejects(
    () => suppliers.create({ name: 'Dup', code: 'BOLT' }, { actor }),
    /already exists|unique/i,
  );
  await assert.rejects(() => partners.create({ name: 'X', tier: 'diamond' }, { actor }), /tier/);
  await assert.rejects(() => partners.create({}, { actor }), /name/);
  await assert.rejects(() => suppliers.update(supplier.id, { active: 'yes' }, { actor }), /active/);
  assert.equal(app.audit.list({ entityType: 'supplier' }).length, auditCountBefore);
  assert.equal(emitted.length, emittedBefore);
  assert.equal(suppliers.list().length, 1);

  // 16. Second identical apply already proven refused above (safe, documented).

  // 17. The generated test suites pass inside the temp project.
  for (const generatedTest of ['tests/partner-module.test.js', 'tests/supplier-module.test.js']) {
    const run = spawnSync(process.execPath, ['--no-warnings', '--test', join(root, generatedTest)], {
      encoding: 'utf8',
      cwd: root,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  }

  // Independent regeneration is byte-identical (framework determinism).
  const root2 = createProjectCopy(t);
  assert.equal(
    runCli(root2, ['module', 'create', join(root2, 'examples/modules/partner.module.json'), '--apply']).status,
    0,
  );
  for (const [path] of filesA) {
    if (path === 'packages/modules/generated/index.js') continue; // differs: root has supplier too
    assert.equal(
      readFileSync(join(root2, path), 'utf8'),
      readFileSync(join(root, path), 'utf8'),
      `${path} differs between independent generations`,
    );
  }
});
