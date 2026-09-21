import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateModuleMigration, validateModuleManifest } from '../packages/core/src/module-manifest.js';
import {
  LEGACY_MODULE_STATE_REQUIRED,
  MODULE_POSTGRES_BOOTSTRAP_MISMATCH,
  MODULE_STATE_VERSION,
  POSTGRES_BOOTSTRAP_TARGET_NONEMPTY,
  adoptLegacyModuleState,
  assertPostgresBootstrapMatchesManifest,
  assertPostgresBootstrapTargetEmpty,
  generatePostgresModuleBootstrap,
  moduleStateFingerprint,
  readModuleState,
  requireAdoptedModuleStateForPostgres,
} from '../packages/core/src/module-evolution.js';
import { planModule, applyModulePlan } from '../packages/cli/src/module-factory.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureDir = join(repoRoot, 'tests/fixtures/spine-v2-m3a-prestate-gadget');

function workspaceFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m3a-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('pre-state registry adoption is deterministic and preserves SQLite bytes', () => {
  const first = adoptLegacyModuleState(fixtureDir, 'gadget');
  const second = adoptLegacyModuleState(fixtureDir, 'gadget');
  assert.equal(first.adopted, true);
  assert.equal(first.stateVersion, MODULE_STATE_VERSION);
  assert.deepEqual(first.document, second.document);
  assert.equal(first.migrations.length, 1);
  assert.equal(first.migrations[0].migrationName, 'create_gadgets');

  const create = generateModuleMigration(JSON.parse(readFileSync(join(fixtureDir, 'module.manifest.json'), 'utf8')));
  assert.equal(first.migrations[0].sql, create.sql);
  assert.equal(first.document.migrations[0].sql, create.sql);
  assert.equal(first.document.migrations[0].checksum, sha256(create.sql));
  assert.equal(first.document.stateVersion, 2);
  assert.equal(first.document.postgres.bootstrap.provenance.kind, 'v1-state-fingerprint');
  assert.equal(first.document.postgres.bootstrap.provenance.fingerprint, first.fingerprint);
});

test('adopted SQLite schema matches the generated create migration', () => {
  const adopted = adoptLegacyModuleState(fixtureDir, 'gadget');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(adopted.migrations[0].sql);
    const columns = database.prepare('PRAGMA table_info(gadgets)').all().map((row) => row.name);
    assert.deepEqual(columns, ['id', 'label', 'value_cents', 'active', 'created_at', 'updated_at']);
    const types = Object.fromEntries(
      database.prepare('PRAGMA table_info(gadgets)').all().map((row) => [row.name, row.type]),
    );
    assert.equal(types.value_cents, 'INTEGER');
    assert.equal(types.active, 'INTEGER');
  } finally {
    database.close();
  }
});

test('PostgreSQL bootstrap equals the current manifest schema and uses BIGINT', () => {
  const adopted = adoptLegacyModuleState(fixtureDir, 'gadget');
  const expected = generatePostgresModuleBootstrap(adopted.manifest);
  assert.equal(adopted.postgres.bootstrap.sql, expected.sql);
  assert.match(expected.sql, /"value_cents" BIGINT NOT NULL/);
  assert.match(expected.sql, /"active" BOOLEAN/);
  assert.match(expected.sql, /"created_at" TIMESTAMPTZ NOT NULL/);
  assertPostgresBootstrapMatchesManifest({
    manifest: adopted.manifest,
    postgres: adopted.postgres,
  });
});

test('runtime refuses LEGACY_MODULE_STATE_REQUIRED until adoption is checked in', () => {
  assert.throws(
    () => requireAdoptedModuleStateForPostgres({
      moduleName: 'gadget',
      stateFileExists: false,
    }),
    (error) => error.code === LEGACY_MODULE_STATE_REQUIRED
      && error.details.module === 'gadget'
      && !JSON.stringify(error).includes(fixtureDir)
      && !/postgresql:\/\//i.test(JSON.stringify(error)),
  );
});

test('v1 module.state.json remains readable and does not invent a postgres bootstrap at runtime', (t) => {
  const root = workspaceFor(t);
  const moduleDir = join(root, 'packages/modules/widget');
  mkdirSync(moduleDir, { recursive: true });
  const manifest = validateModuleManifest({
    manifestVersion: 1,
    name: 'widget',
    fields: [{ name: 'label', type: 'string', required: true }],
  });
  const create = generateModuleMigration(manifest);
  writeFileSync(join(moduleDir, 'module.state.json'), `${JSON.stringify({
    stateVersion: 1,
    module: 'widget',
    revision: 1,
    fingerprint: moduleStateFingerprint(manifest),
    manifest,
    migrations: [{ name: create.migrationName, checksum: sha256(create.sql), sql: create.sql }],
  }, null, 2)}\n`);

  const state = readModuleState(root, 'widget');
  assert.equal(state.stateVersion, 1);
  assert.equal(state.postgres, null);
  assert.equal(state.migrations[0].sql, create.sql);
  assert.throws(
    () => requireAdoptedModuleStateForPostgres({
      moduleName: 'widget',
      stateFileExists: true,
      state,
    }),
    (error) => error.code === 'MODULE_POSTGRES_BOOTSTRAP_REQUIRED'
      && !JSON.stringify(error).includes(root),
  );
});

test('factory apply writes additive v2 state with a postgres bootstrap', (t) => {
  const root = workspaceFor(t);
  for (const entry of ['packages', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  applyModulePlan(planModule({
    manifest: {
      manifestVersion: 1,
      name: 'note',
      fields: [{ name: 'body', type: 'string', required: true }],
    },
    rootDir: root,
  }));
  const state = JSON.parse(readFileSync(join(root, 'packages/modules/note/module.state.json'), 'utf8'));
  assert.equal(state.stateVersion, 2);
  assert.equal(state.migrations.length, 1);
  assert.match(state.postgres.bootstrap.sql, /CREATE TABLE "accordo"\."notes"/);
  assert.match(state.postgres.bootstrap.sql, /"created_at" TIMESTAMPTZ NOT NULL/);
  const read = readModuleState(root, 'note');
  assert.equal(read.stateVersion, 2);
  requireAdoptedModuleStateForPostgres({
    moduleName: 'note',
    stateFileExists: true,
    state: read,
  });
});

test('non-empty PostgreSQL target and unreproducible bootstrap refuse closed', () => {
  const adopted = adoptLegacyModuleState(fixtureDir, 'gadget');
  assert.throws(
    () => assertPostgresBootstrapTargetEmpty({ tableNames: ['gadgets'] }),
    (error) => error.code === POSTGRES_BOOTSTRAP_TARGET_NONEMPTY
      && !JSON.stringify(error).includes('postgresql://'),
  );
  assert.doesNotThrow(() => assertPostgresBootstrapTargetEmpty({ tableNames: ['schema_migrations'] }));
  assert.throws(
    () => assertPostgresBootstrapMatchesManifest({
      manifest: adopted.manifest,
      postgres: { bootstrap: { ...adopted.postgres.bootstrap, sql: 'CREATE TABLE no()' } },
    }),
    (error) => error.code === MODULE_POSTGRES_BOOTSTRAP_MISMATCH,
  );
});
