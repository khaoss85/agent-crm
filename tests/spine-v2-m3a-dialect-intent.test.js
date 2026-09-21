import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CORE_MIGRATIONS_FOR_CHARACTERIZATION } from '../packages/core/src/database.js';
import {
  CORE_SCHEMA_INTENT,
  renderCorePostgresSql,
  renderCoreSqliteSql,
} from '../packages/core/src/core-schema-intent.js';
import { PINNED_CORE_MIGRATION_CHECKSUMS } from '../packages/core/src/schema-migrations-ledger.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('SQLite intent render is byte-identical to released core migration SQL', () => {
  for (const intent of CORE_SCHEMA_INTENT) {
    const released = CORE_MIGRATIONS_FOR_CHARACTERIZATION.find((entry) => entry.version === intent.version);
    assert.ok(released, `released migration v${intent.version} exists`);
    assert.equal(released.name, intent.name);
    assert.equal(renderCoreSqliteSql(intent), released.sql);
    const checksum = sha256(released.sql);
    if (intent.version < 8) {
      assert.equal(checksum, PINNED_CORE_MIGRATION_CHECKSUMS[`${intent.version}:${intent.name}`]);
    }
  }
});

test('released v1–v7 SQLite checksums are unchanged against current source', () => {
  const released = CORE_MIGRATIONS_FOR_CHARACTERIZATION
    .filter(({ version }) => version <= 7)
    .map(({ plane, version, name, sql }) => ({
      plane, version, name, checksum: sha256(sql),
    }));
  assert.deepEqual(released, [
    { plane: 'data', version: 1, name: 'initial_crm_schema', checksum: '2d386db73f44bc6da6e76942ba8dba2ee37d6799e5442e9c894d035848a2555e' },
    { plane: 'data', version: 2, name: 'opportunity_source_key', checksum: 'deed722482124ab96deb2f884ab4e0fb9308318f9411cc8b67e1bf5552d0093a' },
    { plane: 'data', version: 3, name: 'opportunity_pipeline_state', checksum: 'fccd2e6dd49aa73245b301b08bfc7f4dc167e7154a24cd5c56fcb66e444a8c6b' },
    { plane: 'data', version: 4, name: 'definition_versions', checksum: 'f2b4daf5f0dbee756ae2b04087c28c0debafcfe474fb78f976ac1dfdfde744a8' },
    { plane: 'control', version: 5, name: 'production_spine_identity', checksum: 'dd5ab2cc2a946e2f573bd1536952e18974c19a776b71074f4335602a47cc04fc' },
    { plane: 'data', version: 6, name: 'spine_data_plane_binding_marker', checksum: 'c0b4e2e7b0bfc7dcd7427c21d11db4ef8d879a1612650667fcffda0912e92d53' },
    { plane: 'control', version: 7, name: 'spine_cross_plane_audit_intents', checksum: '399b3f4aa70dd8aeea00a0d37bef21f952e3b32f84828ed1f6c13721b741c94b' },
  ]);
});

test('PostgreSQL intent renders BIGINT for cents and integer columns, not translated SQLite', () => {
  const v1 = CORE_SCHEMA_INTENT.find((intent) => intent.version === 1);
  const { sql, names } = renderCorePostgresSql(v1);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS "accordo"/);
  assert.match(sql, /"value_cents" BIGINT NOT NULL CHECK\("value_cents" >= 0\)/);
  assert.doesNotMatch(sql, /value_cents INTEGER/);
  assert.match(sql, /"created_at" TIMESTAMPTZ NOT NULL/);
  assert.match(sql, /CREATE TABLE "accordo"\."companies"/);
  assert.equal(names.find((entry) => entry.logical === 'companies')?.mapped, false);

  const v4 = CORE_SCHEMA_INTENT.find((intent) => intent.version === 4);
  const pg4 = renderCorePostgresSql(v4).sql;
  assert.match(pg4, /"version" BIGINT NOT NULL/);

  const v7 = CORE_SCHEMA_INTENT.find((intent) => intent.version === 7);
  const pg7 = renderCorePostgresSql(v7).sql;
  assert.match(pg7, /"audit_revision" BIGINT NOT NULL DEFAULT 0/);
  assert.match(pg7, /"mutation_revision" BIGINT NOT NULL/);
});

test('dialect intent does not parse or translate SQLite SQL strings at runtime', () => {
  const dialect = readFileSync(join(root, 'packages/core/src/dialect-sql.js'), 'utf8');
  const intent = readFileSync(join(root, 'packages/core/src/core-schema-intent.js'), 'utf8');
  const combined = `${dialect}\n${intent}`;
  assert.doesNotMatch(combined, /CREATE TABLE IF NOT EXISTS companies/);
  assert.doesNotMatch(combined, /\.replace\(.*INTEGER.*BIGINT/);
  assert.doesNotMatch(combined, /translateSqlite|sqliteToPostgres|parseSql/i);
});
