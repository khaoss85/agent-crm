import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('module names cannot traverse outside the project root', (t) => {
  const root = tempRoot(t);
  // The manifest name pattern already forbids path separators; prove it here.
  assert.throws(
    () => planModule({ manifest: { name: '../escape', fields: [{ name: 'x', type: 'string' }] }, rootDir: root }),
    /name is required and must match/,
  );
});
