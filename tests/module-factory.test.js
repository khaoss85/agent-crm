import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planModule, applyModulePlan } from '../packages/cli/src/module-factory.js';

const partnerManifest = JSON.parse(
  readFileSync(new URL('../examples/modules/partner.module.json', import.meta.url), 'utf8'),
);

function tempRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-crm-factory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('module plans are deterministic and read-only', (t) => {
  const root = tempRoot(t);
  const first = planModule({ manifest: partnerManifest, rootDir: root });
  const second = planModule({ manifest: partnerManifest, rootDir: root });
  assert.deepEqual(
    first.files.map((file) => [file.path, file.contentSha256]),
    second.files.map((file) => [file.path, file.contentSha256]),
  );
  assert.equal(first.module, 'partner');
  assert.equal(first.migrationName, 'create_partners');
  // Read-only: nothing was written anywhere under the root.
  assert.equal(existsSync(join(root, 'packages')), false);
  assert.equal(existsSync(join(root, 'tests')), false);
  // Generated content carries no machine-specific absolute paths.
  for (const file of first.files) {
    assert.ok(!file.content.includes(root), `${file.path} embeds the temp root path`);
    assert.ok(!file.content.includes('\r'), `${file.path} has non-\\n line endings`);
  }
});

test('apply writes the planned files and a registry that lists modules sorted', (t) => {
  const root = tempRoot(t);
  const plan = planModule({ manifest: partnerManifest, rootDir: root });
  const applied = applyModulePlan(plan);
  assert.equal(applied.module, 'partner');
  for (const file of plan.files) {
    assert.ok(existsSync(join(root, file.path)), `${file.path} missing after apply`);
    assert.equal(readFileSync(join(root, file.path), 'utf8'), file.content);
  }

  const zebra = planModule({
    manifest: { name: 'zebra', fields: [{ name: 'name', type: 'string', required: true }] },
    rootDir: root,
  });
  applyModulePlan(zebra);
  const registry = readFileSync(join(root, 'packages/modules/generated/index.js'), 'utf8');
  assert.match(registry, /createPartnerModule[\s\S]*createZebraModule/);
  assert.match(registry, /name: 'partner'[\s\S]*name: 'zebra'/);

  // Re-applying the same module is refused, never silently overwritten.
  assert.throws(() => applyModulePlan(planModule({ manifest: partnerManifest, rootDir: root })), /refusing to overwrite/i);
});

test('reference fields are rejected by module create with a clear message', (t) => {
  const root = tempRoot(t);
  assert.throws(
    () =>
      planModule({
        rootDir: root,
        manifest: {
          name: 'deal',
          fields: [{ name: 'companyId', type: 'reference', references: 'companies', required: true }],
        },
      }),
    /does not support reference fields yet.*"companyId"/s,
  );
});

test('a failed apply leaves no partial changes and restores the registry', (t) => {
  const root = tempRoot(t);
  // Pre-create an existing registry with recognizable content.
  mkdirSync(join(root, 'packages/modules/generated'), { recursive: true });
  const originalRegistry = '// original registry sentinel\nexport const generatedModules = [];\n';
  writeFileSync(join(root, 'packages/modules/generated/index.js'), originalRegistry);
  // Make the tests/ path a FILE so staging the generated test file fails mid-apply.
  writeFileSync(join(root, 'tests'), 'not a directory');

  const plan = planModule({ manifest: partnerManifest, rootDir: root });
  assert.throws(() => applyModulePlan(plan));
  assert.equal(existsSync(join(root, 'packages/modules/partner')), false, 'partial module dir left behind');
  assert.equal(readFileSync(join(root, 'packages/modules/generated/index.js'), 'utf8'), originalRegistry);
});

test('collisions with core modules, reserved names and core tables are rejected at plan time', (t) => {
  const root = tempRoot(t);
  // Simulate a handwritten (core-style) module: a directory without module.manifest.json.
  mkdirSync(join(root, 'packages/modules/company/src'), { recursive: true });
  assert.throws(
    () => planModule({ manifest: { name: 'company', fields: [{ name: 'label', type: 'string' }] }, rootDir: root }),
    /non-generated module named "company" already exists/,
  );
  assert.throws(
    () => planModule({ manifest: { name: 'generated', fields: [{ name: 'label', type: 'string' }] }, rootDir: root }),
    /"generated" is reserved/,
  );
  // "audit-event" pluralizes to the core audit_events table.
  assert.throws(
    () => planModule({ manifest: { name: 'audit-event', fields: [{ name: 'label', type: 'string' }] }, rootDir: root }),
    /Table "audit_events" is a core framework table/,
  );
});

test('table collisions between generated modules are rejected', (t) => {
  const root = tempRoot(t);
  applyModulePlan(planModule({ manifest: partnerManifest, rootDir: root }));
  assert.throws(
    () =>
      planModule({
        manifest: { name: 'reseller', table: 'partners', fields: [{ name: 'label', type: 'string' }] },
        rootDir: root,
      }),
    /Table "partners" is already used by generated module "partner"/,
  );
});

test('a malformed pre-existing generated module fails the scan loudly', (t) => {
  const root = tempRoot(t);
  mkdirSync(join(root, 'packages/modules/broken'), { recursive: true });
  writeFileSync(join(root, 'packages/modules/broken/module.manifest.json'), '{ not json');
  assert.throws(
    () => planModule({ manifest: partnerManifest, rootDir: root }),
    /Existing generated module "broken" has an invalid module.manifest.json/,
  );
});

test('registry content is identical regardless of module creation order', (t) => {
  const zebraManifest = { name: 'zebra', fields: [{ name: 'name', type: 'string', required: true }] };
  const forward = tempRoot(t);
  applyModulePlan(planModule({ manifest: partnerManifest, rootDir: forward }));
  applyModulePlan(planModule({ manifest: zebraManifest, rootDir: forward }));
  const reverse = tempRoot(t);
  applyModulePlan(planModule({ manifest: zebraManifest, rootDir: reverse }));
  applyModulePlan(planModule({ manifest: partnerManifest, rootDir: reverse }));
  assert.equal(
    readFileSync(join(forward, 'packages/modules/generated/index.js'), 'utf8'),
    readFileSync(join(reverse, 'packages/modules/generated/index.js'), 'utf8'),
  );
});

test('hostile manifest strings cannot inject code into generated source', (t) => {
  const root = tempRoot(t);
  const hostile = {
    name: 'hostile',
    description: 'desc with `backtick` and ${process.exit(1)} and\nnewline */ <script>',
    fields: [
      {
        name: 'status',
        type: 'enum',
        values: ['ok', 'x` + (()=>{ globalThis.INJECTED = true; return 1; })() + `y', "quote'and\\slash\\"],
      },
    ],
  };
  const first = planModule({ manifest: hostile, rootDir: root });
  const second = planModule({ manifest: hostile, rootDir: root });
  assert.deepEqual(
    first.files.map((file) => file.contentSha256),
    second.files.map((file) => file.contentSha256),
  );
  applyModulePlan(first);
  for (const file of first.files) {
    if (!file.path.endsWith('.js')) continue;
    const check = spawnSync(process.execPath, ['--check', join(root, file.path)], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${file.path}: ${check.stderr}`);
  }
  // Loading the generated migration in a subprocess must not execute injected
  // code; the hostile value must survive as SQL data.
  const migrationUrl = pathToFileURL(join(root, 'packages/modules/hostile/src/migration.js')).href;
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { hostileMigration } from ${JSON.stringify(migrationUrl)};
       if (globalThis.INJECTED) { console.error('INJECTED'); process.exit(2); }
       if (!hostileMigration.sql.includes('globalThis.INJECTED = true')) process.exit(3);
       if (!/CREATE TABLE IF NOT EXISTS hostiles/.test(hostileMigration.sql)) process.exit(4);`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(probe.status, 0, `injection probe failed (${probe.status}): ${probe.stderr}`);
});

test('module names cannot traverse outside the project root', (t) => {
  const root = tempRoot(t);
  // The manifest name pattern already forbids path separators; prove it here.
  assert.throws(
    () => planModule({ manifest: { name: '../escape', fields: [{ name: 'x', type: 'string' }] }, rootDir: root }),
    /name is required and must match/,
  );
});
